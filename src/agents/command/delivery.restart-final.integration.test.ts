import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import {
  SessionWorkStartChangedError,
  SessionWorkStartInvalidatedError,
} from "../../config/sessions/lifecycle.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainMatrixReconnect } from "../../infra/outbound/deliver.queue-integration.test-support.js";
import { loadPendingDeliveries } from "../../infra/outbound/delivery-queue.test-helpers.js";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { deliverAgentCommandResult } from "./delivery.js";

const privatePaths = vi.hoisted(() => ({ root: undefined as string | undefined }));
vi.mock("../../infra/tmp-openclaw-dir.js", () => ({
  DEFAULT_POSIX_TMP_ROOT: "/tmp/openclaw",
  resolvePreferredOpenClawTmpDir: () => {
    if (!privatePaths.root) {
      throw new Error("Private restart-final handoff root is not installed");
    }
    return privatePaths.root;
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  const root = fs.realpathSync(tempDirs.make("openclaw-restart-final-"));
  privatePaths.root = root;
  const databasePath = resolveManagedUpdateLeaseDatabasePath();
  expect(databasePath).toBe(path.join(root, "managed-update-handoffs.sqlite"));
  // Check the physical parent before any executor/config write can open the store.
  expect(fs.realpathSync(path.dirname(databasePath))).toBe(root);
});
afterEach(() => {
  resetPluginRuntimeStateForTest();
  privatePaths.root = undefined;
});

it.each(["restart", "revoked", "replaced"] as const)(
  "fences old final delivery during %s and leaves only valid recovery custody",
  async (boundary) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      // Confirm every database selector before the first session/queue write.
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      const databasePaths: [string, string][] = [
        [resolveOpenClawStateSqlitePath(), state.statePath("state", "openclaw.sqlite")],
        [
          resolveOpenClawAgentSqlitePath({ agentId: "main" }),
          path.join(state.agentDir(), "openclaw-agent.sqlite"),
        ],
      ];
      for (const [databasePath, expectedPath] of databasePaths) {
        expect(databasePath).toBe(expectedPath);
        fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
        expect(fs.realpathSync(path.dirname(databasePath))).toBe(path.dirname(expectedPath));
      }
      const sessionKey = "agent:main:matrix:direct:restart-final";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const target = { sessionKey, storePath };
      const entry = {
        sessionId: "restart-final",
        status: "running" as const,
        updatedAt: Date.now(),
      };
      await replaceSessionEntry(target, entry);
      const payloads = [{ text: "Captured final answer" }, { text: "Final detail" }];
      const marker = await persistPendingFinalDeliveryMarker({
        agentId: "main",
        deliver: true,
        sessionStore: { [sessionKey]: entry },
        sessionKey,
        sessionEntry: entry,
        storePath,
        suppressVisibleSessionEffects: false,
        sessionReboundDuringRun: false,
        payloads,
        deliveryContext: { channel: "matrix", to: "!restart:example" },
        runOwnedSessionId: entry.sessionId,
      });
      expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
      const entered = createDeferred();
      const release = createDeferred();
      const writes: string[] = [];
      let held = true;
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "matrix",
            source: "test",
            plugin: {
              ...createOutboundTestPlugin({
                id: "matrix",
                outbound: {
                  deliveryMode: "direct",
                  sendText: async () => {
                    throw new Error("message adapter owns send");
                  },
                },
              }),
              message: {
                id: "matrix",
                durableFinal: { capabilities: { text: true } },
                send: {
                  lifecycle: {
                    beforeSendAttempt: async () => {
                      if (held) {
                        entered.resolve();
                        await release.promise;
                      }
                    },
                  },
                  text: async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
                    await onPlatformSendDispatch?.();
                    assertDirectAdapterHandoff?.();
                    writes.push(text);
                    const messageId = `delivered-final-${writes.length}`;
                    return {
                      messageId,
                      receipt: createMessageReceiptFromOutboundResults({
                        results: [{ channel: "matrix", messageId }],
                        kind: "text",
                      }),
                    };
                  },
                },
              },
            },
          },
        ]),
      );
      const controller = new AbortController();
      let custodyError: Error | undefined;
      const delivery = deliverAgentCommandResult({
        cfg: {},
        deps: {},
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
        opts: {
          message: "continue",
          deliver: true,
          bestEffortDeliver: true,
          replyChannel: "matrix",
          replyTo: "!restart:example",
          sessionKey,
          runId: "recovery-run",
          abortSignal: controller.signal,
        },
        outboundSession: { agentId: "main", key: sessionKey },
        sessionEntry: marker.sessionEntry,
        result: { meta: { durationMs: 1 } },
        payloads,
        assertDeliveryCurrent: () => {
          if (custodyError) {
            throw custodyError;
          }
          controller.signal.throwIfAborted();
        },
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      try {
        await Promise.race([
          entered.promise,
          delivery.then(() => {
            throw new Error("sender settled before preparation");
          }),
        ]);
        const captured = loadSessionEntry(target)!;
        await replaceSessionEntry(target, { ...captured, abortedLastRun: true });
        if (boundary === "restart") {
          controller.abort(createAgentRunRestartAbortError());
        } else {
          custodyError =
            boundary === "revoked"
              ? new SessionWorkStartInvalidatedError("Task custody revoked")
              : new SessionWorkStartChangedError("Session incarnation replaced");
        }
        release.resolve();
        await delivery;
        expect(writes).toEqual([]);
        expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(
          boundary === "restart" ? 1 : 0,
        );
        held = false;
        await drainMatrixReconnect({ stateDir: state.stateDir, deliver: deliverOutboundPayloads });
        expect(writes).toEqual(
          boundary === "restart" ? ["Captured final answer", "Final detail"] : [],
        );
        expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(0);
        if (boundary === "restart") {
          expect(loadSessionEntry(target)?.pendingFinalDelivery?.deliveries).toEqual([
            { id: expect.any(String), state: "delivered" },
          ]);
        }
        // Re-enter recovery after settlement; neither success nor revocation may replay.
        await drainMatrixReconnect({ stateDir: state.stateDir, deliver: deliverOutboundPayloads });
        expect(writes).toEqual(
          boundary === "restart" ? ["Captured final answer", "Final detail"] : [],
        );
      } finally {
        controller.abort();
        release.resolve();
        await delivery;
      }
    });
  },
);
