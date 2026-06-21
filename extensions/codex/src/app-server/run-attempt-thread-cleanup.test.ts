// Codex tests cover run attempt thread cleanup plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resetAgentEventsForTest,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerRpcError } from "./client.js";
import type { CodexServerNotification } from "./protocol.js";
import { runCodexAppServerAttempt } from "./run-attempt.js";
import { createCodexTestBindingStore } from "./session-binding.test-helpers.js";
import {
  adaptCodexTestClientFactory,
  createCodexTestModel,
  type CodexTestAppServerClientFactory,
} from "./test-support.js";

const configRuntimeMock = vi.hoisted(() => ({ rejectedProvider: undefined as string | undefined }));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveCodexAppServerRuntime: (
      params: Parameters<typeof actual.resolveCodexAppServerRuntime>[0],
    ) => {
      if (
        configRuntimeMock.rejectedProvider &&
        params?.modelProvider === configRuntimeMock.rejectedProvider
      ) {
        throw new Error(`rejected active provider: ${params.modelProvider}`);
      }
      return actual.resolveCodexAppServerRuntime(params);
    },
  };
});

let tempDir: string;

function createParams(sessionFile: string, workspaceDir: string): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-1") {
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir || "/tmp/openclaw-codex-test",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4-codex",
    modelProvider: "openai",
    serviceTier: null,
    cwd: tempDir || "/tmp/openclaw-codex-test",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(turnId = "turn-1") {
  return {
    turn: {
      id: turnId,
      status: "inProgress",
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function getMockServerVersion() {
  return "0.132.0";
}

function getMockRuntimeIdentity() {
  return { serverVersion: getMockServerVersion() };
}

function mockClientRuntimeMethods() {
  return {
    getRuntimeIdentity: getMockRuntimeIdentity,
    getServerVersion: getMockServerVersion,
  };
}

describe("Codex app-server main thread cleanup", () => {
  beforeEach(async () => {
    vi.useRealTimers();
    resetAgentEventsForTest();
    vi.stubEnv("OPENCLAW_TRAJECTORY", "0");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    configRuntimeMock.rejectedProvider = undefined;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-run-cleanup-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetAgentEventsForTest();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("unsubscribes the main Codex thread after a completed turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const requests: Array<{ method: string; params: unknown }> = [];
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    });

    const clientFactory: CodexTestAppServerClientFactory = async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: (handler: (notification: CodexServerNotification) => void) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    };

    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
      bindingStore: createCodexTestBindingStore(),
      clientLeaseFactory: adaptCodexTestClientFactory(clientFactory),
    });
    await vi.waitFor(() => expect(requests.map((entry) => entry.method)).toContain("turn/start"), {
      interval: 1,
      timeout: 5_000,
    });
    for (const handler of notificationHandlers) {
      await handler({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed" },
        },
      });
    }

    const result = await run;
    expect(result.aborted).toBe(false);
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    expect(requests.map((entry) => entry.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
  });

  it("unsubscribes the main Codex thread when turn start fails", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const requests: Array<{ method: string; params: unknown }> = [];
    const request = vi.fn(async (method: string, params?: unknown) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return {};
    });

    const clientFactory: CodexTestAppServerClientFactory = async () => {
      return {
        ...mockClientRuntimeMethods(),
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
    };
    const abandon = vi.fn(async () => undefined);

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        bindingStore: createCodexTestBindingStore(),
        clientLeaseFactory: async () => ({
          client: await clientFactory(),
          release: () => undefined,
          abandon,
        }),
      }),
    ).rejects.toThrow("turn start exploded");
    expect(abandon).toHaveBeenCalledOnce();
    expect(requests.map((entry) => entry.method)).toEqual([
      "thread/start",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
  });

  it("releases startup ownership when authoritative provider policy rejects", async () => {
    const sessionFile = path.join(tempDir, "session-policy-rejection.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-policy-rejection");
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        const response = threadStartResult();
        return {
          ...response,
          thread: { ...response.thread, modelProvider: "lmstudio" },
          model: "local-model",
          modelProvider: "lmstudio",
        };
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const release = vi.fn();
    const abandon = vi.fn(async () => undefined);
    configRuntimeMock.rejectedProvider = "lmstudio";

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        bindingStore: createCodexTestBindingStore(),
        clientLeaseFactory: async () => ({
          client: {
            request,
            addNotificationHandler: () => () => undefined,
            addRequestHandler: () => () => undefined,
            addCloseHandler: () => () => undefined,
          } as never,
          release,
          abandon,
        }),
      }),
    ).rejects.toThrow("rejected active provider: lmstudio");

    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
    expect(release).toHaveBeenCalledOnce();
    expect(abandon).not.toHaveBeenCalled();
  });

  it("keeps the main client reusable after a structured turn rejection", async () => {
    const sessionFile = path.join(tempDir, "session-rpc-rejection.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-rpc-rejection");
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw new CodexAppServerRpcError({ code: -32000, message: "turn rejected" }, method);
      }
      return {};
    });
    const abandon = vi.fn(async () => undefined);

    await expect(
      runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        bindingStore: createCodexTestBindingStore(),
        clientLeaseFactory: async () => ({
          client: {
            request,
            addNotificationHandler: () => () => undefined,
            addRequestHandler: () => () => undefined,
            addCloseHandler: () => () => undefined,
          } as never,
          release: () => undefined,
          abandon,
        }),
      }),
    ).rejects.toThrow("turn rejected");

    expect(abandon).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      "thread/unsubscribe",
      { threadId: "thread-1" },
      { timeoutMs: 5_000 },
    );
  });

  it("reuses one client router after each attempt releases its thread route", async () => {
    const sessionFile = path.join(tempDir, "session-reused.jsonl");
    const workspaceDir = path.join(tempDir, "workspace-reused");
    const bindingStore = createCodexTestBindingStore();
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    const requestHandlers = new Set<(request: unknown) => unknown>();
    let turnIndex = 0;
    const request = vi.fn(async (method: string) => {
      if (method === "thread/start" || method === "thread/resume") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        turnIndex += 1;
        return turnStartResult(`turn-${turnIndex}`);
      }
      return {};
    });
    const addNotificationHandler = vi.fn(
      (handler: (notification: CodexServerNotification) => Promise<void> | void) => {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      },
    );
    const addRequestHandler = vi.fn((handler: (request: unknown) => unknown) => {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    });
    const client = {
      request,
      addNotificationHandler,
      addRequestHandler,
      addCloseHandler: () => () => undefined,
    };
    const clientFactory: CodexTestAppServerClientFactory = async () => client as never;

    const runAttempt = async (turnId: string, expectedTurnStartCount: number) => {
      const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), {
        bindingStore,
        clientLeaseFactory: adaptCodexTestClientFactory(clientFactory),
      });
      await vi.waitFor(
        () =>
          expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(
            expectedTurnStartCount,
          ),
        { interval: 1, timeout: 5_000 },
      );
      for (const handler of notificationHandlers) {
        void handler({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turnId,
            turn: { id: turnId, threadId: "thread-1", status: "completed" },
          },
        });
      }
      return await run;
    };

    await expect(runAttempt("turn-1", 1)).resolves.toMatchObject({ aborted: false });
    const notificationHandlerCount = addNotificationHandler.mock.calls.length;
    const requestHandlerCount = addRequestHandler.mock.calls.length;
    await expect(runAttempt("turn-2", 2)).resolves.toMatchObject({ aborted: false });

    expect(addNotificationHandler).toHaveBeenCalledTimes(notificationHandlerCount);
    expect(addRequestHandler).toHaveBeenCalledTimes(requestHandlerCount);
    expect(notificationHandlers.size).toBe(notificationHandlerCount);
    expect(requestHandlers.size).toBe(requestHandlerCount);
  });
});
