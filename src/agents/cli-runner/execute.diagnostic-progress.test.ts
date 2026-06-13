import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import { createManagedRun, supervisorSpawnMock } from "../cli-runner.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnInput = Parameters<ProcessSupervisor["spawn"]>[0];

function buildContext(): PreparedCliRunContext {
  const backend = {
    command: "agent-cli",
    args: [],
    output: "text" as const,
    input: "stdin" as const,
    serialize: true,
  };
  return {
    params: {
      sessionId: "diag-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "model",
      timeoutMs: 1_000,
      runId: "diag-run",
      sessionKey: "agent:main:main",
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false },
    preparedBackend: { backend, env: {} },
    reusableCliSession: {},
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "model",
    normalizedModel: "model",
    systemPrompt: "system",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

beforeEach(() => {
  resetAgentEventsForTest();
  resetDiagnosticEventsForTest();
  supervisorSpawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("executePreparedCliRun emits throttled run.progress diagnostic events", () => {
  it("emits cli:stdout run.progress on stdout chunks and throttles to ~10s", async () => {
    const captured: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress") {
        captured.push(event);
      }
    });

    let nowValue = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowValue);

    supervisorSpawnMock.mockImplementationOnce(async (...args: unknown[]) => {
      const input = args[0] as SupervisorSpawnInput;
      // First chunk -> should emit
      input.onStdout?.("chunk-1");
      // 3s later -> throttled, no emit
      nowValue = 1_003_000;
      input.onStdout?.("chunk-2");
      // 11s after first -> should emit again
      nowValue = 1_011_000;
      input.onStdout?.("chunk-3");
      return createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      });
    });

    try {
      await executePreparedCliRun(buildContext());
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
      nowSpy.mockRestore();
    }

    const cliStdoutEvents = captured.filter(
      (event) => event.type === "run.progress" && event.reason === "cli:stdout",
    );
    expect(cliStdoutEvents.length).toBe(2);
    for (const event of cliStdoutEvents) {
      if (event.type !== "run.progress") {
        continue;
      }
      expect(event.runId).toBe("diag-run");
      expect(event.sessionId).toBe("diag-session");
      expect(event.sessionKey).toBe("agent:main:main");
    }
  });

  it("does not emit run.progress when supervisor produces no stdout", async () => {
    const captured: DiagnosticEventPayload[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "run.progress" && event.reason === "cli:stdout") {
        captured.push(event);
      }
    });

    supervisorSpawnMock.mockImplementationOnce(async () =>
      createManagedRun({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        durationMs: 50,
        stdout: "",
        stderr: "",
        timedOut: false,
        noOutputTimedOut: false,
      }),
    );

    try {
      await executePreparedCliRun(buildContext());
      await waitForDiagnosticEventsDrained();
    } finally {
      unsubscribe();
    }

    expect(captured.length).toBe(0);
  });
});
