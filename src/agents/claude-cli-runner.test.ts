import { beforeEach, describe, expect, it, vi } from "vitest";
import { sleep } from "../utils.js";
import { runClaudeCliAgent } from "./claude-cli-runner.js";

const runCommandWithTimeoutMock = vi.fn();
const runCliWithStreamingMock = vi.fn();

function createDeferred<T>() {
  let resolve: (value: T) => void;
  let reject: (error: unknown) => void;
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

async function waitForCalls(mockFn: { mock: { calls: unknown[][] } }, count: number) {
  for (let i = 0; i < 50; i += 1) {
    if (mockFn.mock.calls.length >= count) {
      return;
    }
    await sleep(0);
  }
  throw new Error(`Expected ${count} calls, got ${mockFn.mock.calls.length}`);
}

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./cli-runner/streaming.js", () => ({
  runCliWithStreaming: (...args: unknown[]) => runCliWithStreamingMock(...args),
  mapCliStreamEvent: () => null,
}));

describe("runClaudeCliAgent", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    runCliWithStreamingMock.mockReset();
  });

  it("starts a new session with --session-id when none is provided", async () => {
    // Claude CLI now uses streaming by default
    runCliWithStreamingMock.mockResolvedValueOnce({
      text: "ok",
      sessionId: "sid-1",
      events: [],
    });

    await runClaudeCliAgent({
      sessionId: "openclaw-session",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      model: "opus",
      timeoutMs: 1_000,
      runId: "run-1",
    });

    expect(runCliWithStreamingMock).toHaveBeenCalledTimes(1);
    const callArgs = runCliWithStreamingMock.mock.calls[0]?.[0] as { args: string[] };
    expect(callArgs.args).toContain("--session-id");
  });

  it("uses --resume when a claude session id is provided", async () => {
    // Claude CLI now uses streaming by default
    runCliWithStreamingMock.mockResolvedValueOnce({
      text: "ok",
      sessionId: "sid-2",
      events: [],
    });

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

    expect(runCliWithStreamingMock).toHaveBeenCalledTimes(1);
    const callArgs = runCliWithStreamingMock.mock.calls[0]?.[0] as { args: string[] };
    expect(callArgs.args).toContain("--resume");
    expect(callArgs.args).toContain("c9d7b831-1c31-4d22-80b9-1e50ca207d4b");
  });

  it("serializes concurrent claude-cli runs", async () => {
    type StreamResult = { text: string; sessionId: string; events: unknown[] };
    const firstDeferred = createDeferred<StreamResult>();
    const secondDeferred = createDeferred<StreamResult>();

    runCliWithStreamingMock
      .mockImplementationOnce(() => firstDeferred.promise)
      .mockImplementationOnce(() => secondDeferred.promise);

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

    await waitForCalls(runCliWithStreamingMock, 1);

    firstDeferred.resolve({ text: "ok", sessionId: "sid-1", events: [] });

    await waitForCalls(runCliWithStreamingMock, 2);

    secondDeferred.resolve({ text: "ok", sessionId: "sid-2", events: [] });

    await Promise.all([firstRun, secondRun]);
  });
});
