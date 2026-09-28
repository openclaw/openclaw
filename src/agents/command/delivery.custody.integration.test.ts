// Exercises the automatic sender with real native completion/session stores and recording transport.
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { captureCommandOwnerAssertion } from "../../auto-reply/command-owner-authority.js";
import { getReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import { createMessageReceiptFromOutboundResults } from "../../channels/message/receipt.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import {
  buildRestartRecoveryClaimCleanupPatch,
  getRestartRecoveryTerminalDeliveryEvidence,
} from "../../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidence } from "../../config/sessions/restart-recovery-types.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import * as transcriptReads from "../../config/sessions/session-accessor.sqlite-active-events.js";
import * as replacementWorker from "../../config/sessions/session-accessor.sqlite-replacement-worker.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import { drainPendingDeliveriesCore } from "../../infra/outbound/delivery-queue-recovery.js";
import { loadUnfinishedDeliveries as loadPendingDeliveries } from "../../infra/outbound/delivery-queue-storage.js";
import { createRecoveryLog } from "../../infra/outbound/delivery-queue.test-helpers.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { addTestHook } from "../../plugins/hooks.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { bindCommandHarnessCompletionAssertion } from "../agent-command-restart-recovery.js";
import { reconcileHarnessCompletionDelivery } from "../agent-harness-completion-delivery.js";
import { captureAdmittedHarnessCompletionForTest } from "../agent-harness-completion.test-support.js";
import { resolveSourceReplyDelivery } from "../embedded-agent-runner/delivery-evidence.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner/types.js";
import { persistPendingFinalDeliveryMarker } from "../pending-final-delivery-marker.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { deliverAgentCommandResult } from "./delivery.js";

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
});

