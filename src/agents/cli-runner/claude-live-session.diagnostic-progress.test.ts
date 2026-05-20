import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { supervisorSpawnMock } from "../cli-runner.test-support.js";
import { resetClaudeLiveSessionsForTest, runClaudeLiveSessionTurn } from "./claude-live-session.js";
import type { PreparedCliRunContext } from "./types.js";

type SupervisorSpawnFn = ReturnType<typeof getProcessSupervisor>["spawn"];

function buildClaudeLiveContext(): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    output: "jsonl" as const,
    input: "stdin" as const,
    sessionArg: "--session-id",
    sessionMode: "always" as const,
    serialize: true,
    liveSession: "claude-stdio" as const,
  };
  return {
    params: {
      sessionId: "live-diag-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      timeoutMs: 60_000,
      runId: "live-diag-run",
      sessionKey: "agent:main:main",
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: {
      id: "claude-cli",
      config: backend,
      bundleMcp: true,
      pluginId: "anthropic",
    },
    preparedBackend: { backend, env: {} },
    reusableCliSession: {},
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "claude-opus-4-7",
    normalizedModel: "claude-opus-4-7",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  resetClaudeLiveSessionsForTest();
  supervisorSpawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runClaudeLiveSessionTurn emits run.progress on raw stdout (covers thinking_delta)", () => {
  it("fires cli:live:stdout even when only thinking_delta lines arrive (no text_delta, no onAssistantDelta)", async () => {
    const captured: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        captured.push(event);
      }
    });
    const assistantDeltas: string[] = [];

    let nowValue = 5_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValue);

    let stdoutListener: ((chunk: string) => void) | undefined;
    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as Parameters<SupervisorSpawnFn>[0];
      stdoutListener = input.onStdout;
      return {
        runId: "supervisor-run-1",
        pid: 4242,
        startedAtMs: Date.now(),
        stdin: {
          write: vi.fn((_data: string, cb?: (err?: Error | null) => void) => {
            // thinking_delta line — parser will not invoke onAssistantDelta
            stdoutListener?.(
              `${JSON.stringify({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "thinking_delta", thinking: "let me think..." },
                },
              })}\n`,
            );
            // 3s later — throttled, no second progress event
            nowValue = 5_003_000;
            stdoutListener?.(
              `${JSON.stringify({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "thinking_delta", thinking: "...still thinking" },
                },
              })}\n`,
            );
            // 11s later — past throttle, second progress event fires
            nowValue = 5_011_000;
            stdoutListener?.(
              `${JSON.stringify({
                type: "stream_event",
                event: {
                  type: "content_block_delta",
                  delta: { type: "thinking_delta", thinking: "...done thinking" },
                },
              })}\n`,
            );
            // Now the result line so the turn resolves
            nowValue = 5_011_500;
            stdoutListener?.(
              `${JSON.stringify({
                type: "result",
                session_id: "live-diag-session",
                result: "done",
              })}\n`,
            );
            cb?.();
          }),
          end: vi.fn(),
        },
        wait: vi.fn(() => new Promise(() => {})),
        cancel: vi.fn(),
      };
    });

    try {
      await runClaudeLiveSessionTurn({
        context: buildClaudeLiveContext(),
        args: ["-p", "--output-format", "stream-json"],
        env: {},
        prompt: "hi",
        useResume: false,
        noOutputTimeoutMs: 60_000,
        getProcessSupervisor: () => ({
          spawn: (params: Parameters<SupervisorSpawnFn>[0]) =>
            supervisorSpawnMock(params) as ReturnType<SupervisorSpawnFn>,
          cancel: vi.fn(),
          cancelScope: vi.fn(),
          reconcileOrphans: vi.fn(),
          getRecord: vi.fn(),
        }),
        onAssistantDelta: (delta) => {
          assistantDeltas.push(delta.delta);
        },
        cleanup: async () => {},
      });
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
      nowSpy.mockRestore();
    }

    const liveStdoutEvents = captured.filter(
      (event) => event.type === "run.progress" && event.reason === "cli:live:stdout",
    );
    // 4 stdout chunks across 0s/3s/11s/11.5s: chunk at 0s emits, 3s throttled,
    // 11s emits (second), 11.5s throttled. So expect exactly 2.
    expect(liveStdoutEvents.length).toBe(2);
    for (const event of liveStdoutEvents) {
      if (event.type !== "run.progress") {
        continue;
      }
      expect(event.runId).toBe("live-diag-run");
      expect(event.sessionId).toBe("live-diag-session");
      expect(event.sessionKey).toBe("agent:main:main");
    }
    // Critical: text-delta parser path was NEVER invoked, so onAssistantDelta did NOT fire.
    // This proves the stdout-level emission is strictly more inclusive than onAssistantDelta —
    // it covers reasoning-only turns that the prior commit's hook would miss.
    expect(assistantDeltas).toEqual([]);
  });
});
