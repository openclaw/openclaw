import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { getProcessSupervisor } from "../../process/supervisor/index.js";
import type { CliStreamingDelta } from "../cli-output.js";
import { resetClaudeLiveSessionsForTest, runClaudeLiveSessionTurn } from "./claude-live-session.js";
import { cliBackendLog } from "./log.js";
import type { PreparedCliRunContext } from "./types.js";

type ProcessSupervisor = ReturnType<typeof getProcessSupervisor>;
type SupervisorSpawnFn = ProcessSupervisor["spawn"];
type StdoutListener = (chunk: string) => void;

function buildContext(params: {
  runId: string;
  prompt: string;
  sessionId?: string;
}): PreparedCliRunContext {
  const backend = {
    command: "claude",
    args: ["-p", "--output-format", "stream-json"],
    output: "jsonl" as const,
    input: "stdin" as const,
    modelArg: "--model",
    sessionArg: "--session-id",
    sessionMode: "always" as const,
    systemPromptFileArg: "--append-system-prompt-file",
    systemPromptWhen: "first" as const,
    serialize: true,
    liveSession: "claude-stdio" as const,
  };
  return {
    params: {
      sessionId: params.sessionId ?? "orphan-session",
      sessionFile: "/tmp/orphan-session.jsonl",
      workspaceDir: "/tmp",
      prompt: params.prompt,
      provider: "claude-cli",
      model: "sonnet",
      timeoutMs: 60_000,
      runId: params.runId,
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
    modelId: "sonnet",
    normalizedModel: "sonnet",
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 2,
  };
}

function buildStdin(onWrite: (data: string) => void) {
  return {
    write: vi.fn((data: string, cb?: (err?: Error | null) => void) => {
      onWrite(data);
      cb?.();
      return true;
    }),
    end: vi.fn(),
  };
}

function createSpawnHarness() {
  let stdoutListener: StdoutListener | undefined;
  const stdin = buildStdin((data) => {
    // Default: echo a result line so the turn resolves quickly. Tests can
    // overwrite stdoutListener to inject orphan content after the turn ends.
    const session_id = "orphan-session";
    stdoutListener?.(
      `${JSON.stringify({ type: "system", subtype: "init", session_id })}\n` +
        `${JSON.stringify({ type: "result", session_id, result: data.length > 0 ? "ok" : "empty" })}\n`,
    );
  });
  const spawnImpl: SupervisorSpawnFn = (async (...args: unknown[]) => {
    const input = (args[0] ?? {}) as { onStdout?: StdoutListener };
    stdoutListener = input.onStdout;
    return {
      runId: "orphan-run",
      pid: 4242,
      startedAtMs: Date.now(),
      stdin,
      wait: vi.fn(() => new Promise(() => {})),
      cancel: vi.fn(),
    };
  }) as unknown as SupervisorSpawnFn;
  const supervisor: ProcessSupervisor = {
    spawn: spawnImpl,
    cancel: vi.fn(),
    cancelScope: vi.fn(),
    reconcileOrphans: vi.fn(),
    getRecord: vi.fn(),
  } as unknown as ProcessSupervisor;
  return {
    supervisor,
    stdin,
    pushOrphan: (line: string) => {
      if (!stdoutListener) {
        throw new Error("spawn has not initialised onStdout");
      }
      stdoutListener(`${line}\n`);
    },
  };
}

async function runTurnAndDrain(params: {
  supervisor: ProcessSupervisor;
  runId: string;
  prompt: string;
}) {
  const context = buildContext({ runId: params.runId, prompt: params.prompt });
  const result = await runClaudeLiveSessionTurn({
    context,
    args: context.preparedBackend.backend.args ?? [],
    env: {},
    prompt: params.prompt,
    useResume: false,
    noOutputTimeoutMs: 60_000,
    getProcessSupervisor: () => params.supervisor,
    onAssistantDelta: (_delta: CliStreamingDelta) => {},
    cleanup: async () => {},
  });
  return result;
}

beforeEach(() => {
  resetClaudeLiveSessionsForTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  resetClaudeLiveSessionsForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("claude live session orphan handling", () => {
  it("logs a rate-limited warning when stream-json arrives outside a turn", async () => {
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    const harness = createSpawnHarness();
    await runTurnAndDrain({
      supervisor: harness.supervisor,
      runId: "orphan-run-1",
      prompt: "first",
    });

    // Push three orphan lines in quick succession; only the first should log.
    harness.pushOrphan(JSON.stringify({ type: "assistant", message: { content: "hi" } }));
    harness.pushOrphan(JSON.stringify({ type: "assistant", message: { content: "again" } }));
    harness.pushOrphan(JSON.stringify({ type: "assistant", message: { content: "thrice" } }));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/orphan output/);
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/totalOrphanedLines=1$/);
  });

  it("does not warn for unparseable orphan lines", async () => {
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    const harness = createSpawnHarness();
    await runTurnAndDrain({
      supervisor: harness.supervisor,
      runId: "orphan-run-2",
      prompt: "second",
    });

    harness.pushOrphan("not-json");
    harness.pushOrphan("");
    harness.pushOrphan("    ");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("re-arms the warning after the throttle window elapses", async () => {
    // Start the clock well past the 30 s throttle window so the first orphan
    // line always logs. Initial lastOrphanLogAtMs is 0; elapsed must clear
    // CLAUDE_LIVE_ORPHAN_LOG_THROTTLE_MS for the first warn to fire.
    vi.useFakeTimers({ now: 1_000_000 });
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    const harness = createSpawnHarness();
    await runTurnAndDrain({
      supervisor: harness.supervisor,
      runId: "orphan-run-3",
      prompt: "third",
    });

    harness.pushOrphan(JSON.stringify({ type: "assistant" }));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Stay inside the throttle window — should still be a single warning.
    vi.setSystemTime(1_020_000);
    harness.pushOrphan(JSON.stringify({ type: "assistant" }));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Cross the 30 s boundary — next orphan re-arms.
    vi.setSystemTime(1_031_000);
    harness.pushOrphan(JSON.stringify({ type: "assistant" }));
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1]?.[0]).toMatch(/totalOrphanedLines=3$/);
  });

  it("re-arms the warning when the wall clock jumps backwards", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    const harness = createSpawnHarness();
    await runTurnAndDrain({
      supervisor: harness.supervisor,
      runId: "orphan-run-4",
      prompt: "fourth",
    });

    harness.pushOrphan(JSON.stringify({ type: "assistant" }));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Simulate NTP stepping the clock backwards by 5 minutes. Without a
    // negative-elapsed branch, the throttle would silence the warning until
    // the next forward jump past lastOrphanLogAtMs + 30s.
    vi.setSystemTime(700_000);
    harness.pushOrphan(JSON.stringify({ type: "assistant" }));
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps the live session alive when orphan output bumps the idle timer", async () => {
    vi.useFakeTimers({ now: 0 });
    const warnSpy = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => {});
    const closeListener = vi.fn();
    const originalCloseInfo = cliBackendLog.info.bind(cliBackendLog);
    vi.spyOn(cliBackendLog, "info").mockImplementation((message: unknown, ...rest: unknown[]) => {
      if (typeof message === "string" && /claude live session close/.test(message)) {
        closeListener(message);
      }
      return originalCloseInfo(message, ...rest);
    });

    const harness = createSpawnHarness();
    await runTurnAndDrain({
      supervisor: harness.supervisor,
      runId: "orphan-run-5",
      prompt: "fifth",
    });

    // Advance most of the way through the 10-minute idle window, then push an
    // orphan line to defer the timer. The session must NOT close at the
    // original deadline.
    vi.setSystemTime(9 * 60_000);
    await vi.advanceTimersByTimeAsync(0);
    harness.pushOrphan(JSON.stringify({ type: "assistant", message: { content: "alive" } }));

    vi.setSystemTime(10 * 60_000 + 5_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(closeListener).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    // After another full idle window with no further orphan activity, the
    // timer fires normally.
    vi.setSystemTime(20 * 60_000 + 5_000);
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(closeListener).toHaveBeenCalled();
  });
});
