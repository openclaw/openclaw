import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hasCurrentAcpSourceTurn } from "../../config/sessions/acp-source-turn-state.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRecoveryRuntimeFixture } from "./main-session-recovery-runtime.test-support.js";
import { interruptAcpSourceTurnWithNotice } from "./main-session-restart-recovery-failure.js";
import { recoverRestartAbortedMainSessions } from "./main-session-restart-recovery.js";

const transcriptMocks = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscript: vi.fn(),
}));

vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementation(
    actual.appendAssistantMessageToSessionTranscript,
  );
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript:
      transcriptMocks.appendAssistantMessageToSessionTranscript,
  };
});

afterEach(() => {
  resetGatewayWorkAdmission();
  transcriptMocks.appendAssistantMessageToSessionTranscript.mockClear();
});

it.each(["activeWriterRunId", "lifecycleRunId"] as const)(
  "leaves a superseded ACP source untouched when %s changes before its interruption write",
  async (field) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:webchat:acp-superseded",
        sessionId: "acp-superseded-source",
        storePath: path.join(state.sessionsDir("main"), "sessions.json"),
      };
      const entry: InternalSessionEntry = {
        sessionId: scope.sessionId,
        updatedAt: 1,
        permissionMode: "guarded",
        abortedLastRun: true,
        activeWriterRunId: "acp-run",
        lifecycleRunId: "acp-run",
        acpSourceTurn: {
          sourceSessionId: scope.sessionId,
          sourceLifecycleRevision: undefined,
          runId: "acp-run",
          targetAgentId: "main",
          targetSessionKey: "agent:main:acp:target",
          targetSessionId: "acp-target",
        },
      };
      await replaceSessionEntry(scope, entry);
      await appendTranscriptMessage(scope, { message: { role: "user", content: "ACP request" } });
      const persistedEntry = loadSessionEntry(scope);
      if (!persistedEntry || !hasCurrentAcpSourceTurn(persistedEntry)) {
        throw new Error(
          "ACP recovery fixture must retain its current persisted source incarnation",
        );
      }
      const beforeEvents = await loadTranscriptEvents(scope);
      const replacement = { ...persistedEntry, [field]: "replacement-run" };
      const appendNotice =
        transcriptMocks.appendAssistantMessageToSessionTranscript.getMockImplementation();
      if (!appendNotice) {
        throw new Error(
          "ACP recovery fixture is missing the real transcript append implementation",
        );
      }
      transcriptMocks.appendAssistantMessageToSessionTranscript.mockImplementationOnce(
        async (...args) => {
          const replaced = await replaceSessionEntry(scope, replacement);
          if (
            !replaced ||
            replaced.sessionId !== persistedEntry.sessionId ||
            replaced.lifecycleRevision !== persistedEntry.lifecycleRevision
          ) {
            throw new Error("ACP recovery fixture replacement changed its source incarnation");
          }
          return appendNotice(...args);
        },
      );
      const sendRecoveryNotice = vi.fn(async () => ({ suppressed: false }));
      const callGateway = vi.fn(async (): Promise<never> => {
        throw new Error("Native dispatch must not run for an ACP-owned source.");
      });
      const gatewayRuntime = createRecoveryRuntimeFixture({
        callGateway,
        getDispatchSettlement: () => Promise.resolve(),
        sendRecoveryNotice,
      });

      await expect(
        interruptAcpSourceTurnWithNotice({ ...scope, entry: persistedEntry, gatewayRuntime }),
      ).resolves.toBe("skipped");

      expect(transcriptMocks.appendAssistantMessageToSessionTranscript).toHaveBeenCalledOnce();
      expect(loadSessionEntry(scope)).toMatchObject(replacement);
      expect(await loadTranscriptEvents(scope)).toEqual(beforeEvents);
      expect(callGateway).not.toHaveBeenCalled();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    });
  },
);

it("keeps scanning ACP sources after interruption-notice persistence rejects", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = path.join(state.sessionsDir("main"), "sessions.json");
    const firstKey = "agent:main:webchat:acp-a";
    const nextKey = "agent:main:webchat:acp-b";
    const sources = [firstKey, nextKey].map((sessionKey, index) => {
      const sessionId = `acp-source-${index}`;
      const runId = `acp-run-${index}`;
      return {
        sessionKey,
        entry: {
          sessionId,
          permissionMode: "guarded",
          updatedAt: Date.now() - 10_000,
          abortedLastRun: true,
          activeWriterRunId: runId,
          lifecycleRunId: runId,
          acpSourceTurn: {
            sourceSessionId: sessionId,
            sourceLifecycleRevision: undefined,
            runId,
            targetAgentId: "main",
            targetSessionKey: "agent:main:acp:target",
            targetSessionId: "acp-target",
          },
        } satisfies InternalSessionEntry,
      };
    });
    for (const { sessionKey, entry } of sources) {
      await replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry);
      await appendTranscriptMessage(
        { agentId: "main", sessionKey, sessionId: entry.sessionId, storePath },
        { cwd: state.workspaceDir, message: { role: "user", content: "finish this ACP request" } },
      );
    }
    const callGateway = vi.fn(async (): Promise<never> => {
      throw new Error("Native dispatch must not run for an ACP-owned source.");
    });
    const gatewayRuntime = createRecoveryRuntimeFixture({
      callGateway,
      getDispatchSettlement: () => Promise.resolve(),
      sendRecoveryNotice: vi.fn(async () => ({ suppressed: false })),
    });
    const recover = () =>
      recoverRestartAbortedMainSessions({ stateDir: state.stateDir, cfg: {}, gatewayRuntime });
    transcriptMocks.appendAssistantMessageToSessionTranscript.mockRejectedValueOnce(
      new Error("ACP notice SQLite write failed"),
    );

    await expect(recover()).resolves.toEqual({ started: 0, settled: 1, failed: 1, skipped: 0 });
    expect(
      transcriptMocks.appendAssistantMessageToSessionTranscript.mock.calls[0]?.[0],
    ).toMatchObject({ sessionKey: firstKey });
    expect(loadSessionEntry({ sessionKey: firstKey, storePath })).toMatchObject({
      activeWriterRunId: "acp-run-0",
      lifecycleRunId: "acp-run-0",
      acpSourceTurn: { runId: "acp-run-0" },
    });
    expect(loadSessionEntry({ sessionKey: nextKey, storePath })).toMatchObject({
      status: "killed",
      abortedLastRun: false,
    });
    expect(loadSessionEntry({ sessionKey: nextKey, storePath })?.acpSourceTurn).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: nextKey, storePath })?.activeWriterRunId).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: nextKey, storePath })?.lifecycleRunId).toBeUndefined();
    expect(callGateway).not.toHaveBeenCalled();

    await expect(recover()).resolves.toEqual({ started: 0, settled: 1, failed: 0, skipped: 0 });
    expect(loadSessionEntry({ sessionKey: firstKey, storePath })?.acpSourceTurn).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey: firstKey, storePath })?.activeWriterRunId,
    ).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: firstKey, storePath })?.lifecycleRunId).toBeUndefined();
    expect(callGateway).not.toHaveBeenCalled();
    for (const { entry, sessionKey } of sources) {
      const events = await loadTranscriptEvents({
        agentId: "main",
        sessionId: entry.sessionId,
        sessionKey,
        storePath,
      });
      expect(
        events.filter((event) => {
          const record = event as { message?: { idempotencyKey?: unknown } };
          return (
            record.message?.idempotencyKey ===
            `acp-source-restart:${entry.acpSourceTurn.runId}:interrupted`
          );
        }),
      ).toHaveLength(1);
    }
  });
});
