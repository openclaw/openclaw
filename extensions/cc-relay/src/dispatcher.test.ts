import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CcRelayDispatcher } from "./dispatcher.js";
import type { CcRelayConfig } from "./config.js";

// Mock the worker module to avoid actually spawning Claude Code
vi.mock("./worker.js", () => ({
  runCcWorker: vi.fn().mockResolvedValue({
    exitCode: 0,
    resultText: "Task completed successfully.",
    newFiles: [],
    durationMs: 1500,
  }),
}));

describe("CcRelayDispatcher", () => {
  const baseConfig: CcRelayConfig = {
    claudeBin: "claude",
    workdir: "/tmp/test-workspace",
    runAsUser: "",
    permissionMode: "default",
    model: "claude-opus-4-6",
    timeoutSeconds: 60,
    progressIntervalSeconds: 0, // Disable progress for tests
    maxResultChars: 4000,
    maxAttachments: 10,
    maxAttachmentBytes: 10 * 1024 * 1024,
  };

  let sentMessages: Array<{ channel: string; target: string; text: string }>;
  let sentFiles: Array<{ channel: string; target: string; filePath: string; fileName: string }>;
  let completedJobs: Array<{ jobId: string; exitCode: number }>;

  function createDispatcher(configOverrides?: Partial<CcRelayConfig>): CcRelayDispatcher {
    return new CcRelayDispatcher({ ...baseConfig, ...configOverrides }, {
      sendMessage: async (channel, target, text) => {
        sentMessages.push({ channel, target, text });
      },
      sendFile: async (channel, target, filePath, fileName) => {
        sentFiles.push({ channel, target, filePath, fileName });
      },
      onComplete: (job, result) => {
        completedJobs.push({ jobId: job.id, exitCode: result.exitCode });
      },
    });
  }

  beforeEach(() => {
    sentMessages = [];
    sentFiles = [];
    completedJobs = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a job and returns immediately", () => {
    const dispatcher = createDispatcher();
    const job = dispatcher.dispatch({
      prompt: "Hello world",
      taskName: "test",
      channel: "feishu",
      target: "group123",
    });

    expect(job.id).toBeTruthy();
    expect(job.taskName).toBe("test");
    expect(job.prompt).toBe("Hello world");
    expect(job.status).toBe("queued");
    expect(job.fresh).toBe(false);
  });

  it("supports fresh session flag", () => {
    const dispatcher = createDispatcher();
    const job = dispatcher.dispatch({
      prompt: "Start fresh",
      channel: "discord",
      target: "ch456",
      fresh: true,
    });

    expect(job.fresh).toBe(true);
  });

  it("processes jobs and delivers results", async () => {
    const dispatcher = createDispatcher();
    dispatcher.dispatch({
      prompt: "Do something",
      taskName: "work",
      channel: "feishu",
      target: "group123",
    });

    // Wait for async processing
    await vi.waitFor(() => {
      expect(completedJobs).toHaveLength(1);
    });

    expect(completedJobs[0]!.exitCode).toBe(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.text).toBe("Task completed successfully.");
  });

  it("queues multiple jobs serially", async () => {
    const dispatcher = createDispatcher();
    dispatcher.dispatch({ prompt: "Task 1", channel: "feishu", target: "g1" });
    dispatcher.dispatch({ prompt: "Task 2", channel: "feishu", target: "g1" });

    await vi.waitFor(() => {
      expect(completedJobs).toHaveLength(2);
    });
  });

  it("stops cleanly", () => {
    const dispatcher = createDispatcher();
    dispatcher.dispatch({ prompt: "Will be cleared", channel: "feishu", target: "g1" });
    dispatcher.stop();
    expect(dispatcher.getQueue()).toHaveLength(0);
  });
});
