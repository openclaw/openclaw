// A yielded parent's resumed turn may deliver its own final. A `/new` reset that
// lands after the model finished must still stop that final at the adapter
// boundary, and the queued intent must not reach the reset conversation later.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainPendingDeliveriesCore } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { createRecoveryLog } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  beginSessionWorkAdmission,
  interruptSessionWorkAdmissions,
} from "../../sessions/session-lifecycle-admission.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
} from "../run-termination.js";
import { deliverAgentCommandResult } from "./delivery.js";

afterEach(() => {
  resetPluginRuntimeStateForTest();
});

describe("yielded settle final after requester reset", () => {
  it.each([false, true])("reset=%s", async (reset) => {
    await withAdminIngress(async ({ state, cfg }) => {
      const key = "agent:main:matrix:direct:owner";
      const target = {
        agentId: "main",
        sessionKey: key,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      const entry = {
        sessionId: "parent-session",
        lifecycleRevision: "before-reset",
        updatedAt: Date.now(),
      };
      await replaceSessionEntry(target, entry);
      // Mirrors the settled runner: finals carry the writer incarnation they were produced for.
      const final = setReplyPayloadMetadata(
        { text: "Uptime: 14 days" },
        {
          sessionWriterDeliveryAuthority: {
            agentId: "main",
            sessionKey: key,
            storePath: target.storePath,
            expectedSessionId: entry.sessionId,
            expectedLifecycleRevision: entry.lifecycleRevision,
          },
        },
      );
      const payloads = [final];
      const marker = await persistPendingFinalDeliveryMarker({
        agentId: target.agentId,
        deliver: true,
        sessionStore: { [key]: entry },
        sessionKey: key,
        sessionEntry: entry,
        storePath: target.storePath,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: { channel: "matrix", to: "!owner:example", accountId: "default" },
        runOwnedSessionId: entry.sessionId,
      });
      expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);

      const entered = createDeferred();
      const release = createDeferred();
      const writes: string[] = [];
      let hold = true;
      const plugin: ChannelPlugin = {
        ...createOutboundTestPlugin({
          id: "matrix",
          outbound: {
            deliveryMode: "direct",
            sendText: async () => {
              throw new Error("message adapter must own the send");
            },
          },
        }),
        message: {
          id: "matrix",
          durableFinal: { capabilities: { text: true } },
          send: {
            text: async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
              if (hold) {
                entered.resolve();
                await release.promise;
              }
              await onPlatformSendDispatch?.();
              assertDirectAdapterHandoff?.();
              writes.push(text);
              return {
                messageId: "recorded-final",
                receipt: createMessageReceiptFromOutboundResults({
                  results: [{ channel: "matrix", messageId: "recorded-final" }],
                  kind: "text",
                }),
              };
            },
          },
        },
      };
      setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));

      // Same admission wiring as agentCommand: a reset interrupts the run's signal,
      // and post-run delivery checks that signal before provider I/O.
      const controller = new AbortController();
      const admission = await beginSessionWorkAdmission({
        scope: target.storePath,
        identities: [key, entry.sessionId],
        assertAllowed: () => {},
        onInterrupt: (reason) =>
          controller.abort(
            isAgentRunDirectAbortReason(reason) ? reason : createAgentRunRestartAbortError(),
          ),
      });
      const delivery = admission
        .run(() =>
          deliverAgentCommandResult({
            cfg,
            deps: {},
            runtime: { log: () => {}, error: () => {}, exit: () => {} },
            opts: {
              message: "settled children",
              abortSignal: controller.signal,
              deliver: true,
              replyChannel: "matrix",
              replyTo: "!owner:example",
              accountId: "default",
              sessionKey: key,
              runId: "announce:requester-settle:owner:yield-1",
            },
            outboundSession: { agentId: "main", key },
            sessionEntry: marker.sessionEntry,
            result: { meta: { durationMs: 1 } },
            payloads,
            assertDeliveryCurrent: () => controller.signal.throwIfAborted(),
          }),
        )
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        )
        .finally(() => admission.release());
      await entered.promise;

      if (reset) {
        // `/new` drains admitted work, then keeps the session id and rotates its revision.
        const drained = interruptSessionWorkAdmissions({
          scope: target.storePath,
          identities: [key, entry.sessionId],
        });
        release.resolve();
        expect((await delivery).ok).toBe(false);
        expect(await drained).toBe(true);
        await replaceSessionEntry(target, { ...entry, lifecycleRevision: "after-reset" });
      } else {
        release.resolve();
        expect((await delivery).ok).toBe(true);
      }
      expect(writes).toEqual(reset ? [] : ["Uptime: 14 days"]);

      // A later queue drain must not resend the old final into the reset session.
      hold = false;
      await drainPendingDeliveriesCore({
        drainKey: "matrix:settle-reset",
        logLabel: "Settle reset",
        cfg,
        log: createRecoveryLog(),
        stateDir: state.stateDir,
        deliver: deliverOutboundPayloads,
        selectEntry: () => ({ match: true, bypassBackoff: true }),
      });
      expect(writes).toEqual(reset ? [] : ["Uptime: 14 days"]);
      expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
    });
  });
});
