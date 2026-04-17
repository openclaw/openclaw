/**
 * A2A gateway handler tests, plugin-local.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createA2AGatewayHandlers } from "./gateway-handlers.js";

const mockBrokerClient = {
  requestTask: vi.fn(),
  updateTask: vi.fn(),
  cancelTask: vi.fn(),
  statusTask: vi.fn(),
};

describe("a2a gateway handlers (plugin-local)", () => {
  beforeEach(() => {
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
      taskId: "task-1",
      executionStatus: "running",
    });
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

  function createHandlers(
    createBrokerClient: () => typeof mockBrokerClient | null = () => mockBrokerClient,
  ) {
    return createA2AGatewayHandlers({} as never, {
      createBrokerClient: createBrokerClient as never,
    });
  }

  it("a2a.task.request delegates to broker client", async () => {
    const { handleA2ATaskRequest } = createHandlers();
    const opts = createHandlerOpts();
    opts.params = {
      sessionKey: "test-session",
      request: {
        method: "a2a.task.request",
        taskId: "task-1",
        task: { intent: "delegate", instructions: "do something" },
        target: { sessionKey: "target-session", displayKey: "target-node" },
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
    const { handleA2ATaskUpdate } = createHandlers();
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
    const { handleA2ATaskCancel } = createHandlers();
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
    const { handleA2ATaskStatus } = createHandlers();
    const opts = createHandlerOpts();
    opts.params = {
      sessionKey: "test-session",
      taskId: "task-1",
    };

    await handleA2ATaskStatus(opts as never);

    expect(mockBrokerClient.statusTask).toHaveBeenCalledTimes(1);
    expect(opts.respond).toHaveBeenCalledWith(true, expect.objectContaining({ taskId: "task-1" }));
  });

  it("returns error when broker client is not initialized", async () => {
    const { handleA2ATaskRequest } = createHandlers(() => null);
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
    const { handleA2ATaskRequest } = createHandlers();
    const opts = createHandlerOpts();
    opts.params = {};

    await handleA2ATaskRequest(opts as never);

    expect(opts.respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(mockBrokerClient.requestTask).not.toHaveBeenCalled();
  });

  it("initializes broker client lazily once and reuses it across handlers", async () => {
    const createBrokerClient = vi.fn().mockReturnValue(mockBrokerClient);
    const { handleA2ATaskRequest, handleA2ATaskCancel } = createHandlers(createBrokerClient);

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

    expect(createBrokerClient).toHaveBeenCalledTimes(1);
    expect(mockBrokerClient.requestTask).toHaveBeenCalledTimes(1);
    expect(mockBrokerClient.cancelTask).toHaveBeenCalledTimes(1);
  });
});