describe("native completion final-send custody", () => {
  for (const boundary of [
    "reply hook",
    "adapter preparation",
    "queued retry",
    "queued after cleanup",
    "restart onPlatformSendDispatch",
    "restart assertDirectAdapterHandoff",
    "source read onPlatformSendDispatch",
    "source read assertDirectAdapterHandoff",
  ] as const) {
    const restart = boundary.startsWith("restart");
    const readFailure = boundary.startsWith("source read");
    const handoff = restart || readFailure;
    const authorizationOutcomes = readFailure
      ? (["source-interleaved", "owner-bound-source-interleaved"] as const)
      : restart
        ? ([
            "unchanged",
            "source-interleaved",
            "owner-bound-unchanged",
            "owner-bound-source-interleaved",
          ] as const)
        : (["unchanged", "physical", "revision"] as const);
    it.each(authorizationOutcomes)(
      `enforces %s requester authorization across ${boundary}`,
      async (outcome) => {
        const queued = boundary.startsWith("queued");
        const unchanged = outcome.endsWith("unchanged");
        await withAdminIngress(async ({ state, cfg, admins, context }) => {
          const recover = () =>
            drainPendingDeliveriesCore({
              drainKey: "matrix:completion-custody",
              logLabel: "Completion custody",
              cfg,
              log: createRecoveryLog(),
              stateDir: state.stateDir,
              deliver: deliverOutboundPayloads,
              selectEntry: () => ({ match: true, bypassBackoff: true }),
            });
          const key = "agent:main:matrix:direct:owner";
          const child = "codex-thread:final-send-child";
          const source = "announce:final-send-child:succeeded";
          const recovery = "restart-recovery:final-send";
          const target = {
            agentId: "main",
            sessionKey: key,
            storePath: path.join(state.sessionsDir(), "sessions.json"),
          };
          const entry = {
            sessionId: "original-parent",
            lifecycleRevision: "original-revision",
            status: "running" as const,
            updatedAt: Date.now(),
            restartRecoveryDeliveryRunId: recovery,
          };
          await replaceSessionEntry(target, entry);
          const provenance = {
            kind: "inter_session",
            sourceTool: "agent_harness_task",
            sourceChannel: "internal",
            sourceSessionKey: child,
          };
          const claim = await captureAdmittedHarnessCompletionForTest({
            agentId: "main",
            sessionKey: key,
            entry,
            runId: source,
            inputProvenance: provenance,
          });
          if (!claim) {
            throw new Error("completion claim was not admitted");
          }
          await appendTranscriptMessage(
            { ...target, sessionId: entry.sessionId },
            {
              message: {
                role: "user",
                content: "child result",
                idempotencyKey: `${source}:user`,
                provenance,
                __openclaw: { runId: source },
                timestamp: Date.now(),
              },
            },
          );
          const admittedEntry = { ...entry, restartRecoveryHarnessCompletion: claim };
          await replaceSessionEntry(target, admittedEntry);
          const opts = bindCommandHarnessCompletionAssertion({
            claim,
            persisted: admittedEntry,
            sessionKey: key,
            storePath: target.storePath,
            opts: {
              message: "Continue admitted completion",
              assertSourceCurrent: outcome.startsWith("owner-bound")
                ? captureCommandOwnerAssertion(await context(admins[0]!.identity.senderId))
                : undefined,
            },
          });
          const assertCurrent = opts.assertSourceCurrent!;
          if (outcome.startsWith("owner-bound")) {
            expect(assertCurrent.recoveryReference).toBeTruthy();
          }
          const payloads = [{ text: "The completed child result" }];
          const marker = await persistPendingFinalDeliveryMarker({
            agentId: target.agentId,
            deliver: true,
            sessionStore: { [key]: admittedEntry },
            sessionKey: key,
            sessionEntry: admittedEntry,
            storePath: target.storePath,
            suppressVisibleSessionEffects: false,
            sessionReboundDuringRun: false,
            payloads,
            deliveryContext: { channel: "matrix", to: "!owner:example", accountId: "default" },
            runOwnedSessionId: entry.sessionId,
            commandOwnerReference: assertCurrent.recoveryReference,
          });
          expect(marker.pendingFinalDeliveryMarkerPersisted).toBe(true);
          assertCurrent();
          const entered = createDeferred();
          const release = createDeferred();
          const writes: string[] = [];
          const controller = new AbortController();
          let recoveryStarted = false;
          const hold = async () => {
            entered.resolve();
            await release.promise;
          };
          let prepareAttempts = 0;
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
                lifecycle: {
                  beforeSendAttempt: async () => {
                    if (boundary === "adapter preparation") {
                      await hold();
                    } else if (queued && prepareAttempts++ === 0) {
                      throw new PlatformMessageNotDispatchedError("temporary transport failure", {
                        cause: undefined,
                      });
                    }
                  },
                },
                text: async ({ text, onPlatformSendDispatch, assertDirectAdapterHandoff }) => {
                  if (handoff && !recoveryStarted && boundary.endsWith("onPlatformSendDispatch")) {
                    await hold();
                  }
                  await onPlatformSendDispatch?.();
                  if (
                    handoff &&
                    !recoveryStarted &&
                    boundary.endsWith("assertDirectAdapterHandoff")
                  ) {
                    await hold();
                  }
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
          const registry = createTestRegistry([{ pluginId: "matrix", source: "test", plugin }]);
          if (boundary === "reply hook") {
            addTestHook({
              registry,
              pluginId: "held-completion-hook",
              hookName: "reply_payload_sending",
              handler: hold,
            });
          }
          setActivePluginRegistry(registry);
          initializeGlobalHookRunner(registry);
          const delivery = deliverAgentCommandResult({
            cfg,
            deps: {},
            runtime: { log: () => {}, error: () => {}, exit: () => {} },
            opts: {
              ...opts,
              abortSignal: controller.signal,
              deliver: true,
              replyChannel: "matrix",
              replyTo: "!owner:example",
              accountId: "default",
              sessionKey: key,
              runId: recovery,
            },
            outboundSession: { agentId: "main", key },
            sessionEntry: marker.sessionEntry,
            result: { meta: { durationMs: 1 } },
            payloads,
            assertDeliveryCurrent: () => {
              assertCurrent();
              controller.signal.throwIfAborted();
            },
          }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          if (queued) {
            expect((await delivery).ok).toBe(false);
            const pending = await loadPendingDeliveries(state.stateDir);
            expect(pending).toHaveLength(1);
            expect(pending[0]?.deliveryCompletion).toMatchObject({
              kind: "pending-final",
              sessionWriterDeliveryAuthority: { harnessCompletion: claim },
            });
          } else {
            await entered.promise;
          }
          expect(writes).toEqual([]);
          if (readFailure) {
            expect(await loadPendingDeliveries(state.stateDir)).toHaveLength(1);
            const sourceRead = vi
              .spyOn(transcriptReads, "everySessionTranscriptUserInputFrom")
              .mockImplementationOnce(() => {
                throw new Error("Source transcript read unavailable");
              });
            release.resolve();
            try {
              expect((await delivery).ok).toBe(false);
            } finally {
              sourceRead.mockRestore();
            }
          }
          if (outcome.endsWith("source-interleaved")) {
            await appendTranscriptMessage(
              { ...target, sessionId: entry.sessionId },
              { message: { role: "user", content: "A new request", timestamp: Date.now() } },
            );
            expect(assertCurrent).toThrow(SessionWorkStartChangedError);
          }
          if (boundary === "queued after cleanup") {
            await appendTranscriptMessage(
              { ...target, sessionId: entry.sessionId },
              {
                message: {
                  role: "user",
                  content: "Continue the admitted completion",
                  idempotencyKey: `${recovery}:user`,
                  provenance: {
                    kind: "internal_system",
                    sourceTool: "main_session_restart_recovery",
                    sourceSessionKey: key,
                  },
                  __openclaw: { runId: recovery },
                  timestamp: Date.now(),
                },
              },
            );
            const markerEntry = marker.sessionEntry;
            if (!markerEntry) {
              throw new Error("pending final marker missing");
            }
            await replaceSessionEntry(target, {
              ...markerEntry,
              ...buildRestartRecoveryClaimCleanupPatch({
                entry: markerEntry,
                recordTerminalSource: true,
                terminalRunId: recovery,
                terminalSourceRunId: source,
              }),
            });
            const cleaned = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
            expect(cleaned?.restartRecoveryDeliveryRunId).toBeUndefined();
            expect(cleaned?.restartRecoveryHarnessCompletion).toBeUndefined();
            expect(cleaned?.restartRecoveryTerminalDeliveryEvidence).toEqual([
              {
                runId: source,
                harnessCompletion: claim,
                deliveryContext: markerEntry.pendingFinalDelivery?.context,
                captured: true,
              },
            ]);
          }
          if (outcome === "physical" || outcome === "revision") {
            await replaceSessionEntry(target, {
              ...marker.sessionEntry!,
              ...(outcome === "physical"
                ? { sessionId: "replacement-parent" }
                : { lifecycleRevision: "replacement-revision" }),
            });
            expect(assertCurrent).toThrow();
          }
          if (handoff) {
            if (restart) {
              controller.abort(createAgentRunRestartAbortError());
              release.resolve();
              expect((await delivery).ok).toBe(false);
            }
            recoveryStarted = true;
            await recover();
          } else if (queued) {
            // The drain reconstructs callbacks from SQLite, not the old sender closure.
            await recover();
          } else {
            release.resolve();
            const settled = await delivery;
            if (boundary === "reply hook" && !unchanged) {
              // Revocation before queue admission retires the unsent intent.
              expect(settled.ok).toBe(true);
              if (!settled.ok) {
                throw settled.error;
              }
              expect(settled.value.deliveryStatus).toMatchObject({
                status: "suppressed",
                reason: "no_visible_result",
                resultCount: 0,
              });
            } else {
              expect(settled.ok).toBe(unchanged);
            }
          }
          expect(writes).toEqual(unchanged ? ["The completed child result"] : []);
          // Revocation must not leave a queued stale reply for a later drain.
          expect(await loadPendingDeliveries(state.stateDir)).toEqual([]);
          if (handoff) {
            await recover();
            expect(writes).toEqual(unchanged ? ["The completed child result"] : []);
          }
          if (unchanged) {
            // Reconcile native completion state as startup would: queue acknowledgment must not
            // be the only copy of the exact harness completion receipt.
            expect(
              reconcileHarnessCompletionDelivery({
                ...target,
                sourceRunId: source,
                taskRunId: child,
              }),
            ).toBe("delivered");
          }
        });
      },
    );
  }
});

describe("native completion marker commit", () => {
  it("preserves existing send evidence without assigning it to a different completion claim", async () => {
    await withAdminIngress(async ({ state }) => {
      for (const binding of ["missing", "foreign", "matching"] as const) {
        const key = `agent:main:existing-evidence-${binding}`;
        const source = `announce:existing-evidence-${binding}`;
        const target = {
          agentId: "main",
          sessionKey: key,
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        const entry = {
          sessionId: `requester-${binding}`,
          lifecycleRevision: "current-revision",
          updatedAt: Date.now(),
          status: "running" as const,
          restartRecoveryDeliveryRunId: source,
          restartRecoveryDeliverySourceRunId: source,
        };
        const provenance = {
          kind: "inter_session",
          sourceTool: "agent_harness_completion",
          sourceChannel: "internal",
          sourceSessionKey: `codex-thread:existing-evidence-${binding}`,
        };
        await replaceSessionEntry(target, entry);
        const claim = await captureAdmittedHarnessCompletionForTest({
          agentId: "main",
          sessionKey: key,
          entry,
          runId: source,
          inputProvenance: provenance,
        });
        if (!claim) {
          throw new Error("Expected admitted completion claim");
        }
        const deliveryContext = { channel: "matrix", to: "!owner:example", accountId: "default" };
        const receipt: RestartRecoveryTerminalDeliveryEvidence = {
          runId: source,
          captured: true,
          payloads: [{ visible: true }],
          deliveryContext,
          deliveryStatus: { status: "sent", resultCount: 1 },
          ...(binding === "missing"
            ? {}
            : {
                harnessCompletion:
                  binding === "matching" ? claim : { ...claim, sessionId: "previous-requester" },
                durableFinalReceipt: {
                  intentId: "sent-intent",
                  deliveryId: "sent-delivery",
                  platformMessageId: "sent-message",
                },
              }),
        };
        const current = {
          ...entry,
          restartRecoveryHarnessCompletion: claim,
          restartRecoveryTerminalDeliveryEvidence: [receipt],
        };
        await replaceSessionEntry(target, current);
        await appendTranscriptMessage(
          { ...target, sessionId: entry.sessionId },
          {
            message: {
              role: "user",
              content: "Completion result",
              idempotencyKey: `${source}:user`,
              __openclaw: { runId: source },
              provenance,
            },
          },
        );
        const read = () => loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
        const before = getRestartRecoveryTerminalDeliveryEvidence(read(), source);
        expect(before?.deliveryStatus, binding).toEqual({ status: "sent", resultCount: 1 });
        const reconcile = () =>
          reconcileHarnessCompletionDelivery({
            ...target,
            sourceRunId: source,
            taskRunId: claim.taskRunId,
          });
        expect(reconcile(), binding).toBe(binding === "matching" ? "delivered" : "pending");
        const marker = await persistPendingFinalDeliveryMarker({
          ...target,
          deliver: true,
          sessionStore: { [key]: current },
          sessionEntry: current,
          suppressVisibleSessionEffects: false,
          sessionReboundDuringRun: false,
          payloads: [{ text: "Captured final" }],
          deliveryContext,
          runOwnedSessionId: entry.sessionId,
        });
        expect(marker.pendingFinalDeliveryMarkerPersisted, binding).toBe(true);
        const after = read();
        expect
          .soft(getRestartRecoveryTerminalDeliveryEvidence(after, source), binding)
          .toEqual(before);
        if (!after) {
          throw new Error("Requester entry disappeared");
        }
        await replaceSessionEntry(target, {
          ...after,
          ...buildRestartRecoveryClaimCleanupPatch({
            entry: after,
            recordTerminalSource: true,
            terminalSourceRunId: source,
            terminalRunId: source,
          }),
        });
        const cleaned = read();
        expect(cleaned?.restartRecoveryHarnessCompletion, binding).toBeUndefined();
        expect
          .soft(getRestartRecoveryTerminalDeliveryEvidence(cleaned, source), binding)
          .toEqual(before);
        expect(reconcile(), binding).toBe(binding === "matching" ? "delivered" : "blocked");
      }
    });
  });

  it("checkpoints canonical storage while preserving ordinary and opaque caller keys", async () => {
    await withAdminIngress(async ({ state }) => {
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      for (const [requestKey, storedKey] of [
        [
          "agent:main:assist:01M21F31SCNCCQQ3N4X43AY420",
          "agent:main:assist:01m21f31scnccqq3n4x43ay420",
        ],
        ["main", "agent:main:main"],
        ["agent:main:signal:group:AbC=", "agent:main:signal:group:AbC="],
        ["agent:main:matrix:group:!Room:example.org", "agent:main:matrix:group:!Room:example.org"],
      ] as const) {
        const entry = { sessionId: requestKey, updatedAt: 1 };
        const target = { agentId: "main", storePath, sessionKey: storedKey };
        await replaceSessionEntry(target, entry);
        const sessionStore = { [requestKey]: entry };
        const payloads = [{ text: "Final for this exact route" }];
        const result = await persistPendingFinalDeliveryMarker({
          agentId: "main",
          sessionKey: requestKey,
          storePath,
          sessionStore,
          sessionEntry: entry,
          deliver: true,
          suppressVisibleSessionEffects: false,
          sessionReboundDuringRun: false,
          payloads,
          deliveryContext: { channel: "matrix", to: "!owner:example" },
          runOwnedSessionId: entry.sessionId,
        });
        expect(result.pendingFinalDeliveryMarkerPersisted, requestKey).toBe(true);
        const persisted = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
        expect(persisted?.pendingFinalDelivery?.intentId).toBe(result.pendingFinalDeliveryIntentId);
        expect(sessionStore[requestKey]).toEqual(persisted);
        expect(Object.keys(sessionStore)).toEqual([requestKey]);
        expect(
          getReplyPayloadMetadata(payloads[0]!)?.pendingFinalDeliveryCompletion?.sessionKey,
        ).toBe(requestKey);
      }
    });
  });

  it.each(["source", "receipt", "authority"] as const)(
    "keeps a newer %s when marker planning yields before its worker commit",
    async (changed) => {
      await withAdminIngress(async ({ state }) => {
        const key = "agent:main:marker-race";
        const target = {
          agentId: "main",
          sessionKey: key,
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        const original = {
          sessionId: "marker-session",
          lifecycleRevision: "marker-revision",
          status: "running" as const,
          updatedAt: Date.now(),
        };
        await replaceSessionEntry(target, original);
        const claim = await captureAdmittedHarnessCompletionForTest({
          agentId: "main",
          sessionKey: key,
          entry: original,
          runId: "announce:marker-race",
          inputProvenance: {
            kind: "inter_session",
            sourceTool: "agent_harness_completion",
            sourceChannel: "internal",
            sourceSessionKey: "codex-thread:marker-child",
          },
        });
        if (!claim) {
          throw new Error("Completion claim was not admitted");
        }
        const entry = { ...original, restartRecoveryHarnessCompletion: claim };
        await replaceSessionEntry(target, entry);
        const context = { channel: "matrix", to: "!owner:example", accountId: "default" };
        const entered = createDeferred();
        const released = createDeferred();
        let current = true;
        const commit = replacementWorker.commitSessionEntryReplacementsInWorker;
        const committing = vi
          .spyOn(replacementWorker, "commitSessionEntryReplacementsInWorker")
          .mockImplementationOnce(async (...args) => {
            entered.resolve();
            await released.promise;
            return await commit(...args);
          });
        const pending = persistPendingFinalDeliveryMarker({
          ...target,
          assertCurrent: () => {
            if (!current) {
              throw new Error("Marker source was revoked");
            }
          },
          deliver: true,
          sessionStore: { [key]: entry },
          sessionEntry: entry,
          suppressVisibleSessionEffects: false,
          sessionReboundDuringRun: false,
          payloads: [{ text: "Original final" }],
          deliveryContext: context,
          runOwnedSessionId: entry.sessionId,
        });
        void pending.catch(() => {});
        try {
          await Promise.race([entered.promise, pending]);
          expect(committing).toHaveBeenCalledOnce();
          const before = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
          if (!before) {
            throw new Error("Marker target is missing");
          }
          expect(before.pendingFinalDelivery).toBeUndefined();
          expect(before.restartRecoveryTerminalDeliveryEvidence).toBeUndefined();
          const replacement = structuredClone(before);
          if (changed === "source") {
            replacement.restartRecoveryHarnessCompletion = {
              ...claim,
              sourceRunId: "announce:new-source",
              taskId: "codex-thread:new-child",
              taskRunId: "codex-thread:new-child",
            };
          } else if (changed === "receipt") {
            replacement.restartRecoveryTerminalDeliveryEvidence = [
              {
                runId: claim.sourceRunId,
                harnessCompletion: claim,
                deliveryContext: context,
                captured: true,
                payloads: [{ visible: true }],
                deliveryStatus: { status: "sent", resultCount: 1 },
                durableFinalReceipt: {
                  intentId: "settled-intent",
                  deliveryId: "settled-delivery",
                  platformMessageId: "settled-message",
                },
              },
            ];
          } else {
            current = false;
          }
          if (changed !== "authority") {
            // A foreign writer can commit while planning holds no SQLite transaction.
            const database = new DatabaseSync(
              resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
            );
            try {
              database
                .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
                .run(JSON.stringify(replacement), key);
            } finally {
              database.close();
            }
          }
          released.resolve();
          await expect(pending).rejects.toThrow(
            changed === "authority" ? "Marker source was revoked" : "changed before replacement",
          );
          const after = loadExactSessionEntry({ ...target, readConsistency: "latest" })?.entry;
          expect(after?.pendingFinalDelivery).toBeUndefined();
          expect(after?.restartRecoveryHarnessCompletion).toEqual(
            replacement.restartRecoveryHarnessCompletion,
          );
          expect(after?.restartRecoveryTerminalDeliveryEvidence).toEqual(
            replacement.restartRecoveryTerminalDeliveryEvidence,
          );
        } finally {
          released.resolve();
          await pending.catch(() => {});
          committing.mockRestore();
        }
      });
    },
  );
});

describe("message-tool source reply custody", () => {
  it.each([
    {
      name: "confirmed source reply",
      result: { didDeliverSourceReplyViaMessageTool: true },
      expected: "delivered",
    },
    {
      name: "current-source receipt",
      result: { sourceReplyDelivered: true },
      expected: "delivered",
    },
    {
      name: "source final payload",
      result: {
        messagingToolSourceReplyPayloads: [{ text: "Done", sourceReplyFinal: true }],
      },
      expected: "delivered",
    },
    {
      name: "source progress without a final",
      result: {
        sourceReplyDelivered: true,
        messagingToolSourceReplyPayloads: [{ text: "Working", sourceReplyFinal: false }],
      },
      expected: "missing",
    },
    {
      name: "pending source delivery",
      result: { sourceReplyDeliveryState: "pending" },
      expected: "pending",
    },
    {
      name: "an unrelated outbound send",
      result: { didSendViaMessagingTool: true, messagingToolSentTexts: ["Elsewhere"] },
      expected: "missing",
    },
  ] satisfies Array<{ name: string; result: Partial<EmbeddedAgentRunResult>; expected: string }>)(
    "preserves reply satisfaction for $name when automatic delivery is disabled",
    async ({ result, expected }) => {
      setActivePluginRegistry(createTestRegistry());
      const delivered = await deliverAgentCommandResult({
        cfg: {},
        deps: {},
        runtime: { log: () => {}, error: () => {}, exit: () => {} },
        opts: { message: "Private completion", deliver: false },
        outboundSession: undefined,
        sessionEntry: undefined,
        payloads: [],
        result: { meta: { durationMs: 1 }, ...result },
      });

      expect(resolveSourceReplyDelivery(delivered)).toBe(expected);
    },
  );
});
