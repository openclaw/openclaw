import path from "node:path";
import { expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import type { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target-paths.js";
import { callGateway } from "../../gateway/call.js";
import type { GatewayRecoveryRuntime } from "../../gateway/server-instance-runtime.types.js";
import {
  readSessionMessagesAsync,
  visitSessionMessagesAsync,
} from "../../gateway/session-transcript-readers.js";
import { createAgentHarnessTaskRuntime } from "../../plugin-sdk/agent-harness-task-runtime.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  captureHarnessCompletionRecovery,
  readAdmittedHarnessCompletionInput,
} from "../../tasks/agent-harness-completion-recovery.js";
import { createAgentHarnessTaskRuntimeScope } from "../../tasks/agent-harness-task-runtime-scope.js";
import { markTaskTerminalById } from "../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../tasks/task-registry.test-support.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { buildCurrentRunRestartRecoveryClaim } from "../agent-command-restart-recovery.js";
import type { SessionEntryFixture } from "../subagent-test-fixtures.test-helpers.js";

type HarnessRecoveryFixture = {
  tmpDir: string;
  makeSessionsDir: (agentId?: string) => Promise<string>;
  mainSessionEntry: (overrides?: SessionEntryFixture) => SessionEntry;
  runningSessionEntry: (sessionId: string, overrides?: SessionEntryFixture) => SessionEntry;
  writeStore: (sessionsDir: string, store: Record<string, SessionEntryFixture>) => Promise<void>;
  writeTranscript: (
    sessionsDir: string,
    sessionId: string,
    messages: readonly unknown[],
  ) => Promise<void>;
  expectRecovery: (expected: {
    started: number;
    settled: number;
    failed: number;
    skipped: number;
  }) => Promise<void>;
  loadSessionEntry: (scope: Parameters<typeof loadSessionEntry>[0]) => SessionEntry | undefined;
  sendRecoveryNotice: Mock<GatewayRecoveryRuntime["sendRecoveryNotice"]>;
  dispatchSettlement: { resolve: () => void };
  discordDeliveryContext: { readonly channel: "discord"; readonly to: string };
  gatewayParams: () => Record<string, unknown>;
};

async function corruptLaterAssistantPayload(storePath: string, sessionId: string) {
  const scope = { agentId: "main", sessionKey: "agent:main:main", sessionId, storePath };
  await visitSessionMessagesAsync(scope, () => {});
  const target = resolveUnsuffixedSqliteTargetFromSessionStorePath(storePath);
  const { db } = openOpenClawAgentDatabase({ agentId: "main", path: target.path });
  const original = db
    .prepare(
      "SELECT seq, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq DESC LIMIT 1",
    )
    .get(sessionId);
  if (
    !original ||
    typeof original.seq !== "number" ||
    !(original.event_zstd instanceof Uint8Array)
  ) {
    throw new Error("Expected a compressed assistant payload.");
  }
  // The long assistant payload has stored navigation; corrupt only its body.
  const changed = db
    .prepare(
      `UPDATE transcript_events SET event_json = '{malformed', event_zstd = NULL
       WHERE session_id = ? AND navigation_json IS NOT NULL AND seq = (
         SELECT MAX(seq) FROM transcript_events WHERE session_id = ?
       )`,
    )
    .run(sessionId, sessionId);
  expect(changed.changes).toBe(1);
  await expect(
    readSessionMessagesAsync(scope, { mode: "recent", maxMessages: 20, maxBytes: 256 * 1024 }),
  ).rejects.toBeInstanceOf(SyntaxError);
  const { seq, event_zstd: compressed } = original;
  return () => {
    expect(
      db
        .prepare(
          "UPDATE transcript_events SET event_json = NULL, event_zstd = ? WHERE session_id = ? AND seq = ?",
        )
        .run(compressed, sessionId, seq).changes,
    ).toBe(1);
  };
}

export function registerHarnessCompletionRecoveryCases(
  getFixture: () => HarnessRecoveryFixture,
): void {
  it.each([
    "initial",
    "recovery",
    "long-initial",
    "long-recovery",
    "missing-source",
    "missing-claim",
    "transcript-read-failure",
    "reserved-successor",
    "human-before-recovery",
    "cancel-before-recovery",
    "duplicate-before-recovery",
    "cancel-after-dispatch",
    "duplicate-after-dispatch",
    "cancel-before-notice-effect",
  ])(
    "recovers the admitted harness completion after %s execution is interrupted",
    async (phase) => {
      const {
        tmpDir,
        makeSessionsDir,
        mainSessionEntry,
        writeStore,
        writeTranscript,
        expectRecovery,
        loadSessionEntry,
        sendRecoveryNotice,
        dispatchSettlement,
        discordDeliveryContext,
      } = getFixture();
      await withEnvAsync({ OPENCLAW_STATE_DIR: tmpDir }, async () => {
        resetTaskRegistryForTests();
        const sessionsDir = await makeSessionsDir();
        const sessionKey = "agent:main:main";
        const taskRunId = "harness:child-1";
        const sourceRunId = "announce:harness:parent:child-1:succeeded";
        const runtime = createAgentHarnessTaskRuntime({
          runtime: "subagent",
          taskKind: "example-harness",
          scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: sessionKey }),
        });
        runtime.createRunningTaskRun({
          runId: taskRunId,
          sourceId: taskRunId,
          task: "work",
          requesterAgentId: "main",
          notifyPolicy: "silent",
        });
        runtime.finalizeTaskRunByRunId({
          runId: taskRunId,
          status: "succeeded",
          endedAt: Date.now(),
          terminalSummary: "result",
        });
        runtime.setDetachedTaskDeliveryStatusByRunId({
          runId: taskRunId,
          deliveryStatus: "pending",
        });
        const provenance = {
          kind: "inter_session",
          sourceTool: "agent_harness_task",
          sourceChannel: "internal",
          sourceSessionKey: taskRunId,
        } as const;
        const entry = mainSessionEntry({ lifecycleRevision: "revision-1" });
        const binding = captureHarnessCompletionRecovery({
          agentId: "main",
          sessionKey,
          entry,
          runId: sourceRunId,
          inputProvenance: provenance,
        });
        expect(binding).toBeDefined();
        const original = {
          ...entry,
          ...buildCurrentRunRestartRecoveryClaim({
            entry,
            runId: sourceRunId,
            sourceRunId,
            sourceIngress: "internal",
            sourceReplyDeliveryMode: "automatic",
            deliveryContext: discordDeliveryContext,
            harnessCompletion: binding,
          }),
        };
        const operationalRunId =
          phase === "reserved-successor"
            ? "recovery-R2"
            : phase.endsWith("recovery")
              ? "recovery-R"
              : sourceRunId;
        await writeStore(sessionsDir, {
          [sessionKey]: {
            ...original,
            restartRecoveryDeliveryRunId: operationalRunId,
            ...(phase === "missing-claim" ? { restartRecoveryHarnessCompletion: undefined } : {}),
            ...(phase === "transcript-read-failure" || phase === "missing-claim"
              ? {
                  pendingFinalDelivery: {
                    kind: "replayable" as const,
                    text: "Prepared completion reply",
                    createdAt: Date.now(),
                    intentId: "harness-read-failure-final",
                    deliveries: [
                      { id: "harness-read-failure-delivery", state: "prepared" as const },
                    ],
                  },
                }
              : {}),
            ...(phase === "reserved-successor"
              ? {
                  restartRecoveryRuns: [
                    { runId: "recovery-R", lifecycleGeneration: "prior-gateway" },
                  ],
                }
              : {}),
          },
        });
        await writeTranscript(sessionsDir, entry.sessionId, [
          {
            role: "user",
            content: "Background work finished",
            idempotencyKey:
              phase === "missing-source" ? "unrelated-input:user" : `${sourceRunId}:user`,
            __openclaw: { runId: sourceRunId },
            provenance,
          },
          ...(phase === "human-before-recovery"
            ? [{ role: "user", content: "stop that completion and work on my new request" }]
            : []),
          ...(phase.endsWith("recovery") || phase === "reserved-successor"
            ? [
                {
                  role: "user",
                  content: "Continue interrupted reply",
                  __openclaw: {
                    runId: phase === "reserved-successor" ? "recovery-R" : operationalRunId,
                  },
                  provenance: {
                    kind: "internal_system",
                    sourceTool: "main_session_restart_recovery",
                    sourceSessionKey: sessionKey,
                  },
                },
              ]
            : []),
          ...(phase.startsWith("long-")
            ? Array.from({ length: 40 }, (_, index) => ({
                role: "assistant",
                content: `intermediate ${index}`,
              }))
            : []),
          ...(phase === "transcript-read-failure"
            ? [{ role: "assistant", content: "Completion still being prepared. ".repeat(128) }]
            : []),
        ]);
        if (phase === "missing-claim") {
          await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
          expect(callGateway).not.toHaveBeenCalled();
          expect(
            loadSessionEntry({ sessionKey, storePath: path.join(sessionsDir, "sessions.json") }),
          ).toMatchObject({
            abortedLastRun: false,
            mainRestartRecovery: { tombstone: expect.any(Object) },
          });
          expect(runtime.listTaskRecords()[0]?.deliveryStatus).toBe("pending");
          return;
        }
        if (phase === "transcript-read-failure") {
          const storePath = path.join(sessionsDir, "sessions.json");
          const restorePayload = await corruptLaterAssistantPayload(storePath, entry.sessionId);
          const current = loadSessionEntry({ sessionKey, storePath });
          expect(
            binding &&
              current &&
              readAdmittedHarnessCompletionInput({
                claim: binding,
                entry: current,
                storePath,
                operationalRunId,
              }),
          ).toBe(true);
          await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 });
          expect(callGateway).not.toHaveBeenCalled();
          expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
            status: "running",
            abortedLastRun: true,
            restartRecoveryHarnessCompletion: binding,
            restartRecoveryDeliverySourceRunId: sourceRunId,
            pendingFinalDelivery: {
              intentId: "harness-read-failure-final",
              text: "Prepared completion reply",
            },
          });
          expect(runtime.listTaskRecords()[0]?.deliveryStatus).toBe("pending");
          expect(sendRecoveryNotice).not.toHaveBeenCalled();
          restorePayload();
          await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
          expect(callGateway).toHaveBeenCalledOnce();
          dispatchSettlement.resolve();
          return;
        }
        if (phase === "missing-source" || phase === "human-before-recovery") {
          await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 });
          expect(callGateway).not.toHaveBeenCalled();
          expect(
            loadSessionEntry({ sessionKey, storePath: path.join(sessionsDir, "sessions.json") }),
          ).toMatchObject({
            status: "running",
            restartRecoveryHarnessCompletion: binding,
            restartRecoveryDeliverySourceRunId: sourceRunId,
          });
          expect(runtime.listTaskRecords()[0]?.deliveryStatus).toBe("pending");
          return;
        }
        const invalidateTask = () => {
          if (phase === "duplicate-after-dispatch" || phase === "duplicate-before-recovery") {
            runtime.createRunningTaskRun({
              runId: taskRunId,
              sourceId: taskRunId,
              task: "different work sharing a native run id",
              requesterAgentId: "main",
              notifyPolicy: "silent",
            });
          } else {
            const task = runtime.listTaskRecords()[0];
            if (!task) {
              throw new Error("Missing original task.");
            }
            markTaskTerminalById({ taskId: task.taskId, status: "cancelled", endedAt: Date.now() });
          }
        };
        if (phase === "cancel-before-recovery" || phase === "duplicate-before-recovery") {
          invalidateTask();
          await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
          expect(callGateway).not.toHaveBeenCalled();
          expect(
            loadSessionEntry({ sessionKey, storePath: path.join(sessionsDir, "sessions.json") }),
          ).toMatchObject({ status: "killed", abortedLastRun: false });
          return;
        }
        let effectCurrentAfter: boolean | undefined;
        if (phase === "cancel-after-dispatch" || phase === "duplicate-after-dispatch") {
          vi.mocked(callGateway).mockImplementationOnce(async () => {
            await Promise.resolve();
            invalidateTask();
            return { runId: "run-resumed" };
          });
        } else if (phase === "cancel-before-notice-effect") {
          sendRecoveryNotice.mockImplementationOnce(async (notice) => {
            await Promise.resolve();
            invalidateTask();
            effectCurrentAfter = notice.isCurrent?.({});
            return { suppressed: !effectCurrentAfter };
          });
        }
        await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
        expect(callGateway).toHaveBeenCalledOnce();
        if (phase === "cancel-after-dispatch" || phase === "duplicate-after-dispatch") {
          expect(sendRecoveryNotice).not.toHaveBeenCalled();
        } else if (phase === "cancel-before-notice-effect") {
          expect(effectCurrentAfter).toBe(false);
        }

        const saved = loadSessionEntry({
          sessionKey,
          storePath: path.join(sessionsDir, "sessions.json"),
        });
        expect(saved?.restartRecoveryHarnessCompletion).toEqual(binding);
        expect(saved?.restartRecoveryDeliverySourceRunId).toBe(sourceRunId);
        expect(saved?.restartRecoveryDeliveryRunId).not.toBe(sourceRunId);
        expect(runtime.listTaskRecords()[0]?.deliveryStatus).toBe("pending");
        dispatchSettlement.resolve();
      });
    },
  );

  it.each(["channel", "control-ui"] as const)(
    "retains %s recovery custody when a later transcript payload cannot be read",
    async (sourceIngress) => {
      const {
        makeSessionsDir,
        mainSessionEntry,
        writeStore,
        writeTranscript,
        expectRecovery,
        loadSessionEntry,
        sendRecoveryNotice,
      } = getFixture();
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:main";
      const pendingFinalDelivery = {
        kind: "replayable" as const,
        text: "Prepared reply",
        createdAt: Date.now(),
        intentId: "read-failure-final",
        deliveries: [{ id: "read-failure-delivery", state: "prepared" as const }],
      };
      const entry = mainSessionEntry({
        restartRecoverySourceIngress: sourceIngress,
        pendingFinalDelivery,
      });
      await writeStore(sessionsDir, { [sessionKey]: entry });
      await writeTranscript(sessionsDir, entry.sessionId, [
        { role: "user", content: "Continue my task" },
        { role: "assistant", content: "Reply still being prepared. ".repeat(128) },
      ]);
      const restorePayload = await corruptLaterAssistantPayload(storePath, entry.sessionId);
      await expectRecovery({ started: 0, settled: 0, failed: 1, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        status: "running",
        abortedLastRun: true,
        pendingFinalDelivery,
      });
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      restorePayload();
      await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).toHaveBeenCalledOnce();
    },
  );

  it.each(["delegated", "unverified internal", "internal system"] as const)(
    "refuses %s recovery without surviving sender authority",
    async (source) => {
      const {
        makeSessionsDir,
        mainSessionEntry,
        writeStore,
        writeTranscript,
        expectRecovery,
        loadSessionEntry,
      } = getFixture();
      const sessionsDir = await makeSessionsDir();
      const storePath = path.join(sessionsDir, "sessions.json");
      const sessionKey = "agent:main:main";
      const entry = mainSessionEntry(
        source !== "delegated"
          ? {
              restartRecoverySourceIngress: "internal",
              pendingFinalDelivery: {
                kind: "replayable",
                text: "Prepared internal reply",
                createdAt: Date.now(),
                intentId: "unverified-final",
                deliveries: [{ id: "unverified-delivery", state: "prepared" }],
              },
            }
          : {},
      );
      await writeStore(sessionsDir, { [sessionKey]: entry });
      await writeTranscript(sessionsDir, entry.sessionId, [
        ...(source === "delegated"
          ? [
              {
                role: "user",
                content: "Read the delegated status",
                provenance: { kind: "inter_session", sourceTool: "sessions_send" },
              },
            ]
          : source === "internal system"
            ? [
                {
                  role: "user",
                  content: "Continue an internal task",
                  provenance: { kind: "internal_system", sourceTool: "unverified_internal_task" },
                },
              ]
            : []),
        ...Array.from({ length: source === "delegated" ? 80 : 0 }, (_, index) => ({
          role: "assistant",
          content: `Progress ${index}`,
        })),
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "status-1", name: "session_status" }],
        },
      ]);
      await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 1 });
      expect(callGateway).not.toHaveBeenCalled();
      expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({
        abortedLastRun: false,
        mainRestartRecovery: { tombstone: expect.any(Object) },
      });
      await expectRecovery({ started: 0, settled: 0, failed: 0, skipped: 0 });
      expect(callGateway).not.toHaveBeenCalled();
    },
  );

  it("resumes an explicit human run despite stale completion provenance", async () => {
    const {
      makeSessionsDir,
      writeStore,
      writeTranscript,
      expectRecovery,
      runningSessionEntry,
      gatewayParams,
    } = getFixture();
    const sessionsDir = await makeSessionsDir();
    const sessionKey = "agent:main:telegram:group:-100:topic:41818";
    await writeStore(sessionsDir, {
      [sessionKey]: {
        ...runningSessionEntry("topic-41818-session"),
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "human-run-2", lifecycleGeneration: "generation-old" }],
      },
    });
    await writeTranscript(sessionsDir, "topic-41818-session", [
      {
        role: "user",
        content: "A background task finished.",
        provenance: {
          kind: "inter_session",
          sourceSessionKey: "agent:main:subagent:child",
          sourceChannel: "internal",
          sourceTool: "subagent_announce",
        },
      },
      { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "exec" }] },
      { role: "toolResult", content: "done" },
    ]);

    await expectRecovery({ started: 1, settled: 0, failed: 0, skipped: 0 });
    expect(callGateway).toHaveBeenCalledOnce();
    expect(gatewayParams().sessionKey).toBe(sessionKey);
  });
}
