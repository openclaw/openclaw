import { beforeEach, describe, expect, it, vi } from "vitest";
import { setupClaudeCliRunnerTestModule, supervisorSpawnMock } from "./cli-runner.test-support.js";

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    promise,
    resolve: resolve as (value: T) => void,
    reject: reject as (error: unknown) => void,
  };
}

function createManagedRun(
  exit: Promise<{
    reason: "exit" | "overall-timeout" | "no-output-timeout" | "signal" | "manual-cancel";
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    durationMs: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    noOutputTimedOut: boolean;
  }>,
) {
  return {
    runId: "run-test",
    pid: 12345,
    startedAtMs: Date.now(),
    wait: async () => await exit,
    cancel: vi.fn(),
  };
}

let runClaudeCliAgent: typeof import("./claude-cli-runner.js").runClaudeCliAgent;

async function loadFreshClaudeCliRunnerModuleForTest() {
  runClaudeCliAgent = await setupClaudeCliRunnerTestModule();
}

function successExit(payload: { message: string; session_id: string }) {
  return {
    reason: "exit" as const,
    exitCode: 0,
    exitSignal: null,
    durationMs: 1,
    stdout: JSON.stringify(payload),
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
  };
}

async function waitForCalls(mockFn: { mock: { calls: unknown[][] } }, count: number) {
  await vi.waitFor(
    () => {
      expect(mockFn.mock.calls.length).toBeGreaterThanOrEqual(count);
    },
    { timeout: 2_000, interval: 5 },
  );
}

describe("runClaudeCliAgent", () => {
  beforeEach(async () => {
    await loadFreshClaudeCliRunnerModuleForTest();
    supervisorSpawnMock.mockClear();
  });

  it("starts a new session with --session-id when none is provided", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun(Promise.resolve(successExit({ message: "ok", session_id: "sid-1" }))),
    );

    await runClaudeCliAgent({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    const spawnInput = supervisorSpawnMock.mock.calls[0]?.[0] as { argv: string[]; mode: string };
    expect(spawnInput.mode).toBe("child");
    expect(spawnInput.argv).toContain("claude");
    expect(spawnInput.argv).toContain("--session-id");
    expect(spawnInput.argv).toContain("hi");
  });

  it("starts fresh when only a legacy claude session id is provided", async () => {
    supervisorSpawnMock.mockResolvedValueOnce(
      createManagedRun(Promise.resolve(successExit({ message: "ok", session_id: "sid-2" }))),
    );

    await runClaudeCliAgent({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-2",
      claudeSessionId: "c9d7b831-1c31-4d22-80b9-1e50ca207d4b",
    });

    expect(supervisorSpawnMock).toHaveBeenCalledTimes(1);
    const spawnInput = supervisorSpawnMock.mock.calls[0]?.[0] as { argv: string[] };
    expect(spawnInput.argv).not.toContain("--resume");
    expect(spawnInput.argv).not.toContain("c9d7b831-1c31-4d22-80b9-1e50ca207d4b");
    expect(spawnInput.argv).toContain("--session-id");
    expect(spawnInput.argv).toContain("hi");
  });

  it("serializes concurrent claude-cli runs in the same workspace", async () => {
    const firstDeferred = createDeferred<ReturnType<typeof successExit>>();
    const secondDeferred = createDeferred<ReturnType<typeof successExit>>();

    supervisorSpawnMock
      .mockResolvedValueOnce(createManagedRun(firstDeferred.promise))
      .mockResolvedValueOnce(createManagedRun(secondDeferred.promise));

    const firstRun = runClaudeCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "first",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    const secondRun = runClaudeCliAgent({
      sessionId: "s2",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "second",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-2",
    });

    await waitForCalls(supervisorSpawnMock, 1);

    firstDeferred.resolve(successExit({ message: "ok", session_id: "sid-1" }));

    await waitForCalls(supervisorSpawnMock, 2);

    secondDeferred.resolve(successExit({ message: "ok", session_id: "sid-2" }));

    await Promise.all([firstRun, secondRun]);
  });

  it("allows concurrent claude-cli runs across different workspaces", async () => {
    const firstDeferred = createDeferred<ReturnType<typeof successExit>>();
    const secondDeferred = createDeferred<ReturnType<typeof successExit>>();

    supervisorSpawnMock
      .mockResolvedValueOnce(createManagedRun(firstDeferred.promise))
      .mockResolvedValueOnce(createManagedRun(secondDeferred.promise));

    const firstRun = runClaudeCliAgent({
      sessionId: "s1",
      sessionFile: "/tmp/session-1.jsonl",
      workspaceDir: "/tmp/project-a",
      prompt: "first",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-a",
    });

    const secondRun = runClaudeCliAgent({
      sessionId: "s2",
      sessionFile: "/tmp/session-2.jsonl",
      workspaceDir: "/tmp/project-b",
      prompt: "second",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-b",
    });

    await waitForCalls(supervisorSpawnMock, 2);

    firstDeferred.resolve(successExit({ message: "ok", session_id: "sid-a" }));
    secondDeferred.resolve(successExit({ message: "ok", session_id: "sid-b" }));

    await Promise.all([firstRun, secondRun]);
  });
});
