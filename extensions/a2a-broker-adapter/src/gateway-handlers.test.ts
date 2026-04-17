/**
 * A2A gateway handler tests — plugin-local.
 * Migrated from src/gateway/server-methods/a2a.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockBrokerClient = {
  requestTask: vi.fn(),
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
  statusTask: vi.fn(),
};

let handleA2ATaskRequest: typeof import("./gateway-handlers.js").handleA2ATaskRequest;
let handleA2ATaskUpdate: typeof import("./gateway-handlers.js").handleA2ATaskUpdate;
let handleA2ATaskCancel: typeof import("./gateway-handlers.js").handleA2ATaskCancel;
let handleA2ATaskStatus: typeof import("./gateway-handlers.js").handleA2ATaskStatus;
let setBrokerClient: typeof import("./gateway-handlers.js").__setBrokerClientForTesting;

describe("a2a gateway handlers (plugin-local)", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockBrokerClient.requestTask.mockReset();
    mockBrokerClient.updateTask.mockReset();
    mockBrokerClient.cancelTask.mockReset();
    mockBrokerClient.statusTask.mockReset();

    mockBrokerClient.requestTask.mockResolvedValue({
      method: "a2a.task.request",
      taskId: "task-1",
    });
    mockBrokerClient.updateTask.mockResolvedValue({
      method: "a2a.task.update",
      taskId: "task-1",
    });
    mockBrokerClient.cancelTask.mockResolvedValue({
      method: "a2a.task.cancel",
      taskId: "task-1",
    });
    mockBrokerClient.statusTask.mockResolvedValue({
      method: "a2a.task.status",
      taskId: "task-1",
    });

    const mod = await import("./gateway-handlers.js");
    handleA2ATaskRequest = mod.handleA2ATaskRequest;
    handleA2ATaskUpdate = mod.handleA2ATaskUpdate;
    handleA2ATaskCancel = mod.handleA2ATaskCancel;
    handleA2ATaskStatus = mod.handleA2ATaskStatus;
    setBrokerClient = mod.__setBrokerClientForTesting;
    setBrokerClient(mockBrokerClient);
  });

  const createHandlerOpts = () => {
    const respond = vi.fn();
    const context = { logGateway: { error: vi.fn() } };
    return {
      req: { method: "test", id: "1" } as never,
      params: {},
      client: null,
      isWebchatConnect: vi.fn(),
      respond,
      context: context as never,
    };
  };

  it("a2a.task.request delegates to broker client", async () => {
    const opts = createHandlerOpts();
    opts.params = {
      sessionKey: "test-session",
      request: {
        method: "a2a.task.request",
        taskId: "task-1",
        task: { intent: "delegate", instructions: "do something" },
        target: { sessionKey: "target-session", displayKey: "target" },
      },
    };

    await handleA2ATaskRequest(opts as never);

    expect(mockBrokerClient.requestTask).toHaveBeenCalledTimes(1);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ method: "a2a.task.request" }),
    );
  });

  it("a2a.task.update delegates to broker client", async () => {
    const opts = createHandlerOpts();
    opts.params = {
      sessionKey: "test-session",
      update: {
        method: "a2a.task.update",
        taskId: "task-1",
        executionStatus: "completed",
      },
    };

    await handleA2ATaskUpdate(opts as never);

    expect(mockBrokerClient.updateTask).toHaveBeenCalledTimes(1);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ method: "a2a.task.update" }),
    );
  });

  it("a2a.task.cancel delegates to broker client", async () => {
    const opts = createHandlerOpts();
    opts.params = {
      sessionKey: "test-session",
      cancel: {
        method: "a2a.task.cancel",
        taskId: "task-1",
      },
    };

    await handleA2ATaskCancel(opts as never);

    expect(mockBrokerClient.cancelTask).toHaveBeenCalledTimes(1);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ method: "a2a.task.cancel" }),
    );
  });

  it("a2a.task.status delegates to broker client", async () => {
    const opts = createHandlerOpts();
    opts.params = {
      sessionKey: "test-session",
      taskId: "task-1",
    };

    await handleA2ATaskStatus(opts as never);

    expect(mockBrokerClient.statusTask).toHaveBeenCalledTimes(1);
    expect(opts.respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ method: "a2a.task.status" }),
    );
  });

  it("returns error when broker client is not initialized", async () => {
    setBrokerClient(null);
    const opts = createHandlerOpts();
    opts.params = {
      sessionKey: "test-session",
      request: {
        method: "a2a.task.request",
        taskId: "task-1",
        task: { intent: "delegate", instructions: "do something" },
        target: { sessionKey: "target-session", displayKey: "target" },
      },
    };

    await handleA2ATaskRequest(opts as never);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
  });

  it("returns validation error for invalid params", async () => {
    const opts = createHandlerOpts();
    opts.params = {}; // missing required fields

    await handleA2ATaskRequest(opts as never);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mockBrokerClient.requestTask).not.toHaveBeenCalled();
  });

  it("reuses single broker client across handlers", async () => {
    const requestOpts = createHandlerOpts();
    requestOpts.params = {
      sessionKey: "test-session",
      request: {
        method: "a2a.task.request",
        taskId: "task-1",
        task: { intent: "delegate", instructions: "do something" },
        target: { sessionKey: "target-session", displayKey: "target" },
      },
    };

    const cancelOpts = createHandlerOpts();
    cancelOpts.params = {
      sessionKey: "test-session",
      cancel: { method: "a2a.task.cancel", taskId: "task-1" },
    };

    await handleA2ATaskRequest(requestOpts as never);
    await handleA2ATaskCancel(cancelOpts as never);

    expect(mockBrokerClient.requestTask).toHaveBeenCalledTimes(1);
    expect(mockBrokerClient.cancelTask).toHaveBeenCalledTimes(1);
  });
});
