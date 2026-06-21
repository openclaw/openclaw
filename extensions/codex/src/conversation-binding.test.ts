// Codex tests cover conversation binding plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sharedClientMocks = vi.hoisted(() => ({
  abandonSharedCodexAppServerClient: vi.fn(async () => undefined),
  getSharedCodexAppServerClient: vi.fn(),
}));
const cleanupMocks = vi.hoisted(() => {
  const unsubscribeCodexThreadBestEffort = vi.fn(
    async (_client: unknown, _params: { threadId: string; timeoutMs: number }) => true,
  );
  const settleCodexAppServerClientLease = vi.fn(
    async (
      lease: { client: unknown; release: () => void; abandon: () => Promise<void> },
      params: {
        threadId?: string;
        threadIds?: Iterable<string>;
        timeoutMs: number;
        abandon?: boolean;
      },
    ) => {
      if (params.abandon) {
        await lease.abandon();
        return;
      }
      const threadIds = params.threadIds ?? (params.threadId ? [params.threadId] : []);
      for (const threadId of threadIds) {
        if (
          !(await unsubscribeCodexThreadBestEffort(lease.client, {
            threadId,
            timeoutMs: params.timeoutMs,
          }))
        ) {
          await lease.abandon();
          return;
        }
      }
      lease.release();
    },
  );
  return { settleCodexAppServerClientLease, unsubscribeCodexThreadBestEffort };
});

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovals: vi.fn<() => ExecApprovalsFile>(() => ({ version: 1, agents: {} })),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStore: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveAuthProfileOrder: vi.fn(),
  resolveAgentDir: vi.fn((_config: unknown, agentId: string) => `/agents/${agentId}/agent`),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string, _lookup?: { config?: unknown }) => provider),
  resolveSessionAgentIds: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  saveAuthProfileStore: vi.fn(),
}));

const codexRequirementsTomlMock = vi.hoisted(() => vi.fn<() => string | undefined>());
const resolveSandboxContextMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ enabled: boolean } | null>>(async () => null),
);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(filePath: string | URL | number, options?: BufferEncoding | object | null) {
      if (filePath === "/etc/codex/requirements.toml") {
        const content = codexRequirementsTomlMock();
        if (content !== undefined) {
          return content;
        }
      }
      return actual.readFileSync(filePath, options);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    resolveSandboxContext: resolveSandboxContextMock,
  };
});

vi.mock("./app-server/shared-client.js", () => ({
  ...sharedClientMocks,
  leaseSharedCodexAppServerClient: async (...args: unknown[]) => {
    let settled = false;
    return {
      client: await sharedClientMocks.getSharedCodexAppServerClient(...args),
      release: () => {
        settled = true;
      },
      abandon: async () => {
        if (!settled) {
          settled = true;
          await sharedClientMocks.abandonSharedCodexAppServerClient();
        }
      },
    };
  },
}));
vi.mock("./app-server/attempt-client-cleanup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./app-server/attempt-client-cleanup.js")>();
  return { ...actual, ...cleanupMocks };
});
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/exec-approvals-runtime")>();
  return {
    ...actual,
    loadExecApprovals: execApprovalsRuntimeMocks.loadExecApprovals,
  };
});
vi.mock("openclaw/plugin-sdk/agent-runtime", () => agentRuntimeMocks);

import { CodexAppServerRpcError } from "./app-server/client.js";
import type { CodexServerNotification } from "./app-server/protocol.js";
import type {
  CodexAppServerBindingStore,
  CodexAppServerThreadBinding,
} from "./app-server/session-binding.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import { getCodexAppServerTurnRouter } from "./app-server/turn-router.js";
import {
  legacyCodexConversationBindingId,
  type CodexAppServerConversationBindingData,
} from "./conversation-binding-data.js";
import { handleCodexConversationInboundClaim as handleCodexConversationInboundClaimImpl } from "./conversation-binding.js";
import { setCodexConversationFastMode } from "./conversation-control.js";

function handleCodexConversationInboundClaim(
  event: Parameters<typeof handleCodexConversationInboundClaimImpl>[0],
  ctx: Parameters<typeof handleCodexConversationInboundClaimImpl>[1],
  options: Omit<Parameters<typeof handleCodexConversationInboundClaimImpl>[2], "bindingStore">,
) {
  return handleCodexConversationInboundClaimImpl(event, ctx, {
    ...options,
    bindingStore: testCodexAppServerBindingStore,
  });
}

let tempDir: string;

function testConversationBindingId(sessionFile: string): string {
  return `test-${legacyCodexConversationBindingId(sessionFile)}`;
}

function testConversationIdentity(sessionFile: string) {
  return {
    kind: "conversation" as const,
    bindingId: testConversationBindingId(sessionFile),
  };
}

async function writeTestConversationBinding(
  sessionFile: string,
  binding: CodexAppServerThreadBinding,
): Promise<void> {
  await testCodexAppServerBindingStore.mutate(testConversationIdentity(sessionFile), {
    kind: "set",
    binding,
  });
}

async function readTestConversationBinding(sessionFile: string) {
  return await testCodexAppServerBindingStore.read(testConversationIdentity(sessionFile));
}

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function appServerClientHandlerStubs() {
  return {
    addNotificationHandler: vi.fn(() => () => undefined),
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn(() => () => undefined),
  };
}

function threadResponseResult(
  threadId: string,
  options: {
    model?: string;
    modelProvider?: string;
    status?: { type: "idle" } | { type: "active"; activeFlags: string[] };
  } = {},
) {
  const model = options.model ?? "gpt-5.4";
  const modelProvider = options.modelProvider ?? "openai";
  return {
    thread: {
      id: threadId,
      sessionId: "session-1",
      preview: "",
      modelProvider,
      createdAt: 1,
      updatedAt: 1,
      status: options.status ?? { type: "idle" as const },
      cwd: tempDir,
      turns: [],
      source: "appServer" as const,
      ephemeral: false,
      cliVersion: "0.139.0",
    },
    model,
    modelProvider,
    cwd: tempDir,
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    sandbox: { type: "dangerFullAccess" as const },
  };
}

function threadResumeResult(threadId: string) {
  return threadResponseResult(threadId);
}

function turnStartResult(turnId: string) {
  return { turn: { id: turnId, status: "inProgress" as const, items: [] } };
}

function claimTestConversation(
  bindingId: string,
  prompt = "continue",
  bindingStore: CodexAppServerBindingStore = testCodexAppServerBindingStore,
  start?: CodexAppServerConversationBindingData["start"],
  source?: CodexAppServerConversationBindingData["source"],
  options: Omit<Parameters<typeof handleCodexConversationInboundClaimImpl>[2], "bindingStore"> = {},
) {
  return handleCodexConversationInboundClaimImpl(
    {
      content: prompt,
      bodyForAgent: prompt,
      channel: "discord",
      isGroup: false,
      commandAuthorized: true,
    },
    {
      channelId: "discord",
      pluginBinding: {
        bindingId,
        pluginId: "codex",
        pluginRoot: tempDir,
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        boundAt: Date.now(),
        data: {
          kind: "codex-app-server-session",
          version: 2,
          bindingId,
          workspaceDir: tempDir,
          ...(start ? { start } : {}),
          ...(source ? { source } : {}),
        },
      },
    },
    { timeoutMs: 500, ...options, bindingStore },
  );
}

