import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification } from "./protocol.js";
import { resetCodexRateLimitCacheForTests } from "./rate-limit-cache.js";
import { createCodexTestModel } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  createIsolatedCodexAppServerClientMock: vi.fn(),
  clearSharedCodexAppServerClientIfCurrentMock: vi.fn(),
}));

vi.mock("./shared-client.js", async () => {
  const actual =
    await vi.importActual<typeof import("./shared-client.js")>("./shared-client.js");
  return {
    ...actual,
    createIsolatedCodexAppServerClient: (...args: unknown[]) =>
      sharedClientMocks.createIsolatedCodexAppServerClientMock(...args),
    clearSharedCodexAppServerClientIfCurrent: (...args: unknown[]) =>
      sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock(...args),
  };
});

const { runCodexAppServerAttempt, __testing } = await import("./run-attempt.js");
const { resetAgentEventsForTest } = await import("openclaw/plugin-sdk/agent-harness-runtime");

let tempDir: string;

function createParams(
  sessionFile: string,
  workspaceDir: string,
  maxConcurrent?: number,
): EmbeddedRunAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-isolated-1",
    sessionKey: "agent:main:session-isolated-1",
    sessionFile,
    workspaceDir,
    runId: "run-isolated-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    thinkLevel: "medium",
    disableTools: true,
    timeoutMs: 5_000,
    authStorage: {} as never,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: {} as never,
    config:
      maxConcurrent === undefined
        ? undefined
        : ({ agents: { defaults: { maxConcurrent } } } as never),
  } as EmbeddedRunAttemptParams;
}

function threadStartResult(threadId = "thread-isolated") {
  return {
    threadId,
    sessionFile: "/tmp/codex-session.jsonl",
    initialMessages: [],
  } as const;
}

function turnStartResult(turnId = "turn-isolated", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
    },
  } as const;
}

describe("runCodexAppServerAttempt — agents.defaults.maxConcurrent isolation", () => {
  beforeEach(async () => {
    resetAgentEventsForTest();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-isolated-"));
    sharedClientMocks.createIsolatedCodexAppServerClientMock.mockReset();
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock.mockReset();
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    resetCodexRateLimitCacheForTests();
    resetGlobalHookRunner();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("uses an isolated app-server client when agents.defaults.maxConcurrent > 1 and closes it on completion", async () => {
    let notify: ((notification: CodexServerNotification) => Promise<void>) | undefined;
    const isolatedClient = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          return turnStartResult();
        }
        return {};
      }),
      addNotificationHandler: vi.fn((handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      close: vi.fn(),
    };

    sharedClientMocks.createIsolatedCodexAppServerClientMock.mockResolvedValue(isolatedClient);
    __testing.setCodexAppServerClientFactoryForTests(async () => {
      throw new Error("shared client should not be used when maxConcurrent > 1");
    });

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
      4,
    );

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
    await notify?.({
      method: "turn/completed",
      params: {
        threadId: "thread-isolated",
        turnId: "turn-isolated",
        turn: { id: "turn-isolated", status: "completed" },
      },
    });
    await expect(run).resolves.toMatchObject({ aborted: false, timedOut: false });

    expect(sharedClientMocks.createIsolatedCodexAppServerClientMock).toHaveBeenCalledTimes(1);
    expect(sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock).not.toHaveBeenCalled();
    expect(isolatedClient.close).toHaveBeenCalledTimes(1);
  });

  it("closes an isolated app-server client when turn start fails", async () => {
    const isolatedClient = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          throw new Error("turn/start failed");
        }
        return {};
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
      close: vi.fn(),
    };

    sharedClientMocks.createIsolatedCodexAppServerClientMock.mockResolvedValue(isolatedClient);
    __testing.setCodexAppServerClientFactoryForTests(async () => {
      throw new Error("shared client should not be used when maxConcurrent > 1");
    });

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
      4,
    );

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn/start failed");
    expect(sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock).not.toHaveBeenCalled();
    expect(isolatedClient.close).toHaveBeenCalledTimes(1);
  });

  it("falls back to the shared app-server client when agents.defaults.maxConcurrent === 1", async () => {
    let notify: ((notification: CodexServerNotification) => Promise<void>) | undefined;
    const sharedClient = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          return turnStartResult();
        }
        return {};
      }),
      addNotificationHandler: vi.fn((handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      close: vi.fn(),
    };

    __testing.setCodexAppServerClientFactoryForTests(async () => sharedClient as never);
    sharedClientMocks.createIsolatedCodexAppServerClientMock.mockImplementation(async () => {
      throw new Error("isolated client should not be used when maxConcurrent === 1");
    });

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
      1,
    );

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(notify).toBeTypeOf("function"));
    await notify?.({
      method: "turn/completed",
      params: {
        threadId: "thread-isolated",
        turnId: "turn-isolated",
        turn: { id: "turn-isolated", status: "completed" },
      },
    });
    await expect(run).resolves.toMatchObject({ aborted: false, timedOut: false });

    expect(sharedClientMocks.createIsolatedCodexAppServerClientMock).not.toHaveBeenCalled();
    expect(sharedClient.close).not.toHaveBeenCalled();
  });
});
