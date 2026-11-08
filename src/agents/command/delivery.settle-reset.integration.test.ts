import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { loadUnfinishedDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  beginSessionEffect,
  interruptSessionControllerEffects,
} from "../../sessions/session-controller.lifecycle.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  createAgentRunRestartAbortError,
  isAgentRunDirectAbortReason,
} from "../run-termination.js";
import {
  deliverFinal,
  matrixPlugin,
  persistMarker,
  recoveryFor,
  textReceipt,
} from "./delivery.test-support.js";

afterEach(resetPluginRuntimeStateForTest);

it.each([false, true])("yielded settle final after requester reset=%s", async (reset) => {
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
    const payloads = [
      setReplyPayloadMetadata(
        { text: "Uptime: 14 days" },
        {
          sessionWriterDeliveryAuthority: {
            ...target,
            expectedSessionId: entry.sessionId,
            expectedLifecycleRevision: entry.lifecycleRevision,
          },
        },
      ),
    ];
    const marker = await persistMarker(target, entry, payloads);
    expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);

    const entered = createDeferred();
    const release = createDeferred();
    const writes: string[] = [];
    let hold = true;
    const plugin = matrixPlugin(
      async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
        if (hold) {
          entered.resolve();
          await release.promise;
        }
        await onPlatformSendDispatch?.();
        assertDirectAdapterHandoff?.();
        writes.push(text);
        return textReceipt("recorded-final");
      },
    );
    setActivePluginRegistry(createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]));

    const controller = new AbortController();
    const admission = await beginSessionEffect({
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
        deliverFinal(target, {
          cfg,
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
          sessionEntry: marker.sessionEntry,
          result: { meta: { durationMs: 1 } },
          payloads,
          assertDeliveryCurrent: () => controller.signal.throwIfAborted(),
        }),
      )
      .then(
        () => true,
        () => false,
      )
      .finally(() => admission.release());
    await entered.promise;

    const drained = reset
      ? interruptSessionControllerEffects({
          scope: target.storePath,
          identities: [key, entry.sessionId],
        })
      : undefined;
    release.resolve();
    expect(await delivery).toBe(!reset);
    if (reset) {
      expect(await drained).toBe(true);
      await replaceSessionEntry(target, { ...entry, lifecycleRevision: "after-reset" });
    }
    expect(writes).toEqual(reset ? [] : ["Uptime: 14 days"]);

    // A later queue drain must not resend the old final into the reset session.
    hold = false;
    await recoveryFor(cfg, state.stateDir, "matrix:settle-reset")();
    expect(writes).toEqual(reset ? [] : ["Uptime: 14 days"]);
    expect(await loadUnfinishedDeliveries(state.stateDir)).toEqual([]);
  });
});
