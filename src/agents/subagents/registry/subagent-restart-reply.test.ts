import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { captureRuntimeConfigAsyncReader } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  loadExactSessionEntryReadOnly,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import * as gatewayCall from "../../../gateway/call.js";
import { resumeMarkedSessions } from "../../../gateway/session-restart-resume.js";
import { sqliteWorkerOwnerProbe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { resetGatewayWorkAdmission } from "../../../process/gateway-work-admission.js";
import { listSessionStateEventsSince } from "../../../sessions/session-state-events.js";
import { buildRunUserTurnIdempotencyKey } from "../../../sessions/user-turn-transcript.metadata.js";
import * as stateWorker from "../../../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { registerAgentHarness } from "../../harness/registry.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import { createExternalRequesterSessionEntry } from "./subagent-registry.lifecycle-fixture.test-support.js";
import { createGatewayContext } from "./subagent-registry.requester-wake-session.test-support.js";
import * as registry from "./subagent-registry.test-helpers.js";

it.each([
  ["repeated nonterminal reads across another restart", undefined, false],
  ["new writer", { activeWriterRunId: "new-worker" }, false],
  ["Stop", { abortedLastRun: true }, false],
  ["a transient read error before an unclaimed launch", undefined, true],
] as const)(
  "reconciles a worker restored after restart with %s",
  (_label, replacement, readOlderBinding) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      await captureRuntimeConfigAsyncReader()();
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const settleRootWork = observeRootWork();
      setActivePluginRegistry(createEmptyPluginRegistry());
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const agentId = "main";
        const runId = "recovered-worker";
        const requesterSessionKey = "agent:main:main";
        const userPrompt = "Report the saved worker result";
        const scope = {
          agentId,
          storePath: resolveSessionStorePathCore(undefined, { agentId }),
        };
        const target = {
          ...scope,
          sessionKey: "agent:main:subagent:recovered-worker",
          sessionId: "saved-worker-session",
        };
        const writer = {
          sessionId: target.sessionId,
          lifecycleRevision: "worker-incarnation",
          updatedAt: Date.now(),
          agentHarnessId: "fixture-worker",
          activeWriterRunId: runId,
        };
        await upsertSessionEntryCore(
          { ...scope, sessionKey: requesterSessionKey },
          createExternalRequesterSessionEntry(),
        );
        await upsertSessionEntryCore(target, writer);
        await appendTranscriptMessage(target, {
          message: {
            role: "user",
            content: userPrompt,
            timestamp: Date.now(),
            idempotencyKey: buildRunUserTurnIdempotencyKey(runId),
          },
        });
        const answer = `${"Recovered output. ".repeat(260)}End of saved result.`;
        const observations = ["pending", "unknown", "pending"] as const;
        const nativeCalls: string[] = [];
        let bindingPresent = true;
        const runAttempt = vi.fn(async () => {
          throw new Error("Interrupted work must never start another attempt");
        });
        const registerWorkerHarness = () =>
          registerAgentHarness({
            id: "fixture-worker",
            label: "Fixture worker",
            supports: () => ({ supported: true, priority: 1 }),
            runAttempt,
            withInterruptedSubagentReply: async ({ runId: originalRunId, claim, accept }) => {
              const observation = replacement ? undefined : observations[nativeCalls.length];
              nativeCalls.push(originalRunId);
              if (readOlderBinding && nativeCalls.length === 1) {
                throw new Error("Binding read unavailable");
              }
              if (readOlderBinding || !bindingPresent) {
                return undefined;
              }
              await claim();
              if (observation) {
                return observation;
              }
              await accept(answer, () => {}, "saved-worker-final");
              // Lose the native connection after the transcript commits and before settlement.
              throw new Error("Native connection closed");
            },
          });
        registerWorkerHarness();
        await registry.addSubagentRunForTests({
          runId,
          childSessionKey: target.sessionKey,
          childAgentId: agentId,
          childSessionIdentity: {
            sessionId: writer.sessionId,
            lifecycleRevision: writer.lifecycleRevision,
          },
          requesterSessionKey,
          requesterAgentId: agentId,
          expectsCompletionMessage: true,
          cleanup: "delete",
          createdAt: Math.floor(performance.timeOrigin) - 1000,
        });
        const activateAfterRestart = async () => {
          await registry.resetSubagentRegistryForTests({ persist: false });
          resetGatewayWorkAdmission();
          const context = createGatewayContext();
          await registry.activateSubagentRegistry(() => context);
          await resumeMarkedSessions({
            context,
            signal: new AbortController().signal,
            log: { warn: vi.fn() },
          });
        };
        const readAnswers = async () =>
          (await loadTranscriptEvents(target)).flatMap((event) =>
            isRecord(event) && isRecord(event.message) && event.message.role === "assistant"
              ? [event.message]
              : [],
          );
        const readTerminalEvents = async () =>
          (await listSessionStateEventsSince(target.sessionKey, agentId, 0)).events.filter(
            (event) =>
              event.runId === runId &&
              (event.kind === "run_completed" || event.kind === "run_failed"),
          );
        const finalAnswer = expect.objectContaining({
          phase: "final_answer",
          display: true,
          content: [{ type: "text", text: answer }],
        });
        const persisted = () => loadSubagentRegistryFromSqlite().get(runId);
        const deletions: unknown[] = [];
        using spies = new DisposableStack();
        spies.use(
          vi.spyOn(gatewayCall, "callGateway").mockImplementation(async (request) => {
            await request.prepareDispatchCurrent?.();
            request.assertDispatchCurrent?.();
            if (request.method === "sessions.delete") {
              deletions.push(request.params);
            }
            return request.method === "agent.wait"
              ? { status: "pending" }
              : { status: "ok", result: { payloads: [] } };
          }),
        );
        await activateAfterRestart();
        expect(loadExactSessionEntryReadOnly(target)?.entry).toMatchObject({
          activeWriterRunId: runId,
          agentHarnessId: writer.agentHarnessId,
        });
        if (readOlderBinding) {
          await registry.testing.sweepOnceForTests();
          await settleRootWork(true);
          expect(persisted()?.execution.status).toBe("running");
          expect(deletions).toEqual([]);

          await registry.testing.sweepOnceForTests();
          await settleRootWork(true);
          expect(nativeCalls).toEqual([runId, runId]);
          expect(persisted()?.execution).toMatchObject({
            status: "terminal",
            outcome: {
              status: "error",
              error: expect.stringContaining("The Gateway restarted without confirming"),
            },
          });
          expect(runAttempt).not.toHaveBeenCalled();
          return;
        }
        if (replacement) {
          await registry.testing.sweepOnceForTests();
        } else {
          const observedAt = Date.now();
          using clock = vi.spyOn(Date, "now").mockReturnValue(observedAt);
          for (const [index] of observations.entries()) {
            await registry.testing.sweepOnceForTests();
            expect(nativeCalls).toHaveLength(index + 1);
            expect(persisted()?.execution.status).toBe("running");
          }
          await registry.testing.sweepOnceForTests();
          await settleRootWork(true);
          expect(nativeCalls).toEqual([runId, runId, runId]);
          expect(persisted()?.execution.status).toBe("running");
          expect(loadExactSessionEntryReadOnly(target)?.entry).toMatchObject({
            sessionId: target.sessionId,
            activeWriterRunId: runId,
          });
          expect(deletions).toEqual([]);
          expect(await readAnswers()).toEqual([]);

          clock.mockReturnValue(observedAt + 5 * 60_000);
          const savedTranscript = await loadTranscriptEvents(target);
          expect(savedTranscript).toContainEqual(
            expect.objectContaining({
              message: expect.objectContaining({ role: "user", content: userPrompt }),
            }),
          );
          const expectUnresolved = async () => {
            await settleRootWork(true);
            expect(persisted()?.execution.status).toBe("running");
            expect(loadExactSessionEntryReadOnly(target)?.entry).toMatchObject({
              sessionId: target.sessionId,
              activeWriterRunId: runId,
            });
            expect(await loadTranscriptEvents(target)).toEqual(savedTranscript);
            expect(await readTerminalEvents()).toEqual([]);
            expect(deletions).toEqual([]);
          };

          setActivePluginRegistry(createEmptyPluginRegistry());
          await activateAfterRestart();
          await registry.testing.sweepOnceForTests();
          expect(nativeCalls).toEqual([runId, runId, runId]);
          await expectUnresolved();

          bindingPresent = false;
          registerWorkerHarness();
          await registry.testing.sweepOnceForTests();
          expect(nativeCalls).toEqual([runId, runId, runId, runId]);
          await expectUnresolved();

          bindingPresent = true;
          await registry.testing.sweepOnceForTests();
        }
        expect(persisted()?.execution.status).toBe("running");
        expect(deletions).toEqual([]);
        expect(await readAnswers()).toEqual([finalAnswer]);

        await activateAfterRestart();
        let changedWriter = false;
        spies.use(
          sqliteWorkerOwnerProbe.command(stateWorker, async (command, options, worker) => {
            if (
              replacement &&
              !changedWriter &&
              isSubagentRegistryWriteCommand(command) &&
              command.input.terminalEvents?.length
            ) {
              changedWriter = true;
              await upsertSessionEntryCore(target, replacement);
            }
            return worker.execute(command, options);
          }),
        );
        await registry.testing.sweepOnceForTests();
        const expectedNativeCalls = replacement ? [runId] : [runId, runId, runId, runId, runId];
        expect(nativeCalls).toEqual(expectedNativeCalls);
        expect(await readAnswers()).toEqual([finalAnswer]);
        if (replacement) {
          await expect(settleRootWork(true)).rejects.toMatchObject({
            errors: [
              {
                outcome: "not-committed",
                message: expect.stringContaining("The selected session changed"),
              },
            ],
          });
          expect(changedWriter).toBe(true);
          expect(loadExactSessionEntryReadOnly(target)?.entry).toMatchObject(replacement);
          expect(persisted()?.execution.status).toBe("running");
          expect(deletions).toEqual([]);

          await registry.testing.sweepOnceForTests();
          await settleRootWork(true);
          expect(nativeCalls).toEqual(expectedNativeCalls);
          expect(loadExactSessionEntryReadOnly(target)?.entry).toMatchObject(replacement);
          expect(await readAnswers()).toEqual([finalAnswer]);
          expect(deletions).toEqual([]);
        } else {
          await settleRootWork(true);
          expect(persisted()?.execution).toMatchObject({
            status: "terminal",
            outcome: { status: "ok" },
          });
          expect(await readTerminalEvents()).toEqual([
            expect.objectContaining({ kind: "run_completed" }),
          ]);
          expect(deletions).toEqual([
            expect.objectContaining({
              key: target.sessionKey,
              expectedSessionId: target.sessionId,
              expectedLifecycleRevision: writer.lifecycleRevision,
              deleteTranscript: true,
            }),
          ]);
        }
        expect(runAttempt).not.toHaveBeenCalled();
      } finally {
        try {
          await settleRootWork();
        } finally {
          try {
            await registry.resetSubagentRegistryForTests({ persist: false });
          } finally {
            resetGatewayWorkAdmission();
            restoreActivePluginRegistrySnapshot(previousRegistry);
            vi.useRealTimers();
          }
        }
      }
    }),
);
