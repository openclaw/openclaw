import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ReplyBackendHandle,
  ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import type { CommandQueueEnqueueFn } from "../../process/command-queue.types.js";
import type { AgentRuntimeControlMessage } from "../runtime-backend.js";
import type { RunEmbeddedPiAgentParams } from "./run/params.js";
import type { EmbeddedPiRunResult } from "./types.js";

const decidePiRunWorkerLaunchMock = vi.hoisted(() => vi.fn());
const runPiRunInWorkerMock = vi.hoisted(() => vi.fn());

vi.mock("../harness/pi-run-worker-policy.js", () => ({
  decidePiRunWorkerLaunch: decidePiRunWorkerLaunchMock,
}));

vi.mock("../harness/pi-worker-runner.js", () => ({
  runPiRunInWorker: runPiRunInWorkerMock,
}));

const { runEmbeddedPiAgent } = await import("./run.js");

function makeParams(): RunEmbeddedPiAgentParams {
  return {
    agentId: "agent-1",
    config: {},
    model: "gpt-5.5",
    prompt: "hello",
    runId: "run-1",
    transcriptLocator: "/tmp/stale-session.jsonl",
    sessionId: "session-1",
    sessionKey: "session-key-1",
    timeoutMs: 1_000,
    workspaceDir: "/tmp/openclaw-workspace",
  };
}

function makeReplyOperation(): ReplyOperation {
  const controller = new AbortController();
  return {
    key: "reply-key-1",
    sessionId: "session-1",
    abortSignal: controller.signal,
    resetTriggered: false,
    phase: "running",
    result: null,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
    attachBackend: vi.fn(),
    detachBackend: vi.fn(),
    complete: vi.fn(),
    completeThen: vi.fn(),
    fail: vi.fn(),
    abortByUser: vi.fn(() => controller.abort(new Error("aborted by user"))),
    abortForRestart: vi.fn(() => controller.abort(new Error("aborted for restart"))),
  };
}

