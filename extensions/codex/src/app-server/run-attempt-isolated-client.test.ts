import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexServerNotification } from "./protocol.js";
import { resetCodexRateLimitCacheForTests } from "./rate-limit-cache.js";
import { createCodexTestModel } from "./test-support.js";

const sharedClientMocks = vi.hoisted(() => ({
  clearSharedCodexAppServerClientIfCurrentMock: vi.fn((_client: unknown): boolean => false),
}));

vi.mock("./shared-client.js", async () => {
  const actual = await vi.importActual<typeof import("./shared-client.js")>("./shared-client.js");
  return {
    ...actual,
    clearSharedCodexAppServerClientIfCurrent: (client: unknown): boolean =>
      sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock(client),
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
    thread: {
      id: threadId,
      forkedFromId: null,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: tempDir || "/tmp/openclaw-codex-isolated-test",
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
    cwd: tempDir || "/tmp/openclaw-codex-isolated-test",
    instructionSources: [],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(turnId = "turn-isolated", status = "inProgress") {
  return {
    turn: {
      id: turnId,
      status,
      items: [],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function buildClient(
  request: (method: string, params?: unknown) => Promise<unknown>,
  notifyRef: { current?: (notification: CodexServerNotification) => Promise<void> },
) {
  return {
    request: vi.fn(request),
    addNotificationHandler: vi.fn(
      (handler: (notification: CodexServerNotification) => Promise<void>) => {
        notifyRef.current = handler;
        return () => undefined;
      },
    ),
    addRequestHandler: vi.fn(() => () => undefined),
    close: vi.fn(),
  };
}

describe("runCodexAppServerAttempt — agents.defaults.maxConcurrent isolation", () => {
  beforeEach(async () => {
    resetAgentEventsForTest();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-isolated-"));
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock.mockReset();
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock.mockReturnValue(false);
  });

  afterEach(async () => {
    __testing.resetCodexAppServerClientFactoryForTests();
    resetCodexRateLimitCacheForTests();
    resetGlobalHookRunner();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("closes the per-run app-server client on completion when agents.defaults.maxConcurrent > 1", async () => {
    const notifyRef: {
      current?: (notification: CodexServerNotification) => Promise<void>;
    } = {};
    const client = buildClient(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    }, notifyRef);

    __testing.setCodexAppServerClientFactoryForTests(async () => client as never);

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
      4,
    );

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(notifyRef.current).toBeTypeOf("function"));
    await notifyRef.current?.({
      method: "turn/completed",
      params: {
        threadId: "thread-isolated",
        turnId: "turn-isolated",
        turn: { id: "turn-isolated", status: "completed" },
      },
    });
    await expect(run).resolves.toMatchObject({ aborted: false, timedOut: false });

    expect(sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("closes the per-run app-server client when turn start fails under maxConcurrent > 1", async () => {
    const notifyRef: {
      current?: (notification: CodexServerNotification) => Promise<void>;
    } = {};
    const client = buildClient(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        throw new Error("turn/start failed");
      }
      return {};
    }, notifyRef);

    __testing.setCodexAppServerClientFactoryForTests(async () => client as never);

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
      4,
    );

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn/start failed");
    expect(sharedClientMocks.clearSharedCodexAppServerClientIfCurrentMock).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the shared app-server client alive on completion when agents.defaults.maxConcurrent === 1", async () => {
    const notifyRef: {
      current?: (notification: CodexServerNotification) => Promise<void>;
    } = {};
    const client = buildClient(async (method) => {
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        return turnStartResult();
      }
      return {};
    }, notifyRef);

    __testing.setCodexAppServerClientFactoryForTests(async () => client as never);

    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
      1,
    );

    const run = runCodexAppServerAttempt(params);
    await vi.waitFor(() => expect(notifyRef.current).toBeTypeOf("function"));
    await notifyRef.current?.({
      method: "turn/completed",
      params: {
        threadId: "thread-isolated",
        turnId: "turn-isolated",
        turn: { id: "turn-isolated", status: "completed" },
      },
    });
    await expect(run).resolves.toMatchObject({ aborted: false, timedOut: false });

    expect(client.close).not.toHaveBeenCalled();
  });
});
