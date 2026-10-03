import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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

afterEach(() => resetGatewayWorkAdmission());

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
          status: "running",
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
      status: "running",
      activeWriterRunId: "acp-run-0",
      lifecycleRunId: "acp-run-0",
      acpSourceTurn: { runId: "acp-run-0" },
    });
    expect(loadSessionEntry({ sessionKey: nextKey, storePath })).toMatchObject({
      status: "interrupted",
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