describe("runEmbeddedPiAgent worker launch", () => {
  beforeEach(() => {
    decidePiRunWorkerLaunchMock.mockReset();
    runPiRunInWorkerMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("dispatches through the PI worker runner when the run-level policy selects worker mode", async () => {
    const workerResult = {
      payloads: [{ text: "worker-ok" }],
      meta: { durationMs: 12 },
    } satisfies EmbeddedPiRunResult;
    decidePiRunWorkerLaunchMock.mockReturnValue({
      mode: "worker",
      reason: "requested",
    });
    runPiRunInWorkerMock.mockResolvedValue(workerResult);
    vi.stubEnv("OPENCLAW_AGENT_WORKER_MODE", "worker");
    vi.stubEnv("OPENCLAW_AGENT_WORKER_FILESYSTEM_MODE", "vfs-only");

    await expect(runEmbeddedPiAgent(makeParams())).resolves.toBe(workerResult);

    expect(decidePiRunWorkerLaunchMock).toHaveBeenCalledWith({
      runParams: expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "session-key-1",
        transcriptLocator: "sqlite-transcript://agent-1/session-1",
      }),
      mode: "worker",
      workerChild: false,
    });
    expect(runPiRunInWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        sessionId: "session-1",
        transcriptLocator: "sqlite-transcript://agent-1/session-1",
      }),
      {
        runtimeId: "pi",
        filesystemMode: "vfs-only",
        permissionMode: "enforce",
      },
    );
  });

  it("does not forward caller-provided filesystem transcript locators", async () => {
    const workerResult = {
      payloads: [{ text: "worker-ok" }],
      meta: { durationMs: 12 },
    } satisfies EmbeddedPiRunResult;
    decidePiRunWorkerLaunchMock.mockReturnValue({
      mode: "worker",
      reason: "requested",
    });
    runPiRunInWorkerMock.mockResolvedValue(workerResult);
    vi.stubEnv("OPENCLAW_AGENT_WORKER_MODE", "worker");

    await expect(
      runEmbeddedPiAgent({
        ...makeParams(),
        transcriptLocator: "/tmp/old-runtime-session.jsonl",
      }),
    ).resolves.toBe(workerResult);

    expect(runPiRunInWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptLocator: "sqlite-transcript://agent-1/session-1",
      }),
      expect.anything(),
    );
  });

  it("allows worker permission mode to be overridden", async () => {
    const workerResult = {
      payloads: [{ text: "permission-worker-ok" }],
      meta: { durationMs: 12 },
    } satisfies EmbeddedPiRunResult;
    decidePiRunWorkerLaunchMock.mockReturnValue({
      mode: "worker",
      reason: "requested",
    });
    runPiRunInWorkerMock.mockResolvedValue(workerResult);
    vi.stubEnv("OPENCLAW_AGENT_WORKER_MODE", "worker");
    vi.stubEnv("OPENCLAW_AGENT_WORKER_FILESYSTEM_MODE", "vfs-only");
    vi.stubEnv("OPENCLAW_AGENT_WORKER_PERMISSION_MODE", "audit");

    await expect(runEmbeddedPiAgent(makeParams())).resolves.toBe(workerResult);

    expect(runPiRunInWorkerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        filesystemMode: "vfs-only",
        permissionMode: "audit",
      }),
    );
  });

  it("dispatches through the PI worker runner in auto mode when the policy marks the run serializable", async () => {
    const workerResult = {
      payloads: [{ text: "auto-worker-ok" }],
      meta: { durationMs: 12 },
    } satisfies EmbeddedPiRunResult;
    decidePiRunWorkerLaunchMock.mockReturnValue({
      mode: "worker",
      reason: "serializable",
    });
    runPiRunInWorkerMock.mockResolvedValue(workerResult);
    vi.stubEnv("OPENCLAW_AGENT_WORKER_MODE", "auto");

    await expect(runEmbeddedPiAgent(makeParams())).resolves.toBe(workerResult);

    expect(decidePiRunWorkerLaunchMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "auto" }),
    );
    expect(runPiRunInWorkerMock).toHaveBeenCalledTimes(1);
  });

  it("keeps running inline when auto mode finds worker blockers", async () => {
    decidePiRunWorkerLaunchMock.mockReturnValue({
      mode: "inline",
      reason: "not_ready",
      blockers: [{ code: "unbridgeable_function", field: "customHook", message: "blocked" }],
    });
    vi.stubEnv("OPENCLAW_AGENT_WORKER_MODE", "auto");

    await expect(
      runEmbeddedPiAgent({
        ...makeParams(),
        enqueue: async () => {
          throw new Error("inline path");
        },
      }),
    ).rejects.toThrow("inline path");

    expect(runPiRunInWorkerMock).not.toHaveBeenCalled();
  });

  it("preserves parent queue wrapping around worker dispatch", async () => {
    const workerResult = {
      payloads: [{ text: "queued-worker-ok" }],
      meta: { durationMs: 12 },
    } satisfies EmbeddedPiRunResult;
    const queueTaskOptions: unknown[] = [];
    const enqueue: CommandQueueEnqueueFn = async (task, options) => {
      queueTaskOptions.push(options);
      return task();
    };
    decidePiRunWorkerLaunchMock.mockReturnValue({
      mode: "worker",
      reason: "requested",
    });
    runPiRunInWorkerMock.mockResolvedValue(workerResult);
    vi.stubEnv("OPENCLAW_AGENT_WORKER_MODE", "worker");

    await expect(runEmbeddedPiAgent({ ...makeParams(), enqueue })).resolves.toBe(workerResult);

    expect(queueTaskOptions).toHaveLength(2);
    expect(runPiRunInWorkerMock).toHaveBeenCalledTimes(1);
  });

  it("attaches a parent reply-operation backend while the worker runs", async () => {
    const workerResult = {
      payloads: [{ text: "reply-op-worker-ok" }],
      meta: { durationMs: 12 },
    } satisfies EmbeddedPiRunResult;
    const replyOperation = makeReplyOperation();
    let attachedBackend: ReplyBackendHandle | undefined;
    const controlMessages: unknown[] = [];
    vi.mocked(replyOperation.attachBackend).mockImplementation((backend: ReplyBackendHandle) => {
      attachedBackend = backend;
    });
    decidePiRunWorkerLaunchMock.mockReturnValue({
      mode: "worker",
      reason: "requested",
    });
    runPiRunInWorkerMock.mockImplementation(async (params: RunEmbeddedPiAgentParams, options) => {
      options?.onControlChannel?.({
        send: (message: AgentRuntimeControlMessage) => {
          controlMessages.push(message);
        },
      });
      expect(params.replyOperation).toBeUndefined();
      expect(params.abortSignal).toBeInstanceOf(AbortSignal);
      expect(attachedBackend?.isStreaming()).toBe(true);
      await attachedBackend?.queueMessage?.("steer this run");
      attachedBackend?.cancel("user_abort");
      expect(params.abortSignal?.aborted).toBe(true);
      return workerResult;
    });
    vi.stubEnv("OPENCLAW_AGENT_WORKER_MODE", "worker");

    await expect(runEmbeddedPiAgent({ ...makeParams(), replyOperation })).resolves.toBe(
      workerResult,
    );

    expect(vi.mocked(replyOperation.attachBackend)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(replyOperation.detachBackend)).toHaveBeenCalledWith(attachedBackend);
    expect(attachedBackend?.isStreaming()).toBe(false);
    expect(controlMessages).toEqual([
      { type: "queue_message", text: "steer this run" },
      { type: "cancel", reason: "user_abort" },
    ]);
  });
});