describe("codex conversation binding", () => {
  beforeEach(async () => {
    resetCodexTestBindingStore();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-binding-"));
  });

  afterEach(async () => {
    sharedClientMocks.abandonSharedCodexAppServerClient.mockClear();
    sharedClientMocks.getSharedCodexAppServerClient.mockReset();
    cleanupMocks.unsubscribeCodexThreadBestEffort.mockReset();
    cleanupMocks.unsubscribeCodexThreadBestEffort.mockResolvedValue(true);
    cleanupMocks.settleCodexAppServerClientLease.mockClear();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReset();
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({ version: 1, agents: {} });
    agentRuntimeMocks.ensureAuthProfileStore.mockReset();
    agentRuntimeMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
    agentRuntimeMocks.resolveApiKeyForProfile.mockReset();
    agentRuntimeMocks.resolveAuthProfileOrder.mockReset();
    agentRuntimeMocks.resolveDefaultAgentDir.mockClear();
    agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
    agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
    agentRuntimeMocks.resolveSessionAgentIds.mockClear();
    agentRuntimeMocks.saveAuthProfileStore.mockReset();
    codexRequirementsTomlMock.mockReset();
    resolveSandboxContextMock.mockReset();
    resolveSandboxContextMock.mockResolvedValue(null);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {},
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue([]);
    agentRuntimeMocks.resolveDefaultAgentDir.mockReturnValue("/agent");
    agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation(
      (provider: string, _lookup?: { config?: unknown }) => provider,
    );
    agentRuntimeMocks.resolveSessionAgentIds.mockReturnValue({
      defaultAgentId: "main",
      sessionAgentId: "main",
    });
  });

  it("consumes inbound bound messages when command authorization is absent", async () => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: "unauthorized-binding",
            workspaceDir: tempDir,
          },
        },
      },
      {},
    );

    expect(result).toEqual({ handled: true });
  });

  it("isolates a bound conversation from a concurrent attempt route", async () => {
    const bindingId = "conversation-binding";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "conversation-thread",
          cwd: tempDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    );
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    const requestHandlers = new Set<(request: unknown) => unknown>();
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
    const emit = (notification: CodexServerNotification) => {
      for (const handler of notificationHandlers) {
        void handler(notification);
      }
    };
    const client = {
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          return threadResumeResult(String(requestParams.threadId));
        }
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        expect(requestParams.threadId).toBe("conversation-thread");
        emit({
          method: "item/agentMessage/delta",
          params: {
            threadId: "attempt-thread",
            turnId: "attempt-turn",
            itemId: "attempt-item",
            delta: "Attempt-only output",
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId: "conversation-thread",
            turn: {
              id: "conversation-turn",
              threadId: "conversation-thread",
              status: "completed",
              items: [
                {
                  id: "conversation-item",
                  type: "agentMessage",
                  text: "Conversation answer",
                },
              ],
            },
          },
        });
        return turnStartResult("conversation-turn");
      }),
      addNotificationHandler,
      addRequestHandler,
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const router = getCodexAppServerTurnRouter(client as never);
    const attemptNotifications = vi.fn();
    const attemptRoute = router.reserveThread({
      threadId: "attempt-thread",
      onNotification: attemptNotifications,
    });
    attemptRoute.armTurn();
    await attemptRoute.bindTurn("attempt-turn");

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue",
        bodyForAgent: "continue",
        channel: "discord",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId,
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Conversation answer" } });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    await vi.waitFor(() => expect(attemptNotifications).toHaveBeenCalledTimes(1));
    expect(attemptNotifications.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        method: "item/agentMessage/delta",
        params: expect.objectContaining({ threadId: "attempt-thread" }),
      }),
    );
    expect(addNotificationHandler).toHaveBeenCalledTimes(1);
    expect(addRequestHandler).toHaveBeenCalledTimes(1);
    const replacement = router.reserveThread({
      threadId: "conversation-thread",
      onNotification: vi.fn(),
    });
    replacement.release();
    attemptRoute.release();
  });

  it("does not release another owner when same-thread routing rejects before resume", async () => {
    const bindingId = "already-routed-binding";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "shared-thread",
          cwd: tempDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    );
    const client = {
      request: vi.fn(),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    const existingRoute = getCodexAppServerTurnRouter(client as never).reserveThread({
      threadId: "shared-thread",
      onNotification: vi.fn(),
    });

    const result = await claimTestConversation(bindingId);

    expect(result?.reply?.text).toContain("route already reserved");
    expect(client.request).not.toHaveBeenCalled();
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).not.toHaveBeenCalled();
    existingRoute.release();
  });

  it("rejects source transfer after the stable session generation rotates", async () => {
    const bindingId = "rotated-source-binding";
    const source = {
      agentId: "main",
      sessionId: "session-old",
      threadId: "source-thread",
      sessionKey: "agent:main:main",
    };
    await testCodexAppServerBindingStore.mutate(
      { kind: "session", ...source },
      {
        kind: "set",
        binding: { threadId: "source-thread", cwd: tempDir },
      },
    );
    await expect(
      testCodexAppServerBindingStore.adoptSessionGeneration(
        { kind: "session", ...source, sessionId: "session-new" },
        source.sessionId,
      ),
    ).resolves.toBe("adopted");
    const client = {
      request: vi.fn(),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(
      bindingId,
      "continue",
      testCodexAppServerBindingStore,
      { id: "start-1" },
      source,
    );

    expect(result?.reply?.text).toContain("source session changed");
    expect(result?.reply?.text).toContain("/codex detach");
    expect(client.request).not.toHaveBeenCalled();
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toBeUndefined();
    await expect(
      testCodexAppServerBindingStore.read({ ...source, sessionId: "session-new", kind: "session" }),
    ).resolves.toMatchObject({ threadId: "source-thread" });
  });

  it("keeps source ownership recoverable until lazy initialization commits", async () => {
    const bindingId = "recoverable-source-binding";
    const source = {
      agentId: "main",
      sessionId: "session-a",
      threadId: "source-thread",
      sessionKey: "agent:main:main",
    };
    await testCodexAppServerBindingStore.mutate(
      { kind: "session", ...source },
      {
        kind: "set",
        binding: { threadId: "source-thread", cwd: tempDir },
      },
    );
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    let resumeAttempts = 0;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/resume") {
          resumeAttempts += 1;
          if (resumeAttempts === 1) {
            throw new CodexAppServerRpcError({ message: "temporary resume failure" }, method);
          }
          return threadResumeResult("source-thread");
        }
        if (method === "turn/start") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              void handler({
                method: "turn/completed",
                params: {
                  threadId: "source-thread",
                  turn: {
                    id: "recovered-turn",
                    status: "completed",
                    items: [{ id: "answer", type: "agentMessage", text: "Recovered" }],
                  },
                },
              });
            }
          });
          return turnStartResult("recovered-turn");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(
        (handler: (notification: CodexServerNotification) => Promise<void> | void) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
      ),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const first = await claimTestConversation(
      bindingId,
      "continue",
      testCodexAppServerBindingStore,
      { id: "start-1", threadId: "source-thread" },
      source,
    );
    expect(first?.reply?.text).toContain("temporary resume failure");
    await expect(
      testCodexAppServerBindingStore.read({ kind: "session", ...source }),
    ).resolves.toMatchObject({ threadId: "source-thread" });
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toBeUndefined();

    await expect(
      claimTestConversation(
        bindingId,
        "continue",
        testCodexAppServerBindingStore,
        { id: "start-1", threadId: "source-thread" },
        source,
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "Recovered" } });
    await expect(
      testCodexAppServerBindingStore.read({ kind: "session", ...source }),
    ).resolves.toBeUndefined();
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({
      threadId: "source-thread",
      conversationSourceTransferComplete: true,
    });
  });

  it("reconciles an incomplete source transfer once across established bound turns", async () => {
    const bindingId = "cold-conversation-binding";
    const source = {
      agentId: "main",
      sessionId: "session-a",
      threadId: "source-thread",
      sessionKey: "agent:main:main",
    };
    await testCodexAppServerBindingStore.mutate(
      { kind: "session", ...source },
      {
        kind: "set",
        binding: { threadId: "source-thread", cwd: tempDir },
      },
    );
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "cold-thread",
          cwd: tempDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    );
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    let subscribed = false;
    cleanupMocks.unsubscribeCodexThreadBestEffort.mockImplementation(async () => {
      subscribed = false;
      return true;
    });
    const client = {
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          expect(requestParams).toMatchObject({
            threadId: "cold-thread",
            excludeTurns: true,
            persistExtendedHistory: true,
          });
          subscribed = true;
          return threadResumeResult("cold-thread");
        }
        if (method !== "turn/start") {
          throw new Error(`unexpected method: ${method}`);
        }
        expect(subscribed).toBe(true);
        setImmediate(() => {
          for (const handler of notificationHandlers) {
            void handler({
              method: "turn/completed",
              params: {
                threadId: "cold-thread",
                turn: {
                  id: "cold-turn",
                  status: "completed",
                  items: [{ id: "answer", type: "agentMessage", text: "Still here" }],
                },
              },
            });
          }
        });
        return turnStartResult("cold-turn");
      }),
      addNotificationHandler: vi.fn(
        (handler: (notification: CodexServerNotification) => Promise<void> | void) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
      ),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    await expect(
      claimTestConversation(
        bindingId,
        "continue",
        testCodexAppServerBindingStore,
        undefined,
        source,
      ),
    ).resolves.toEqual({
      handled: true,
      reply: { text: "Still here" },
    });
    await expect(
      claimTestConversation(
        bindingId,
        "continue again",
        testCodexAppServerBindingStore,
        undefined,
        source,
      ),
    ).resolves.toEqual({
      handled: true,
      reply: { text: "Still here" },
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "turn/start",
      "thread/resume",
      "turn/start",
    ]);
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).toHaveBeenCalledTimes(2);
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({
      threadId: "cold-thread",
      conversationSourceTransferComplete: true,
    });
    await expect(
      testCodexAppServerBindingStore.read({ kind: "session", ...source }),
    ).resolves.toBeUndefined();
  });

  it("waits for a resumed native turn before starting the bound turn", async () => {
    const bindingId = "active-native-turn-binding";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "active-thread",
          cwd: tempDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    );
    const handlers = new Set<(notification: CodexServerNotification) => void>();
    const emit = (notification: CodexServerNotification) => {
      for (const handler of handlers) {
        handler(notification);
      }
    };
    const client = {
      request: vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/resume") {
          setImmediate(() =>
            emit({
              method: "turn/completed",
              params: { threadId: "active-thread", turn: { id: "native-turn", items: [] } },
            }),
          );
          return threadResponseResult("active-thread", {
            status: { type: "active", activeFlags: [] },
          });
        }
        if (method === "turn/start") {
          setImmediate(() =>
            emit({
              method: "turn/completed",
              params: {
                threadId: "active-thread",
                turn: {
                  id: "bound-turn",
                  status: "completed",
                  items: [{ id: "answer", type: "agentMessage", text: "After native work" }],
                },
              },
            }),
          );
          return turnStartResult("bound-turn");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: CodexServerNotification) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    await expect(claimTestConversation(bindingId)).resolves.toEqual({
      handled: true,
      reply: { text: "After native work" },
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
  });

  it("waits and retries once when a bound turn races newly active native work", async () => {
    const bindingId = "racing-native-turn-binding";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "racing-thread",
          cwd: tempDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    );
    const handlers = new Set<(notification: CodexServerNotification) => void>();
    const emit = (notification: CodexServerNotification) => {
      for (const handler of handlers) {
        handler(notification);
      }
    };
    let turnStartAttempts = 0;
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/resume") {
          return threadResumeResult("racing-thread");
        }
        if (method === "turn/start") {
          turnStartAttempts += 1;
          if (turnStartAttempts === 1) {
            setImmediate(() =>
              emit({
                method: "turn/completed",
                params: {
                  threadId: "racing-thread",
                  turn: { id: "native-race-turn", status: "completed", items: [] },
                },
              }),
            );
            throw new CodexAppServerRpcError(
              {
                message: "active turn is not steerable",
                data: {
                  codexErrorInfo: {
                    activeTurnNotSteerable: { turnId: "native-race-turn" },
                  },
                },
              },
              "turn/start",
            );
          }
          setImmediate(() =>
            emit({
              method: "turn/completed",
              params: {
                threadId: "racing-thread",
                turn: {
                  id: "bound-turn",
                  status: "completed",
                  items: [{ id: "answer", type: "agentMessage", text: "After the race" }],
                },
              },
            }),
          );
          return turnStartResult("bound-turn");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: CodexServerNotification) => void) => {
        handlers.add(handler);
        return () => handlers.delete(handler);
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    await expect(claimTestConversation(bindingId)).resolves.toEqual({
      handled: true,
      reply: { text: "After the race" },
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "turn/start",
      "turn/start",
    ]);
  });

  it("rejects a bound turn when resume returns a different thread", async () => {
    const bindingId = "mismatched-bound-thread";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "expected-thread",
          cwd: tempDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    );
    const client = {
      request: vi.fn(async (_method: string) => threadResumeResult("wrong-thread")),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(bindingId);

    expect(result?.reply?.text).toContain(
      "Codex thread/resume returned wrong-thread for expected-thread",
    );
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({ threadId: "expected-thread" });
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).not.toHaveBeenCalled();
    expect(sharedClientMocks.abandonSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });

  it("does not replay a prompt when a completed turn reports a missing-thread message", async () => {
    const bindingId = "failed-turn-binding";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "failed-turn-thread",
          cwd: tempDir,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
      },
    );
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    const client = {
      request: vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/resume") {
          return threadResumeResult("failed-turn-thread");
        }
        if (method !== "turn/start") {
          throw new Error(`unexpected recovery request: ${method}`);
        }
        setImmediate(() => {
          for (const handler of notificationHandlers) {
            void handler({
              method: "turn/completed",
              params: {
                threadId: "failed-turn-thread",
                turn: {
                  id: "failed-turn",
                  status: "failed",
                  error: { message: "tool failed: thread not found: unrelated-child" },
                  items: [],
                },
              },
            });
          }
        });
        return turnStartResult("failed-turn");
      }),
      addNotificationHandler: vi.fn(
        (handler: (notification: CodexServerNotification) => Promise<void> | void) => {
          notificationHandlers.add(handler);
          return () => notificationHandlers.delete(handler);
        },
      ),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(bindingId);
    expect(result?.reply?.text).toContain("tool failed: thread not found: unrelated-child");
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/resume",
      "turn/start",
    ]);
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({ threadId: "failed-turn-thread" });
    expect(sharedClientMocks.abandonSharedCodexAppServerClient).not.toHaveBeenCalled();
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).toHaveBeenCalledOnce();
  });

  it("does not overwrite a same-thread preference patch during missing-thread recovery", async () => {
    const bindingId = "concurrent-preference-binding";
    const identity = { kind: "conversation" as const, bindingId };
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "missing-thread",
        cwd: tempDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    });
    let leases = 0;
    const bindingStore: CodexAppServerBindingStore = {
      read: (readIdentity) => testCodexAppServerBindingStore.read(readIdentity),
      mutate: (mutateIdentity, mutation) =>
        testCodexAppServerBindingStore.mutate(mutateIdentity, mutation),
      prepareSessionGenerationReclaim: (sessionIdentity) =>
        testCodexAppServerBindingStore.prepareSessionGenerationReclaim(sessionIdentity),
      adoptSessionGeneration: (sessionIdentity, expectedPreviousSessionId) =>
        testCodexAppServerBindingStore.adoptSessionGeneration(
          sessionIdentity,
          expectedPreviousSessionId,
        ),
      retireSessionGeneration: (sessionIdentity) =>
        testCodexAppServerBindingStore.retireSessionGeneration(sessionIdentity),
      withLease: (leaseIdentity, run) =>
        testCodexAppServerBindingStore.withLease(leaseIdentity, async () => {
          leases += 1;
          if (leases === 2) {
            await testCodexAppServerBindingStore.mutate(identity, {
              kind: "patch",
              threadId: "missing-thread",
              patch: { serviceTier: "priority" },
            });
          }
          return await run();
        }),
    };
    const client = {
      request: vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/resume") {
          throw new Error("thread not found: missing-thread");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(bindingId, "continue", bindingStore);
    expect(result?.reply?.text).toContain("binding changed");
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: "missing-thread",
      serviceTier: "priority",
    });
  });

  it("serializes bound-turn resume policy with concurrent preference updates", async () => {
    const bindingId = "concurrent-resume-preference-binding";
    const identity = { kind: "conversation" as const, bindingId };
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "set",
      binding: {
        threadId: "active-thread",
        cwd: tempDir,
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        serviceTier: "flex",
      },
    });
    let resumeStarted!: () => void;
    const resumeStartedPromise = new Promise<void>((resolve) => {
      resumeStarted = resolve;
    });
    let finishResume!: () => void;
    const resumeGate = new Promise<void>((resolve) => {
      finishResume = resolve;
    });
    const notificationHandlers = new Set<(notification: CodexServerNotification) => void>();
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/resume") {
          resumeStarted();
          await resumeGate;
          return threadResumeResult("active-thread");
        }
        if (method === "turn/start") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "active-thread",
                  turn: {
                    id: "bound-turn",
                    status: "completed",
                    items: [{ id: "answer", type: "agentMessage", text: "Done" }],
                  },
                },
              });
            }
          });
          return turnStartResult("bound-turn");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: CodexServerNotification) => void) => {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const turn = claimTestConversation(bindingId);
    await resumeStartedPromise;
    const preference = setCodexConversationFastMode({
      identity,
      bindingStore: testCodexAppServerBindingStore,
      enabled: true,
    });
    finishResume();

    await expect(turn).resolves.toEqual({ handled: true, reply: { text: "Done" } });
    await expect(preference).resolves.toBe("Codex fast mode enabled.");
    await expect(testCodexAppServerBindingStore.read(identity)).resolves.toMatchObject({
      threadId: "active-thread",
      serviceTier: "priority",
    });
  });

  it("routes bound Codex CLI node sessions through node resume", async () => {
    const resumeCodexCliSessionOnNode = vi.fn(async () => ({
      ok: true as const,
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      text: "done",
    }));

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "global",
      },
      {
        channelId: "discord",
        sessionKey: "global",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            agentId: "work",
            cwd: "/repo",
          },
        },
      },
      {
        config: {
          session: { scope: "global" },
          agents: {
            list: [
              { id: "main", default: true, sandbox: { mode: "all" } },
              { id: "work", sandbox: { mode: "off" } },
            ],
          },
          tools: { exec: { host: "node", node: "mb-m5" } },
        },
        resumeCodexCliSessionOnNode,
        timeoutMs: 1234,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(resumeCodexCliSessionOnNode).toHaveBeenCalledWith({
      nodeId: "mb-m5",
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      prompt: "continue the task",
      cwd: "/repo",
      timeoutMs: 1234,
    });
  });

  it("blocks bound Codex app-server turns when the current OpenClaw session is sandboxed", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: testConversationBindingId(sessionFile),
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "app-server",
      data: {
        kind: "codex-app-server-session" as const,
        version: 1,
        sessionFile: "/tmp/shipped-session.jsonl",
      },
    },
    {
      label: "CLI node",
      data: {
        kind: "codex-cli-node-session" as const,
        version: 1 as const,
        nodeId: "mb-m5",
        sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
      },
    },
  ])("uses the inbound agent for shipped $label bindings under global scope", async ({ data }) => {
    const resumeCodexCliSessionOnNode = vi.fn();
    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "global",
      },
      {
        channelId: "discord",
        sessionKey: "global",
        agentId: "work",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data,
        },
      },
      {
        config: {
          session: { scope: "global" },
          agents: {
            list: [
              { id: "main", default: true, sandbox: { mode: "off" } },
              { id: "work", sandbox: { mode: "all" } },
            ],
          },
        },
        resumeCodexCliSessionOnNode,
      },
    );

    expect(result?.reply?.text).toContain("OpenClaw sandboxing is active");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
    expect(resumeCodexCliSessionOnNode).not.toHaveBeenCalled();
  });

  it("blocks bound Codex app-server turns when exec host=node is active", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "node-session",
      },
      {
        channelId: "discord",
        sessionKey: "node-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: testConversationBindingId(sessionFile),
            workspaceDir: tempDir,
          },
        },
      },
      {
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex app-server conversation binding is unavailable because OpenClaw exec host=node is active for this session.",
        ),
      },
    });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("blocks bound Codex app-server turns when the binding agent uses node exec without a session key", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        config: {
          tools: { exec: { host: "gateway" } },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: { exec: { host: "node", node: "worker-1" } },
              },
            ],
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain("OpenClaw exec host=node is active");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("keeps the bound agent node exec block ahead of current-session exec host overrides", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:session-1",
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        execHost: "gateway",
      },
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "agent:main:session-1",
      },
      {
        channelId: "discord",
        sessionKey: "agent:main:session-1",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        config: {
          session: {
            store: path.join(tempDir, "agents", "{agentId}", "sessions", "sessions.json"),
          },
          tools: { exec: { host: "gateway" } },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: { exec: { host: "node", node: "worker-1" } },
              },
            ],
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain("OpenClaw exec host=node is active");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("rejects bound Codex app-server turns when the binding agent exec auto mode needs approvals", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );
    const request = vi.fn(async () => {
      throw new Error("unexpected native turn");
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "discord",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          tools: {
            exec: {
              mode: "full",
            },
          },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: {
                  exec: {
                    mode: "auto",
                  },
                },
              },
            ],
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps bound agent approval policy ahead of different-agent session overrides", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({ schemaVersion: 1, threadId: "thread-1", cwd: tempDir }),
    );
    await upsertSessionEntry({
      storePath,
      sessionKey: "agent:main:session-1",
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        execSecurity: "full",
        execAsk: "off",
      },
    });
    const request = vi.fn(async () => {
      throw new Error("unexpected native turn");
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "agent:main:session-1",
      },
      {
        channelId: "discord",
        sessionKey: "agent:main:session-1",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          session: { store: storePath },
          tools: {
            exec: {
              mode: "full",
            },
          },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: {
                  exec: {
                    mode: "auto",
                  },
                },
              },
            ],
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("blocks bound Codex CLI node turns when the current OpenClaw session is sandboxed", async () => {
    const resumeCodexCliSessionOnNode = vi.fn();

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue the task",
        channel: "discord",
        isGroup: true,
        commandAuthorized: true,
        sessionKey: "sandboxed-session",
      },
      {
        channelId: "discord",
        sessionKey: "sandboxed-session",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "discord",
          accountId: "default",
          conversationId: "channel-1",
          boundAt: Date.now(),
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "mb-m5",
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
          },
        },
      },
      {
        config: { agents: { defaults: { sandbox: { mode: "all" } } } },
        resumeCodexCliSessionOnNode,
      },
    );

    expect(result).toEqual({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "Codex-native Codex CLI node conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
        ),
      },
    });
    expect(resumeCodexCliSessionOnNode).not.toHaveBeenCalled();
  });

  it.each([
    ["legacy missing-thread error", "thread not found: thread-old"],
    ["Codex missing-rollout error", "no rollout found for thread id thread-old"],
  ] as const)(
    "recreates a missing bound thread after %s and preserves auth plus turn overrides",
    async (_label, missingThreadError) => {
      const sessionFile = path.join(tempDir, "session.jsonl");
      agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
        version: 1,
        profiles: {
          work: {
            type: "oauth",
            provider: "openai",
            access: "access-token",
          },
        },
      });
      await writeTestConversationBinding(sessionFile, {
        threadId: "thread-old",
        cwd: tempDir,
        authProfileId: "work",
        model: "gpt-5.4-mini",
        modelProvider: "openai",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: "fast",
      });
      const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
      const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
        request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
          requests.push({ method, params: requestParams });
          if (method === "thread/resume" && requestParams.threadId === "thread-old") {
            throw new Error(missingThreadError);
          }
          if (method === "thread/resume" && requestParams.threadId === "thread-new") {
            return threadResumeResult("thread-new");
          }
          if (method === "thread/start") {
            return threadResponseResult("thread-new", { model: "gpt-5.4-mini" });
          }
          if (method === "turn/start" && requestParams.threadId === "thread-new") {
            setImmediate(() => {
              for (const handler of notificationHandlers) {
                handler({
                  method: "turn/completed",
                  params: {
                    threadId: "thread-new",
                    turn: {
                      id: "turn-new",
                      status: "completed",
                      items: [
                        {
                          id: "assistant-1",
                          type: "agentMessage",
                          text: "Recovered",
                        },
                      ],
                    },
                  },
                });
              }
            });
            return turnStartResult("turn-new");
          }
          throw new Error(`unexpected method: ${method}`);
        }),
        addNotificationHandler: vi.fn((handler) => {
          notificationHandlers.push(handler);
          return () => undefined;
        }),
        addRequestHandler: vi.fn(() => () => undefined),
        addCloseHandler: vi.fn(() => () => undefined),
      });

      const result = await handleCodexConversationInboundClaim(
        {
          content: "hi again",
          bodyForAgent: "hi again",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: testConversationBindingId(sessionFile),
              workspaceDir: tempDir,
            },
          },
        },
        { timeoutMs: 500 },
      );

      expect(result).toEqual({ handled: true, reply: { text: "Recovered" } });
      expect(requests.map((request) => request.method)).toEqual([
        "thread/resume",
        "thread/start",
        "turn/start",
      ]);
      const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
        authProfileId?: unknown;
      };
      expect(sharedClientParams?.authProfileId).toBe("work");
      expect(requests[0]?.params).toMatchObject({
        threadId: "thread-old",
        excludeTurns: true,
        persistExtendedHistory: true,
      });
      expect(requests[1]?.params.model).toBe("gpt-5.4-mini");
      expect(requests[1]?.params.approvalPolicy).toBe("on-request");
      expect(requests[1]?.params.sandbox).toBe("workspace-write");
      expect(requests[1]?.params.serviceTier).toBe("priority");
      expect(requests[1]?.params).not.toHaveProperty("modelProvider");
      expect(requests[2]?.params.threadId).toBe("thread-new");
      expect(requests[2]?.params.approvalPolicy).toBe("on-request");
      expect(requests[2]?.params.serviceTier).toBe("priority");
      await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
        threadId: "thread-new",
        authProfileId: "work",
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        serviceTier: "priority",
      });
      await expect(readTestConversationBinding(sessionFile)).resolves.not.toHaveProperty(
        "modelProvider",
      );
    },
  );

  it("recreates a missing bound thread with the stored binding agent runtime policy", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 1,
        threadId: "thread-old",
        cwd: tempDir,
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      }),
    );
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "turn/start" && requestParams.threadId === "thread-old") {
          throw new Error("thread not found: thread-old");
        }
        if (method === "thread/start") {
          return {
            thread: { id: "thread-new", sessionId: "session-1", cwd: tempDir },
            model: "gpt-5.4-mini",
          };
        }
        if (method === "turn/start" && requestParams.threadId === "thread-new") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Recovered" }],
                  },
                },
              });
            }
          });
          return { turn: { id: "turn-new" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
            agentId: "bot-a",
          },
        },
      },
      {
        timeoutMs: 500,
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
          agents: {
            list: [
              {
                id: "bot-a",
                tools: {
                  exec: {
                    mode: "full",
                  },
                },
              },
            ],
          },
        } as never,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "Recovered" } });
    expect(requests.map((request) => request.method)).toEqual([
      "turn/start",
      "thread/start",
      "turn/start",
    ]);
    expect(requests[0]?.params.approvalPolicy).toBe("never");
    expect(requests[0]?.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
    expect(requests[1]?.params.approvalPolicy).toBe("never");
    expect(requests[1]?.params.sandbox).toBe("danger-full-access");
    expect(requests[2]?.params.approvalPolicy).toBe("never");
    expect(requests[2]?.params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
  });

  it("does not silently decline auto-mode approvals during missing thread recovery", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-old",
      cwd: tempDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        bodyForAgent: "hi again",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: testConversationBindingId(sessionFile),
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 500,
        config: {
          tools: {
            exec: {
              mode: "auto",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy conversation binding has not been migrated", async () => {
    const sessionFile = path.join(tempDir, "legacy-session.jsonl");

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue",
        channel: "telegram",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "redacted-group",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      { timeoutMs: 500 },
    );

    expect(result?.reply?.text).toContain("openclaw doctor --fix");
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("leaves late thread cleanup to the client when a new-thread response times out", async () => {
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/start") {
          throw new Error("thread/start timed out");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation("ambiguous-start");

    expect(result?.reply?.text).toContain("thread/start timed out");
    expect(sharedClientMocks.abandonSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("starts fresh when an active conversation binding has no canonical thread row", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const config = { auth: { order: { openai: ["openai:default"] } } };
    const requests: string[] = [];
    let threadStartParams: Record<string, unknown> | undefined;
    const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push(method);
        if (method === "thread/start") {
          threadStartParams = requestParams;
          return threadResponseResult("thread-fresh", { model: "gpt-5.5-mini" });
        }
        if (method === "thread/resume") {
          return threadResumeResult("thread-fresh");
        }
        if (method === "turn/start") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-fresh",
                  turn: {
                    id: "turn-fresh",
                    status: "completed",
                    items: [{ id: "assistant-1", type: "agentMessage", text: "Fresh reply" }],
                  },
                },
              });
            }
          });
          return turnStartResult("turn-fresh");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.push(handler);
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hi again",
        channel: "telegram",
        isGroup: true,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "redacted-group",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: testConversationBindingId(sessionFile),
            workspaceDir: tempDir,
            start: {
              id: "start-1",
              model: "gpt-5.5-mini",
              modelProvider: "openai",
            },
          },
        },
      },
      { timeoutMs: 500, config: config as never },
    );

    expect(result?.reply?.text).toBe("Fresh reply");
    expect(requests).toEqual(["thread/start", "turn/start"]);
    expect(threadStartParams).toMatchObject({
      model: "gpt-5.5-mini",
      modelProvider: "openai",
    });
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      authProfileId?: unknown;
    };
    expect(sharedClientParams.authProfileId).toBe("openai:default");
    await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
      authProfileId: "openai:default",
      conversationStartId: "start-1",
      threadId: "thread-fresh",
      cwd: tempDir,
    });
  });

  it("materializes a newer bind intent once on the existing conversation owner", async () => {
    const bindingId = "rebind-owner";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "thread-old",
          cwd: "/old",
          conversationStartId: "start-old",
        },
      },
    );
    const methods: string[] = [];
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        methods.push(method);
        if (method === "thread/resume") {
          for (const handler of notificationHandlers) {
            void handler({
              method: "turn/completed",
              params: {
                threadId: "thread-new",
                turn: { id: "native-turn", status: "completed", items: [] },
              },
            });
          }
          return threadResponseResult("thread-new", {
            status: { type: "active", activeFlags: [] },
          });
        }
        if (method === "turn/start") {
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              void handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-new",
                  turn: {
                    id: "turn-new",
                    status: "completed",
                    items: [{ id: "answer", type: "agentMessage", text: "Rebound" }],
                  },
                },
              });
            }
          });
          return turnStartResult("turn-new");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    });

    await expect(
      claimTestConversation(bindingId, "continue", testCodexAppServerBindingStore, {
        id: "start-new",
        threadId: "thread-new",
      }),
    ).resolves.toEqual({ handled: true, reply: { text: "Rebound" } });
    expect(methods).toEqual(["thread/resume", "turn/start"]);
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({
      threadId: "thread-new",
      conversationStartId: "start-new",
    });
  });

  it("rechecks Guardian policy against the provider returned by lazy resume", async () => {
    const bindingId = "lazy-custom-provider";
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    const client = {
      request: vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/resume") {
          return threadResponseResult("thread-local", {
            model: "local-model",
            modelProvider: "lmstudio",
          });
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(
      bindingId,
      "continue",
      testCodexAppServerBindingStore,
      { id: "start-local", threadId: "thread-local" },
      undefined,
      { pluginConfig: { appServer: { mode: "guardian" } } },
    );

    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    expect(client.request.mock.calls[0]?.[1]).toMatchObject({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ threadId: "thread-local" }),
    );
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({
      threadId: "thread-local",
      model: "local-model",
      modelProvider: "lmstudio",
      conversationStartId: "start-local",
    });
  });

  it("preserves an explicit OpenAI provider on native-auth lazy resume", async () => {
    const bindingId = "lazy-explicit-openai";
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    const client = {
      request: vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/resume") {
          return threadResponseResult("thread-openai", {
            model: "local-model",
            modelProvider: "lmstudio",
          });
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(
      bindingId,
      "continue",
      testCodexAppServerBindingStore,
      {
        id: "start-openai",
        threadId: "thread-openai",
        model: "gpt-5.5",
        modelProvider: "openai",
      },
      undefined,
      { pluginConfig: { appServer: { mode: "guardian" } } },
    );

    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(client.request.mock.calls[0]?.[1]).toMatchObject({
      model: "gpt-5.5",
      modelProvider: "openai",
      approvalsReviewer: "auto_review",
    });
  });

  it("promotes authoritative native OpenAI policy and preserves it on the next turn", async () => {
    const bindingId = "lazy-native-openai";
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    agentRuntimeMocks.resolveAuthProfileOrder.mockReturnValue(["openai:default"]);
    const notificationHandlers = new Set<
      (notification: CodexServerNotification) => Promise<void> | void
    >();
    let turnNumber = 0;
    const client = {
      request: vi.fn(async (method: string, _requestParams?: unknown) => {
        if (method === "thread/resume") {
          return threadResponseResult("thread-openai", {
            model: "gpt-5.5",
            modelProvider: "openai",
          });
        }
        if (method === "turn/start") {
          turnNumber += 1;
          const turnId = `turn-${turnNumber}`;
          setImmediate(() => {
            for (const handler of notificationHandlers) {
              void handler({
                method: "turn/completed",
                params: {
                  threadId: "thread-openai",
                  turn: {
                    id: turnId,
                    status: "completed",
                    items: [{ id: `answer-${turnNumber}`, type: "agentMessage", text: "done" }],
                  },
                },
              });
            }
          });
          return turnStartResult(turnId);
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler) => {
        notificationHandlers.add(handler);
        return () => notificationHandlers.delete(handler);
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    const start = { id: "start-openai", threadId: "thread-openai" };
    const options = { pluginConfig: { appServer: { mode: "guardian" } } };

    await expect(
      claimTestConversation(
        bindingId,
        "first",
        testCodexAppServerBindingStore,
        start,
        undefined,
        options,
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "done" } });
    await expect(
      claimTestConversation(
        bindingId,
        "second",
        testCodexAppServerBindingStore,
        start,
        undefined,
        options,
      ),
    ).resolves.toEqual({ handled: true, reply: { text: "done" } });

    const resumeRequests = client.request.mock.calls.filter(
      ([method]) => method === "thread/resume",
    );
    expect(resumeRequests[0]?.[1]).toMatchObject({ approvalsReviewer: "user" });
    expect(resumeRequests[1]?.[1]).toMatchObject({ approvalsReviewer: "auto_review" });
    const turnRequests = client.request.mock.calls.filter(([method]) => method === "turn/start");
    expect(turnRequests).toHaveLength(2);
    expect(turnRequests[0]?.[1]).toMatchObject({ approvalsReviewer: "auto_review" });
    expect(turnRequests[1]?.[1]).toMatchObject({ approvalsReviewer: "auto_review" });
  });

  it("rechecks an established native binding when resume returns a custom provider", async () => {
    const bindingId = "existing-provider-change";
    agentRuntimeMocks.ensureAuthProfileStore.mockReturnValue({
      version: 1,
      profiles: {
        "openai:default": {
          type: "oauth",
          provider: "openai",
          access: "access-token",
        },
      },
    });
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "thread-changed",
          cwd: tempDir,
          authProfileId: "openai:default",
          model: "gpt-5.5",
          approvalPolicy: "on-request",
          sandbox: "workspace-write",
        },
      },
    );
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "thread/resume") {
          return threadResponseResult("thread-changed", {
            model: "local-model",
            modelProvider: "lmstudio",
          });
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(
      bindingId,
      "continue",
      testCodexAppServerBindingStore,
      undefined,
      undefined,
      { pluginConfig: { appServer: { mode: "guardian" } } },
    );

    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(client.request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({ model: "local-model", modelProvider: "lmstudio" });
  });

  it("rejects a bind when Codex resumes a different thread", async () => {
    const bindingId = "mismatched-resume-owner";
    await testCodexAppServerBindingStore.mutate(
      { kind: "conversation", bindingId },
      {
        kind: "set",
        binding: {
          threadId: "thread-old",
          cwd: "/old",
          conversationStartId: "start-old",
        },
      },
    );
    const client = {
      request: vi.fn(async () => threadResumeResult("wrong-thread")),
      ...appServerClientHandlerStubs(),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);

    const result = await claimTestConversation(
      bindingId,
      "continue",
      testCodexAppServerBindingStore,
      { id: "start-new", threadId: "requested-thread" },
    );

    expect(result?.reply?.text).toContain(
      "Codex thread/resume returned wrong-thread for requested-thread",
    );
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toMatchObject({
      threadId: "thread-old",
      conversationStartId: "start-old",
    });
    expect(cleanupMocks.unsubscribeCodexThreadBestEffort).not.toHaveBeenCalled();
    expect(sharedClientMocks.abandonSharedCodexAppServerClient).toHaveBeenCalledOnce();
  });

  it("explains how to recover when lazy bind initialization fails", async () => {
    const bindingId = "invalid-bind";
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string) => {
        if (method === "thread/resume") {
          throw new Error("thread not found: missing-thread");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      ...appServerClientHandlerStubs(),
    });

    const result = await claimTestConversation(
      bindingId,
      "continue",
      testCodexAppServerBindingStore,
      { id: "start-invalid", threadId: "missing-thread" },
    );
    expect(result?.reply?.text).toContain("Codex binding initialization failed");
    expect(result?.reply?.text).toContain("/codex detach");
    await expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
    ).resolves.toBeUndefined();
  });

  it("applies host exec approval floors while initializing a lazy bind", async () => {
    execApprovalsRuntimeMocks.loadExecApprovals.mockReturnValue({
      version: 1,
      defaults: { security: "deny", ask: "off" },
      agents: {},
    });

    const result = await claimTestConversation(
      "host-floor",
      "continue",
      testCodexAppServerBindingStore,
      { id: "start-host-floor", model: "gpt-5.5-mini" },
    );

    expect(result?.reply?.text).toContain("tools.exec.mode=deny");
    expect(execApprovalsRuntimeMocks.loadExecApprovals).toHaveBeenCalled();
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("passes sandbox state when resolving bound turn policy", async () => {
    codexRequirementsTomlMock.mockReturnValue(
      [
        'allowed_sandbox_modes = ["read-only", "workspace-write"]',
        'allowed_approval_policies = ["never", "on-request"]',
        'allowed_approvals_reviewers = ["user"]',
      ].join("\n"),
    );
    resolveSandboxContextMock.mockResolvedValue({ enabled: true });
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          return threadResumeResult(String(requestParams.threadId));
        }
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return turnStartResult("turn-1");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "continue",
        bodyForAgent: "continue",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
        sessionKey: "agent:main:session-1",
      },
      {
        channelId: "telegram",
        sessionKey: "agent:main:session-1",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: testConversationBindingId(sessionFile),
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          tools: {
            exec: {
              security: "full",
              ask: "always",
            },
          },
        } as never,
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(result?.reply?.text).not.toContain(
      "legacy full exec security with ask requires Codex app-server danger-full-access",
    );
    expect(resolveSandboxContextMock).toHaveBeenCalledWith({
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "always",
          },
        },
      },
      sessionKey: "agent:main:session-1",
      workspaceDir: tempDir,
    });
    expect(turnStartParams).toEqual([]);
  });

  it("returns a clean failure reply when app-server turn start rejects", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      authProfileId: "openai:work",
    });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          return threadResumeResult(String(requestParams.threadId));
        }
        if (method === "turn/start") {
          throw new Error(
            "unexpected status 401 Unauthorized: Missing bearer <@U123> [trusted](https://evil) @here",
          );
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    });

    try {
      const result = await handleCodexConversationInboundClaim(
        {
          content: "hi",
          bodyForAgent: "hi",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: testConversationBindingId(sessionFile),
              workspaceDir: tempDir,
              agentDir,
            },
          },
        },
        { timeoutMs: 50 },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(result).toEqual({
        handled: true,
        reply: {
          text: "Codex app-server turn failed: unexpected status 401 Unauthorized: Missing bearer &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        },
      });
      const replyText = result?.reply?.text ?? "";
      expect(replyText).not.toContain("<@U123>");
      expect(replyText).not.toContain("[trusted](https://evil)");
      expect(replyText).not.toContain("@here");
      expect(unhandledRejections).toStrictEqual([]);
      expect(sharedClientMocks.abandonSharedCodexAppServerClient).toHaveBeenCalledTimes(1);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("uses prepared exec policy and falls back to content when body for agent is blank", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const agentId = "work";
    const agentDir = path.join(tempDir, "agents", "bot-b", "agent");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          return threadResumeResult(String(requestParams.threadId));
        }
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return turnStartResult("turn-1");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "use the fallback prompt",
        bodyForAgent: "",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
        sessionKey: "global",
      },
      {
        channelId: "telegram",
        sessionKey: "global",
        execOverrides: { security: "full", ask: "off" },
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: testConversationBindingId(sessionFile),
            workspaceDir: tempDir,
            agentId,
            agentDir,
          },
        },
      },
      {
        timeoutMs: 50,
        config: {
          agents: { list: [{ id: "main", default: true }, { id: agentId }] },
          session: { scope: "global" },
        },
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    const sharedClientParams = mockCallArg(sharedClientMocks.getSharedCodexAppServerClient) as {
      agentDir?: unknown;
    };
    expect(sharedClientParams?.agentDir).toBe(agentDir);
    expect(agentRuntimeMocks.resolveSessionAgentIds).not.toHaveBeenCalled();
    expect(turnStartParams[0]?.input).toEqual([
      { type: "text", text: "use the fallback prompt", text_elements: [] },
    ]);
    expect(turnStartParams[0]?.approvalPolicy).toBe("never");
    expect(turnStartParams[0]?.approvalsReviewer).toBe("user");
    expect(turnStartParams[0]?.sandboxPolicy).toEqual({
      type: "dangerFullAccess",
    });
  });

  it("keeps network-proxy bound app-server turns on their thread permissions profile", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 2,
        threadId: "thread-1",
        cwd: tempDir,
        networkProxyProfileName: NETWORK_PROXY_PROFILE_NAME,
        networkProxyConfigFingerprint: NETWORK_PROXY_CONFIG_FINGERPRINT,
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hello",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        pluginConfig: {
          appServer: {
            networkProxy: {
              enabled: true,
              domains: { "api.openai.com": "allow" },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
        timeoutMs: 50,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(turnStartParams[0]).not.toHaveProperty("permissions");
    expect(turnStartParams[0]).not.toHaveProperty("sandboxPolicy");
  });

  it("refreshes stale network-proxy bound app-server threads before the turn", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      `${sessionFile}.codex-app-server.json`,
      JSON.stringify({
        schemaVersion: 2,
        threadId: "thread-old",
        cwd: tempDir,
        networkProxyProfileName: "openclaw-network-stale",
        networkProxyConfigFingerprint: "stale-proxy-config",
      }),
    );
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        requests.push({ method, params: requestParams });
        if (method === "thread/start") {
          return conversationThreadStartResult("thread-new");
        }
        if (method === "turn/start") {
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-new",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return { turn: { id: "turn-1" } };
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hello",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 1,
            sessionFile,
            workspaceDir: tempDir,
          },
        },
      },
      {
        pluginConfig: {
          appServer: {
            serviceTier: "priority",
            networkProxy: {
              enabled: true,
              domains: { "api.openai.com": "allow" },
              allowUpstreamProxy: true,
              proxyUrl: "http://127.0.0.1:3128",
            },
          },
        },
        timeoutMs: 50,
      },
    );

    expect(result).toEqual({ handled: true, reply: { text: "done" } });
    expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
    expect(requests[0]?.params.config).toMatchObject(NETWORK_PROXY_CONFIG_PATCH);
    expect(requests[0]?.params).not.toHaveProperty("sandbox");
    expect(requests[0]?.params.serviceTier).toBe("priority");
    expect(requests[1]?.params.threadId).toBe("thread-new");
    expect(requests[1]?.params).not.toHaveProperty("sandboxPolicy");
    const bindingAfterRefresh = JSON.parse(
      await fs.readFile(`${sessionFile}.codex-app-server.json`, "utf8"),
    ) as Record<string, unknown>;
    expect(bindingAfterRefresh.threadId).toBe("thread-new");
    expect(bindingAfterRefresh.networkProxyProfileName).toBe(NETWORK_PROXY_PROFILE_NAME);
    expect(bindingAfterRefresh.networkProxyConfigFingerprint).toBe(
      NETWORK_PROXY_CONFIG_FINGERPRINT,
    );
  });

  it("blocks Guardian-mode bound turns with stale no-approval policy on custom model providers", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "local-model",
      modelProvider: "lmstudio",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          return threadResumeResult(String(requestParams.threadId));
        }
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return turnStartResult("turn-1");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    });

    const result = await handleCodexConversationInboundClaim(
      {
        content: "hello",
        channel: "telegram",
        isGroup: false,
        commandAuthorized: true,
      },
      {
        channelId: "telegram",
        pluginBinding: {
          bindingId: "binding-1",
          pluginId: "codex",
          pluginRoot: tempDir,
          channel: "telegram",
          accountId: "default",
          conversationId: "5185575566",
          boundAt: Date.now(),
          data: {
            kind: "codex-app-server-session",
            version: 2,
            bindingId: testConversationBindingId(sessionFile),
            workspaceDir: tempDir,
          },
        },
      },
      {
        timeoutMs: 50,
        pluginConfig: {
          appServer: {
            mode: "guardian",
          },
        },
      },
    );

    expect(result?.handled).toBe(true);
    expect(result?.reply?.text).toContain(
      "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
    );
    expect(turnStartParams).toEqual([]);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });

  it("infers custom model providers for legacy bound turns without stored modelProvider", async () => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    await writeTestConversationBinding(sessionFile, {
      threadId: "thread-1",
      cwd: tempDir,
      model: "lmstudio/local-model",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const turnStartParams: Record<string, unknown>[] = [];
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
        if (method === "thread/resume") {
          return threadResumeResult(String(requestParams.threadId));
        }
        if (method === "turn/start") {
          turnStartParams.push(requestParams);
          setImmediate(() =>
            notificationHandler?.({
              method: "turn/completed",
              params: {
                threadId: "thread-1",
                turn: {
                  id: "turn-1",
                  status: "completed",
                  items: [{ type: "agentMessage", id: "item-1", text: "done" }],
                },
              },
            }),
          );
          return turnStartResult("turn-1");
        }
        throw new Error(`unexpected method: ${method}`);
      }),
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
      addCloseHandler: vi.fn(() => () => undefined),
    });

    await expect(
      handleCodexConversationInboundClaim(
        {
          content: "hello",
          channel: "telegram",
          isGroup: false,
          commandAuthorized: true,
        },
        {
          channelId: "telegram",
          pluginBinding: {
            bindingId: "binding-1",
            pluginId: "codex",
            pluginRoot: tempDir,
            channel: "telegram",
            accountId: "default",
            conversationId: "5185575566",
            boundAt: Date.now(),
            data: {
              kind: "codex-app-server-session",
              version: 2,
              bindingId: testConversationBindingId(sessionFile),
              workspaceDir: tempDir,
            },
          },
        },
        {
          timeoutMs: 50,
          pluginConfig: {
            appServer: {
              mode: "guardian",
            },
          },
        },
      ),
    ).resolves.toMatchObject({
      handled: true,
      reply: {
        text: expect.stringContaining(
          "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
        ),
      },
    });

    expect(turnStartParams).toEqual([]);
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  });
});
