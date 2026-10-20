import type { ReadFileSyncOptions } from "node:fs";
import path from "node:path";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { runInHarnessToolAuthorityForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  deleteSessionEntry,
  patchSessionEntry,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  observeHostDataSql,
  useSessionStoreTempDirs,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-codex-binding-");

const sharedClientMocks = vi.hoisted(() => ({
  getSharedCodexAppServerClient: vi.fn(),
  retainSharedCodexAppServerClientByInstanceId: vi.fn(
    (_clientId?: string): { client: unknown; release: () => void } | undefined => undefined,
  ),
  clearSharedCodexAppServerClientIfCurrentAndUnclaimed: vi.fn((_client: unknown) => ({
    found: false,
    closed: false,
  })),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(
    (_client: unknown): { activeLeases: number; closed: boolean } | undefined => undefined,
  ),
}));

const publicBindingMocks = vi.hoisted(() => ({
  readBinding: vi.fn((): { bindingId: string } | null => ({
    bindingId: "binding-1",
  })),
}));

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovalsReadOnlyAsync: vi.fn<() => Promise<ExecApprovalsFile>>(async () => ({
    version: 1,
    agents: {},
  })),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStoreAsync: vi.fn(),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/agent/workspace"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string, _lookup?: { config?: unknown }) => provider),
  resolveSessionAgentIdsStrict: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  saveAuthProfileStore: vi.fn(),
}));

const providerAuthMocks = vi.hoisted(() => ({
  resolveAuthProfileOrder: vi.fn(),
}));

const codexRequirementsTomlMock = vi.hoisted(() => vi.fn<() => string | undefined>());
const resolveSandboxContextMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ enabled: boolean } | null>>(async () => null),
);
const configLayerPolicyMocks = vi.hoisted(() => ({
  readCodexEffectiveConfig: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync(
      filePath: string | URL | number,
      options?: BufferEncoding | ReadFileSyncOptions | null,
    ) {
      if (filePath === "/etc/codex/requirements.toml") {
        const content = codexRequirementsTomlMock();
        if (content !== undefined) {
          return content;
        }
        throw Object.assign(new Error("Synthetic Codex requirements file is absent"), {
          code: "ENOENT",
        });
      }
      return actual.readFileSync(
        filePath,
        typeof options === "string" ? { encoding: options } : (options ?? {}),
      );
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

vi.mock("./app-server/config-layer-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/config-layer-policy.js")>()),
  readCodexEffectiveConfig: configLayerPolicyMocks.readCodexEffectiveConfig,
}));

vi.mock("openclaw/plugin-sdk/conversation-binding-inspection-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("openclaw/plugin-sdk/conversation-binding-inspection-runtime")
    >();
  return {
    ...actual,
    inspectConversationBinding: (
      conversation: Parameters<typeof actual.inspectConversationBinding>[0],
    ) => createConversationInspection(conversation, publicBindingMocks.readBinding()?.bindingId),
  };
});

vi.mock("./app-server/shared-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./app-server/shared-client.js")>()),
  ...sharedClientMocks,
  getLeasedSharedCodexAppServerClient: async (...args: unknown[]) => {
    const client = (await sharedClientMocks.getSharedCodexAppServerClient(...args)) as {
      getInstanceId?: () => string;
      addCloseHandler?: () => () => void;
    };
    client.getInstanceId ??= () => "test-client";
    client.addCloseHandler ??= () => () => undefined;
    return client;
  },
  releaseLeasedSharedCodexAppServerClient: vi.fn(),
  releaseCodexAppServerClientLease: vi.fn((lease: { client?: unknown }) => {
    lease.client = undefined;
  }),
  withCodexAppServerClientRequestScope: async (params: {
    lease: { client?: unknown };
    options?: { timeoutMs?: number };
    run: (
      client: unknown,
      requestOptions: () => { timeoutMs: number; assertCurrent: () => void },
    ) => Promise<unknown>;
  }) =>
    await params.run(params.lease.client, () => ({
      timeoutMs: params.options?.timeoutMs ?? 60_000,
      assertCurrent: () => undefined,
    })),
}));
vi.mock("openclaw/plugin-sdk/exec-approvals-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/exec-approvals-runtime")>();
  return {
    ...actual,
    loadExecApprovalsReadOnlyAsync: execApprovalsRuntimeMocks.loadExecApprovalsReadOnlyAsync,
  };
});
vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return {
    ...agentRuntimeMocks,
    findPersistedAuthProfileCredential: actual.findPersistedAuthProfileCredential,
    refreshOAuthCredentialForRuntime: actual.refreshOAuthCredentialForRuntime,
  };
});
vi.mock("openclaw/plugin-sdk/provider-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth")>()),
  ensureAuthProfileStoreAsync: agentRuntimeMocks.ensureAuthProfileStoreAsync,
  resolveAuthProfileOrder: providerAuthMocks.resolveAuthProfileOrder,
}));
vi.mock("openclaw/plugin-sdk/agent-scope-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-scope-runtime")>()),
  resolveSessionAgentIdsStrict: agentRuntimeMocks.resolveSessionAgentIdsStrict,
  resolveAgentWorkspaceDir: agentRuntimeMocks.resolveAgentWorkspaceDir,
}));
vi.mock("openclaw/plugin-sdk/agent-harness-registration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-registration")>()),
  resolveDefaultAgentDir: agentRuntimeMocks.resolveDefaultAgentDir,
}));
vi.mock("openclaw/plugin-sdk/provider-auth-aliases", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-aliases")>()),
  resolveProviderIdForAuth: agentRuntimeMocks.resolveProviderIdForAuth,
}));

import { isIncognitoSessionKey } from "openclaw/plugin-sdk/session-key-runtime";
import codexPlugin from "../index.js";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
} from "./app-server/client-runtime.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./app-server/client.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { codexNativeSubagentMonitorRuntime } from "./app-server/native-subagent-monitor.js";
import type { JsonValue } from "./app-server/protocol.js";
import {
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
  createConversationInspection,
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
  testConversationIdentity,
  writeTestConversationBinding,
  readTestConversationBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import { withCodexConversationThreadActivity } from "./app-server/thread-ownership.js";
import { getCodexAppServerTurnRouter } from "./app-server/turn-router.js";
import {
  createCodexConversationBindingData,
  legacyCodexConversationBindingId,
} from "./conversation-binding-data.js";
import { handleCodexConversationInboundClaim as handleCodexConversationInboundClaimImpl } from "./conversation-binding-hooks.js";
import { prepareCodexConversationBinding } from "./conversation-binding-preparation.js";
import {
  conversationMessage,
  conversationThreadStartResult,
  createConversationClaimFixtures,
} from "./conversation-binding.test-helpers.js";
import { readCodexConversationActiveTurn } from "./conversation-control.js";

function turnCompleted(threadId: string, id: string, text: string, itemId = "answer") {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: { id, status: "completed", items: [{ type: "agentMessage", id: itemId, text }] },
    },
  };
}

function clientListeners(handlers?: Set<(notification: unknown) => unknown>) {
  return {
    addNotificationHandler: vi.fn((handler: (notification: unknown) => unknown) => {
      handlers?.add(handler);
      return () => handlers?.delete(handler);
    }),
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn(() => () => undefined),
  };
}

function replyingClient(
  threadId: string,
  turnId: string,
  text: string,
  clientId: string,
  responses: Record<string, () => unknown>,
) {
  const handlers = new Set<(notification: unknown) => unknown>();
  const operations: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    getInstanceId: () => clientId,
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      operations.push({ method, params });
      if (method === "turn/start") {
        queueMicrotask(() => {
          for (const handler of handlers) {
            handler(turnCompleted(threadId, turnId, text));
          }
        });
        return { turn: { id: turnId } };
      }
      const respond = responses[method];
      if (!respond) {
        throw new Error(`unexpected method: ${method}`);
      }
      return respond();
    }),
    ...clientListeners(handlers),
  } as unknown as CodexAppServerClient;
  return { client, operations };
}

async function expectReply(result: unknown, text: string) {
  expect(await result).toEqual({ handled: true, reply: { text } });
}

async function boundSession(
  filename = "session.jsonl",
  binding: Omit<Parameters<typeof writeTestConversationBinding>[1], "cwd"> & { cwd?: string } = {
    threadId: "thread-1",
  },
) {
  const sessionFile = path.join(tempDir, filename);
  await writeTestConversationBinding(sessionFile, { cwd: tempDir, ...binding });
  return sessionFile;
}

function conversationData(bindingId: string, fields: Record<string, unknown> = {}) {
  return {
    kind: "codex-app-server-session",
    version: 2,
    bindingId,
    workspaceDir: tempDir,
    ...fields,
  };
}

function sourceSession(sessionId: string, threadId = "thread-source") {
  return { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, threadId };
}

function seedSession(
  source: Pick<ReturnType<typeof sourceSession>, "sessionId" | "sessionKey"> & { agentId?: string },
  storePath: string,
  fields: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
) {
  return upsertSessionEntry({
    ...source,
    storePath,
    entry: { sessionId: source.sessionId, updatedAt: Date.now(), ...fields },
  });
}

function seedBinding(
  identity: Parameters<typeof testCodexAppServerBindingStore.mutate>[0],
  binding: Omit<Parameters<typeof writeTestConversationBinding>[1], "cwd">,
) {
  return testCodexAppServerBindingStore.mutate(identity, {
    kind: "set",
    binding: { cwd: tempDir, ...binding },
  });
}

function rpcError(message: string, method = "turn/start", code = -32_600) {
  return new CodexAppServerRpcError({ code, message }, method);
}

function rpcResponses(responses: Record<string, unknown>) {
  return vi.fn(async (method: string) => {
    if (!(method in responses)) {
      throw new Error(`unexpected method: ${method}`);
    }
    const response = responses[method];
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
}

async function expectLiveThread(client: CodexAppServerClient, threadId: string) {
  await expect(consumeCodexAppServerLiveThread(client, threadId)).resolves.toEqual(
    expect.objectContaining({ release: expect.any(Function) }),
  );
}

async function createSameThreadClientMigrationFixture(
  sessionFile: string,
  options: { rejectOldRelease: boolean },
) {
  const binding = {
    threadId: "thread-migrated",
    clientId: "client-before-migration",
    cwd: tempDir,
  };
  const readOwner = () => readTestConversationBinding(sessionFile);
  await writeTestConversationBinding(sessionFile, binding);
  const operations: string[] = [];
  const ownerDuringRelease: Array<string | undefined> = [];
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const previousClient = {
    getInstanceId: () => "client-before-migration",
    request: vi.fn(async (method: string) => {
      operations.push(`previous:${method}`);
      ownerDuringRelease.push((await readOwner())?.clientId);
      if (options.rejectOldRelease) {
        throw new Error("previous physical client unsubscribe failed");
      }
      return {};
    }),
    ...clientListeners(),
  } as unknown as CodexAppServerClient;
  const replacementClient = {
    getInstanceId: () => "client-after-migration",
    request: vi.fn(async (method: string) => {
      if (method === "thread/read") {
        return { thread: conversationThreadStartResult(tempDir, "thread-migrated").thread };
      }
      operations.push(`replacement:${method}`);
      if (method === "thread/resume") {
        return conversationThreadStartResult(tempDir, "thread-migrated");
      }
      if (method === "thread/unsubscribe") {
        return {};
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          for (const handler of notificationHandlers) {
            handler(turnCompleted("thread-migrated", "turn-migrated", "Migrated reply"));
          }
        });
        return { turn: { id: "turn-migrated" } };
      }
      throw new Error(`unexpected method: ${method}`);
    }),
    ...clientListeners(notificationHandlers),
  } as unknown as CodexAppServerClient;
  ensureCodexAppServerClientRuntime(previousClient, { agentDir: tempDir });
  ensureCodexAppServerClientRuntime(replacementClient, { agentDir: tempDir });
  await expect(retainCodexAppServerLiveThread(previousClient, "thread-migrated")).resolves.toBe(
    true,
  );
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(replacementClient);
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockImplementation((clientId) =>
    clientId === previousClient.getInstanceId()
      ? { client: previousClient, release: vi.fn() }
      : undefined,
  );
  return { previousClient, replacementClient, operations, ownerDuringRelease, readOwner };
}

function handleCodexConversationInboundClaim(
  event: Parameters<typeof handleCodexConversationInboundClaimImpl>[0],
  ctx: Parameters<typeof handleCodexConversationInboundClaimImpl>[1],
  options: Omit<Parameters<typeof handleCodexConversationInboundClaimImpl>[2], "bindingStore"> = {},
) {
  return handleCodexConversationInboundClaimImpl({ senderIsOwner: true, ...event }, ctx, {
    ...options,
    bindingStore: testCodexAppServerBindingStore,
  });
}

function prepareTestConversationBinding(params: {
  bindingStore?: Parameters<typeof prepareCodexConversationBinding>[0]["bindingStore"];
  config?: Parameters<typeof prepareCodexConversationBinding>[0]["config"];
  pluginConfig?: unknown;
  sessionFile: string;
  workspaceDir?: string;
  sessionKey?: string;
  agentId?: string;
  agentDir?: string;
  threadId?: string;
  model?: string;
  modelProvider?: string;
  authProfileId?: string;
}) {
  return prepareCodexConversationBinding({
    bindingStore: params.bindingStore ?? testCodexAppServerBindingStore,
    config: params.config,
    pluginConfig: params.pluginConfig,
    sessionKey: params.sessionKey,
    incognito: isIncognitoSessionKey(params.sessionKey),
    data: createCodexConversationBindingData({
      bindingId: testConversationIdentity(params.sessionFile).bindingId,
      workspaceDir: params.workspaceDir ?? tempDir,
      agentId: params.agentId,
      agentDir: params.agentDir,
      start: {
        id: "start-request",
        threadId: params.threadId,
        model: params.model,
        modelProvider: params.modelProvider,
        authProfileId: params.authProfileId,
      },
    }),
  });
}

let tempDir: string;
const {
  conversationClaimContext,
  legacyConversationData,
  boundConversationClaim,
  denyConversationBinding,
} = createConversationClaimFixtures(() => tempDir, testCodexAppServerBindingStore);

const NETWORK_PROXY_PLUGIN_CONFIG = {
  appServer: {
    networkProxy: {
      enabled: true,
      domains: { "api.openai.com": "allow" as const },
      allowUpstreamProxy: true,
      proxyUrl: "http://127.0.0.1:3128",
    },
  },
};
const NETWORK_PROXY_RUNTIME = resolveCodexAppServerRuntimeOptions({
  env: {},
  requirementsToml: null,
  pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG,
});
const NETWORK_PROXY_PROFILE_NAME = NETWORK_PROXY_RUNTIME.networkProxy?.profileName ?? "missing";
const NETWORK_PROXY_CONFIG_PATCH = NETWORK_PROXY_RUNTIME.networkProxy?.configPatch ?? {};
const NETWORK_PROXY_CONFIG_FINGERPRINT =
  NETWORK_PROXY_RUNTIME.networkProxy?.configFingerprint ?? "missing";
const WORKSPACE_REQUIREMENTS = [
  'allowed_sandbox_modes = ["workspace-write"]',
  'allowed_approval_policies = ["on-request"]',
  'allowed_approvals_reviewers = ["auto_review"]',
].join("\n");

function workspacePolicy(root: string) {
  return {
    cwd: root,
    runtimeWorkspaceRoots: [root],
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  };
}

async function useRealRequestScope() {
  const shared = await import("./app-server/shared-client.js");
  const actual = await vi.importActual<typeof shared>("./app-server/shared-client.js");
  return vi
    .spyOn(shared, "withCodexAppServerClientRequestScope")
    .mockImplementation(actual.withCodexAppServerClientRequestScope);
}

async function useRealConfigReader() {
  const actual = await vi.importActual<typeof import("./app-server/config-layer-policy.js")>(
    "./app-server/config-layer-policy.js",
  );
  configLayerPolicyMocks.readCodexEffectiveConfig.mockImplementation(
    actual.readCodexEffectiveConfig,
  );
}

// Incognito handles live in the isolated test home, outside the session-store root.
afterAll(() => closeOpenClawAgentDatabasesAsync());

beforeEach(() => {
  setRuntimeConfigSnapshot({});
  resetCodexTestBindingStore();
  tempDir = sessionDirs.make();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  publicBindingMocks.readBinding.mockReset();
  publicBindingMocks.readBinding.mockReturnValue({ bindingId: "binding-1" });
  sharedClientMocks.getSharedCodexAppServerClient.mockReset();
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReset();
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue(undefined);
  sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed.mockReset();
  sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed.mockReturnValue({
    found: false,
    closed: false,
  });
  sharedClientMocks.retireSharedCodexAppServerClientIfCurrent.mockReset();
  execApprovalsRuntimeMocks.loadExecApprovalsReadOnlyAsync.mockReset();
  execApprovalsRuntimeMocks.loadExecApprovalsReadOnlyAsync.mockResolvedValue({
    version: 1,
    agents: {},
  });
  agentRuntimeMocks.ensureAuthProfileStoreAsync.mockReset();
  agentRuntimeMocks.loadAuthProfileStoreForSecretsRuntime.mockReset();
  agentRuntimeMocks.resolveApiKeyForProfile.mockReset();
  providerAuthMocks.resolveAuthProfileOrder.mockReset();
  agentRuntimeMocks.resolveDefaultAgentDir.mockClear();
  agentRuntimeMocks.resolvePersistedAuthProfileOwnerAgentDir.mockReset();
  agentRuntimeMocks.resolveProviderIdForAuth.mockClear();
  agentRuntimeMocks.resolveSessionAgentIdsStrict.mockClear();
  agentRuntimeMocks.saveAuthProfileStore.mockReset();
  codexRequirementsTomlMock.mockReset();
  resolveSandboxContextMock.mockReset();
  resolveSandboxContextMock.mockResolvedValue(null);
  configLayerPolicyMocks.readCodexEffectiveConfig.mockReset();
  configLayerPolicyMocks.readCodexEffectiveConfig.mockResolvedValue({
    config: {},
    origins: {},
    layers: [],
  });
});

beforeEach(() => {
  agentRuntimeMocks.ensureAuthProfileStoreAsync.mockResolvedValue({
    version: 1,
    profiles: {},
  });
  providerAuthMocks.resolveAuthProfileOrder.mockReturnValue([]);
  agentRuntimeMocks.resolveDefaultAgentDir.mockReturnValue("/agent");
  agentRuntimeMocks.resolveProviderIdForAuth.mockImplementation(
    (provider: string, _lookup?: { config?: unknown }) => provider,
  );
  agentRuntimeMocks.resolveSessionAgentIdsStrict.mockReturnValue({
    defaultAgentId: "main",
    sessionAgentId: "main",
  });
});

it("isolates concurrent turn requests and buffers early bound-turn completion", async () => {
  const sessionFile = await boundSession("session.jsonl", { threadId: "bound-thread" });
  const notificationHandlers = new Set<(notification: unknown) => unknown>();
  const requestHandlers = new Set<(request: unknown) => unknown>();
  const siblingRequestOwner = vi.fn((request: { method: string }): JsonValue =>
    request.method === "item/tool/call"
      ? { contentItems: [], success: true }
      : { decision: "accept" },
  );
  const siblingResponses: unknown[] = [];
  let releaseSiblingRoute: (() => void) | undefined;
  const client = {
    request: vi.fn(async (method: string) => {
      if (method !== "turn/start") {
        throw new Error(`unexpected method: ${method}`);
      }
      const siblingRoute = getCodexAppServerTurnRouter(clientForRouter).reserveThread({
        threadId: "sibling-thread",
        onRequest: siblingRequestOwner,
      });
      releaseSiblingRoute = siblingRoute.release;
      siblingRoute.armTurn();
      await siblingRoute.bindTurn("sibling-turn");
      for (const requestMethod of ["item/tool/call", "item/commandExecution/requestApproval"]) {
        const request = {
          id: requestMethod,
          method: requestMethod,
          params: { threadId: "sibling-thread", turnId: "sibling-turn" },
        };
        for (const handler of requestHandlers) {
          const response = await handler(request);
          if (response !== undefined) {
            siblingResponses.push(response);
            break;
          }
        }
      }
      for (const handler of notificationHandlers) {
        handler(turnCompleted("bound-thread", "bound-turn", "Bound answer", "bound-answer"));
      }
      return { turn: { id: "bound-turn" } };
    }),
    addNotificationHandler: vi.fn((handler: (notification: unknown) => unknown) => {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    }),
    addRequestHandler: vi.fn((handler: (request: unknown) => unknown) => {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    }),
    addCloseHandler: vi.fn(() => () => undefined),
  };
  const clientForRouter = client as never;
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
  const { event, ctx } = boundConversationClaim(sessionFile);

  try {
    await expectReply(handleCodexConversationInboundClaim(event, ctx), "Bound answer");
    expect(siblingRequestOwner).toHaveBeenCalledTimes(2);
    expect(siblingResponses).toEqual([{ contentItems: [], success: true }, { decision: "accept" }]);
    expect(client.addNotificationHandler).toHaveBeenCalledOnce();
    expect(client.addRequestHandler).toHaveBeenCalledOnce();
  } finally {
    releaseSiblingRoute?.();
  }
});

it("keeps queued bound turns ahead of retirement through the registered entry", async () => {
  const sessionFile = path.join(tempDir, "queued-session.jsonl");
  const stateStore = createCodexTestBindingStateStore();
  const bindingStore = createCodexAppServerBindingStore(stateStore);
  await bindingStore.mutate(testConversationIdentity(sessionFile), {
    kind: "set",
    binding: { threadId: "bound-thread", clientId: "test-client", cwd: tempDir },
  });
  type InboundClaim = typeof handleCodexConversationInboundClaimImpl;
  const on = vi.fn();
  codexPlugin.register(
    createTestPluginApi({
      id: "codex",
      config: {},
      pluginConfig: {},
      runtime: {
        config: { current: () => ({}) },
        modelAuth: { resolveProviderIdForAuth: agentRuntimeMocks.resolveProviderIdForAuth },
        state: {
          openSyncKeyedStore: () => stateStore,
          openKeyedStoreV2: (
            _options: unknown,
            authority?: Parameters<typeof stateStore.withCurrent>[0],
          ) => ({
            ...stateStore.asyncReads,
            ...stateStore.withCurrent(authority ?? { assertCurrent() {} }),
          }),
        },
      } as never,
      on,
    }),
  );
  const hook = on.mock.calls.find(([name]) => name === "inbound_claim")?.[1] as
    | ((
        event: Parameters<InboundClaim>[0],
        ctx: Parameters<InboundClaim>[1],
      ) => ReturnType<InboundClaim>)
    | undefined;
  if (!hook) {
    throw new Error("missing registered inbound claim hook");
  }
  const handleClaim = (event: Parameters<InboundClaim>[0], ctx: Parameters<InboundClaim>[1]) =>
    hook({ senderIsOwner: true, ...event }, ctx);
  const notificationHandlers = new Set<(notification: unknown) => void>();
  const order: string[] = [];
  const client = {
    request: vi.fn(async (method: string) => {
      if (method !== "turn/start") {
        throw new Error(`unexpected method: ${method}`);
      }
      const turnId = `turn-${order.filter((entry) => entry.startsWith("turn-")).length + 1}`;
      order.push(turnId);
      return { turn: { id: turnId } };
    }),
    ...clientListeners(notificationHandlers),
  };
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
  const { event, ctx } = boundConversationClaim(sessionFile);
  const completeTurn = (turnId: string) => {
    for (const handler of notificationHandlers) {
      handler(turnCompleted("bound-thread", turnId, turnId, `${turnId}-answer`));
    }
  };

  const firstTurn = handleClaim(event, ctx);
  await vi.waitFor(() => expect(client.request).toHaveBeenCalledOnce());
  const secondTurn = handleClaim(event, ctx);
  const retirement = withCodexConversationThreadActivity(
    legacyCodexConversationBindingId(sessionFile),
    async () => {
      order.push("retired");
    },
  );

  completeTurn("turn-1");
  await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(2));
  try {
    expect(order).toEqual(["turn-1", "turn-2"]);
  } finally {
    completeTurn("turn-2");
    await Promise.allSettled([firstTurn, secondTurn, retirement]);
  }

  await expect(firstTurn).resolves.toMatchObject({ reply: { text: "turn-1" } });
  await expect(secondTurn).resolves.toMatchObject({ reply: { text: "turn-2" } });
  await retirement;
  expect(order).toEqual(["turn-1", "turn-2", "retired"]);
});

it("does not recreate a detached conversation queued behind retirement", async () => {
  const bindingId = "binding-retiring";
  const identity = { kind: "conversation" as const, bindingId };
  await seedBinding(identity, {
    threadId: "thread-retiring",
    conversationStartId: "start-original",
  });
  const retirementReady = Promise.withResolvers<void>();
  const retirementStarted = Promise.withResolvers<void>();
  const ownerCaptured = Promise.withResolvers<void>();
  const retirement = withCodexConversationThreadActivity(bindingId, async () => {
    retirementStarted.resolve();
    await retirementReady.promise;
    await testCodexAppServerBindingStore.mutate(identity, {
      kind: "clear",
      threadId: "thread-retiring",
    });
    publicBindingMocks.readBinding.mockReturnValue(null);
  });
  await retirementStarted.promise;
  const bindingStore = {
    ...testCodexAppServerBindingStore,
    readAsync: async (
      requestedIdentity: Parameters<typeof testCodexAppServerBindingStore.readAsync>[0],
    ) => {
      const binding = await testCodexAppServerBindingStore.readAsync(requestedIdentity);
      ownerCaptured.resolve();
      return binding;
    },
  };
  const { event, ctx } = boundConversationClaim(path.join(tempDir, "retiring-session.jsonl"));
  ctx.pluginBinding.data = conversationData(bindingId, { start: { id: "start-original" } });
  const queued = handleCodexConversationInboundClaimImpl({ senderIsOwner: true, ...event }, ctx, {
    bindingStore,
  });
  await ownerCaptured.promise;
  retirementReady.resolve();
  await retirement;
  await expect(queued).resolves.toEqual({
    handled: true,
    reply: {
      text: "This Codex conversation was detached or changed before its message could run.",
    },
  });
  expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  expect(testCodexAppServerBindingStore.read(identity)).toBeUndefined();
});

it.each([
  {
    label: "an incognito source bound to an ordinary destination",
    sourceSessionKey: "agent:main:dashboard:incognito-source",
    destinationSessionKey: "agent:main:telegram:ordinary-destination",
    ephemeral: true,
  },
  {
    label: "an ordinary source bound to an incognito destination",
    sourceSessionKey: "agent:main:telegram:ordinary-source",
    destinationSessionKey: "agent:main:dashboard:incognito-destination",
    ephemeral: false,
  },
])(
  "uses the persisted source lifecycle for $label",
  async ({ sourceSessionKey, destinationSessionKey, ephemeral }) => {
    const sessionFile = path.join(tempDir, "mixed-source-lifecycle.jsonl");
    const bindingId = "binding-mixed-source-lifecycle";
    const storePath = path.join(tempDir, "mixed-source-lifecycle.sqlite");
    try {
      await seedSession(
        { agentId: "main", sessionKey: sourceSessionKey, sessionId: "source-mixed-lifecycle" },
        storePath,
      );
      const { client, operations } = replyingClient(
        "thread-mixed-source-lifecycle",
        "turn-mixed-source-lifecycle",
        "Bound reply",
        "client-mixed-source-lifecycle",
        {
          "thread/start": () =>
            conversationThreadStartResult(tempDir, "thread-mixed-source-lifecycle"),
          "thread/unsubscribe": () => ({}),
        },
      );
      ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
      sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
        client,
        release: vi.fn(),
      });
      const { event, ctx } = boundConversationClaim(sessionFile, destinationSessionKey);
      const data = conversationData(bindingId, {
        source: {
          agentId: "main",
          sessionId: "source-mixed-lifecycle",
          threadId: "thread-source-mixed-lifecycle",
          sessionKey: sourceSessionKey,
          storePath,
        },
        start: { id: "start-mixed-source-lifecycle" },
      });
      ctx.pluginBinding.data = data;

      const run = () =>
        handleCodexConversationInboundClaim(event, ctx, {
          config: { session: { store: path.join(tempDir, "unrelated-session.sqlite") } },
        });
      const sql = ephemeral ? observeHostDataSql() : undefined;
      try {
        await expect(run()).resolves.toMatchObject({
          handled: true,
          reply: {
            text: "Bound reply",
          },
        });
        if (sql) {
          expect(sql.queries).toEqual([]);
        }
      } finally {
        sql?.restore();
      }

      expect(operations.map(({ method }) => method)).toEqual(["thread/start", "turn/start"]);
      if (ephemeral) {
        expect(operations[0]?.params.ephemeral).toBe(true);
        await expect(
          consumeCodexAppServerLiveThread(client, "thread-mixed-source-lifecycle"),
        ).resolves.toBeUndefined();
      } else {
        expect(operations[0]?.params).not.toHaveProperty("ephemeral");
        const ownership = await consumeCodexAppServerLiveThread(
          client,
          "thread-mixed-source-lifecycle",
        );
        expect(ownership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
        await expect(
          retainCodexAppServerLiveThread(
            client,
            "thread-mixed-source-lifecycle",
            ownership?.release,
            ownership?.configFingerprint,
            ownership?.serviceTier,
          ),
        ).resolves.toBe(true);
      }

      await denyConversationBinding(data);

      expect(operations.at(-1)).toEqual({
        method: "thread/unsubscribe",
        params: { threadId: "thread-mixed-source-lifecycle" },
      });
      expect(
        testCodexAppServerBindingStore.read({ kind: "conversation", bindingId }),
      ).toBeUndefined();
    } finally {
      await deleteSessionEntry({ agentId: "main", sessionKey: sourceSessionKey, storePath });
    }
  },
);

it("fails closed before client startup when the source session is rebound", async () => {
  const bindingId = "binding-rebound-source";
  const sessionFile = path.join(tempDir, "rebound-source.jsonl");
  const storePath = path.join(tempDir, "rebound-source.sqlite");
  const source = sourceSession("source-session");
  await seedSession(source, storePath, { sessionId: "replacement-session" });
  await seedBinding({ kind: "conversation", bindingId }, { threadId: "thread-bound" });
  const { event, ctx } = boundConversationClaim(sessionFile);
  ctx.pluginBinding.data = conversationData(bindingId, { source });
  sharedClientMocks.getSharedCodexAppServerClient.mockRejectedValue(
    new Error("Codex client must not start"),
  );

  await expect(
    handleCodexConversationInboundClaim(event, ctx, {
      config: { session: { store: storePath } },
    }),
  ).resolves.toMatchObject({
    handled: true,
    reply: {
      text: expect.stringContaining("source session is missing or no longer current"),
    },
  });
  expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
});

it("rejects sandbox revocation while a conversation awaits client acquisition", async () => {
  const source = {
    ...sourceSession("sandbox-source"),
    storePath: path.join(tempDir, "sandbox-source.sqlite"),
  };
  await seedSession(source, source.storePath, { updatedAt: 1, sandboxMode: "off" });
  const { event, ctx } = boundConversationClaim(path.join(tempDir, "sandbox-source.jsonl"));
  ctx.pluginBinding.data = conversationData("binding-sandbox-source", { source });
  const request = vi.fn(async () => {
    throw new Error("Native requests must not run after sandbox revocation");
  });
  sharedClientMocks.getSharedCodexAppServerClient.mockImplementation(async () => {
    await patchSessionEntry({ ...source, update: () => ({ sandboxMode: undefined }) });
    return { request };
  });

  const result = await handleCodexConversationInboundClaim(event, ctx, {
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  });

  expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledOnce();
  expect(result?.reply?.text).toContain("selected session changed");
  expect(request).not.toHaveBeenCalled();
});

it("starts a fresh proxy-backed thread when binding an explicit app-server thread id", async () => {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
    request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
      requests.push({ method, params: requestParams });
      if (method === "thread/resume") {
        throw new Error("thread/resume should not receive network proxy config");
      }
      return conversationThreadStartResult(tempDir, "thread-new");
    }),
  });

  await prepareTestConversationBinding({
    pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG,
    sessionFile,
    threadId: "thread-old",
    agentDir,
    model: "gpt-5.4-mini",
    modelProvider: "openai",
  });

  expect(requests.map((request) => request.method)).toEqual(["thread/start"]);
  expect(requests[0]?.params).not.toHaveProperty("threadId");
  expect(requests[0]?.params).not.toHaveProperty("permissions");
  expect(requests[0]?.params).not.toHaveProperty("sandbox");
  expect(requests[0]?.params.config).toMatchObject(NETWORK_PROXY_CONFIG_PATCH);
  expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledWith(
    expect.objectContaining({ agentDir }),
  );
  const bindingAfterStart = await readTestConversationBinding(sessionFile);
  expect(bindingAfterStart).toMatchObject({
    threadId: "thread-new",
    networkProxyProfileName: NETWORK_PROXY_PROFILE_NAME,
    networkProxyConfigFingerprint: NETWORK_PROXY_CONFIG_FINGERPRINT,
  });
});

it("bounds a pending native config read without releasing the bound thread or its sibling", async () => {
  await useRealConfigReader();
  const sharedClientRuntime = await import("./app-server/shared-client.js");
  const retry = await useRealRequestScope();
  const releaseLease = vi.mocked(sharedClientRuntime.releaseCodexAppServerClientLease);
  releaseLease.mockClear();
  const sessionFile = path.join(tempDir, "pending-config-read.jsonl");
  const harness = createClientHarness();
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
  const releaseBoundThread = vi.fn(async () => undefined);
  const releaseSibling = vi.fn(async () => undefined);
  await retainCodexAppServerLiveThread(harness.client, "thread-current", releaseBoundThread);
  await retainCodexAppServerLiveThread(harness.client, "thread-sibling", releaseSibling);
  await writeTestConversationBinding(sessionFile, {
    threadId: "thread-current",
    clientId: harness.client.getInstanceId(),
    cwd: tempDir,
  });
  const before = await readTestConversationBinding(sessionFile);
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const settled = vi.fn();
  const result = prepareTestConversationBinding({
    pluginConfig: { appServer: { requestTimeoutMs: 1_000 } },
    sessionFile,
    threadId: "thread-current",
  }).then(
    () => {
      settled();
      return undefined;
    },
    (error: unknown) => {
      settled();
      return error;
    },
  );
  try {
    expect(JSON.parse(await harness.waitForWrite(0))).toMatchObject({
      method: "config/read",
      params: { cwd: tempDir, includeLayers: true },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(settled).toHaveBeenCalledOnce();
    await expect(result).resolves.toMatchObject({ message: "config/read timed out" });
    expect(harness.writes).toHaveLength(1);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(releaseBoundThread).not.toHaveBeenCalled();
    expect(releaseSibling).not.toHaveBeenCalled();
    expect(harness.stdinDestroyed).toBe(false);
    await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(before);
    await expectLiveThread(harness.client, "thread-current");
    await expectLiveThread(harness.client, "thread-sibling");
  } finally {
    harness.client.close();
    await result;
    retry.mockRestore();
    vi.useRealTimers();
  }
});

it("uses the selected physical client's budget when rebinding a thread", async () => {
  await useRealConfigReader();
  const sessionFile = path.join(tempDir, "selected-config-owner.jsonl");
  const threadId = "thread-selected-config-owner";
  const createBudgetClient = (budget: number) =>
    createClientHarness({
      onWrite: (line, send) => {
        const request: { id: number; method: string } = JSON.parse(line);
        if (request.method === "config/read") {
          send({
            id: request.id,
            result: {
              config: { project_doc_max_bytes: budget },
              origins: {
                project_doc_max_bytes: {
                  name: { type: "user", file: "/codex/config.toml", profile: null },
                  version: "sha256:authored-budget",
                },
              },
              layers: [],
            },
          });
        } else if (request.method === "thread/read") {
          send({
            id: request.id,
            result: { thread: conversationThreadStartResult(tempDir, threadId).thread },
          });
        } else if (request.method === "thread/resume") {
          send({ id: request.id, result: conversationThreadStartResult(tempDir, threadId) });
        } else if (request.method === "thread/unsubscribe") {
          send({ id: request.id, result: {} });
        } else {
          throw new Error(`Unexpected native request: ${request.method}`);
        }
      },
    });
  const previous = createBudgetClient(180_000);
  const selected = createBudgetClient(240_000);
  ensureCodexAppServerClientRuntime(previous.client, { agentDir: tempDir });
  ensureCodexAppServerClientRuntime(selected.client, { agentDir: tempDir });
  await retainCodexAppServerLiveThread(previous.client, threadId);
  await writeTestConversationBinding(sessionFile, {
    threadId,
    clientId: previous.client.getInstanceId(),
    cwd: tempDir,
  });
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(selected.client);
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockImplementation((clientId) =>
    clientId === previous.client.getInstanceId()
      ? { client: previous.client, release: vi.fn() }
      : undefined,
  );
  try {
    await prepareTestConversationBinding({ sessionFile, threadId });
    const selectedRequests = selected.writes.map((line): { method: string; params: unknown } =>
      JSON.parse(line),
    );
    expect(selectedRequests.find(({ method }) => method === "config/read")?.params).toEqual({
      cwd: tempDir,
      includeLayers: true,
    });
    expect(selectedRequests.find(({ method }) => method === "thread/resume")?.params).toMatchObject(
      {
        threadId,
        cwd: tempDir,
        config: { project_doc_max_bytes: 240_000 },
      },
    );
    expect(previous.writes.map((line) => JSON.parse(line).method)).toEqual(["thread/unsubscribe"]);
    await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
      threadId,
      clientId: selected.client.getInstanceId(),
    });
  } finally {
    previous.client.close();
    selected.client.close();
  }
});

it.each(["commit", "retention"] as const)(
  "preserves the current owner when attachment fails during %s",
  async (expiresDuring) => {
    const retry = await useRealRequestScope();
    const sessionFile = path.join(tempDir, "expired-attachment.jsonl");
    const threadId = "thread-expired-attachment";
    const existingThreadId = expiresDuring === "commit" ? "thread-previous-attachment" : threadId;
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const release = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(harness.client, existingThreadId, release);
    const releaseSibling = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(harness.client, "thread-sibling", releaseSibling);
    await writeTestConversationBinding(sessionFile, {
      threadId: existingThreadId,
      clientId: harness.client.getInstanceId(),
      cwd: tempDir,
    });
    const before = await readTestConversationBinding(sessionFile);
    const response = conversationThreadStartResult(tempDir, threadId, true);
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
      client: harness.client,
      release: vi.fn(),
    });
    const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(0);
    let resumeAccepted = false;
    const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
      if (method === "thread/read") {
        return { thread: response.thread } as never;
      }
      if (method === "thread/resume") {
        resumeAccepted = true;
        return response as never;
      }
      if (method === "thread/unsubscribe") {
        return {} as never;
      }
      throw new Error(`unexpected Codex method ${method}`);
    });

    try {
      await expect(
        prepareTestConversationBinding({
          pluginConfig: { appServer: { requestTimeoutMs: 1_000 } },
          sessionFile,
          threadId,
          bindingStore: {
            ...testCodexAppServerBindingStore,
            readAsync: async (identity) => {
              if (resumeAccepted) {
                if (expiresDuring === "retention") {
                  elapsedClock.mockReturnValue(1_001);
                }
              }
              return await testCodexAppServerBindingStore.readAsync(identity);
            },
            mutate: async (...args) => {
              if (expiresDuring === "commit") {
                elapsedClock.mockReturnValue(1_001);
              }
              return await testCodexAppServerBindingStore.mutate(...args);
            },
          },
        }),
      ).rejects.toThrow("timed out");

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "thread/read",
        "thread/resume",
        "thread/unsubscribe",
      ]);
      expect(release).toHaveBeenCalledOnce();
      expect(releaseSibling).not.toHaveBeenCalled();
      expect(harness.stdinDestroyed).toBe(false);
      await expectLiveThread(harness.client, "thread-sibling");
      await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(before);
      await expect(
        consumeCodexAppServerLiveThread(harness.client, threadId),
      ).resolves.toBeUndefined();
    } finally {
      retry.mockRestore();
      harness.client.close();
      elapsedClock.mockRestore();
    }
  },
);

it("never resumes or unsubscribes an actively claimed native child for a conversation", async () => {
  const sessionFile = path.join(tempDir, "active-child-session.jsonl");
  const harness = createClientHarness();
  const request = vi
    .spyOn(harness.client, "request")
    .mockResolvedValue(conversationThreadStartResult(tempDir, "thread-active-child") as never);
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
  const parent = await codexNativeSubagentMonitorRuntime.register({
    client: harness.client,
    parentThreadId: "thread-parent",
  });
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);

  try {
    harness.send({
      method: "thread/started",
      params: {
        thread: {
          id: "thread-active-child",
          parentThreadId: "thread-parent",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "thread-parent",
                depth: 1,
                agent_path: "thread-active-child",
              },
            },
          },
        },
      },
    });
    await vi.waitFor(() =>
      expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-active-child")).toBe(true),
    );

    await expect(
      prepareTestConversationBinding({
        sessionFile,
        threadId: "thread-active-child",
      }),
    ).rejects.toThrow("active run");

    expect(request).not.toHaveBeenCalled();
    expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-active-child")).toBe(true);
  } finally {
    await parent.unregister();
    harness.client.close();
  }
});

it("preserves a stored child binding when resumed direct input is refused", async () => {
  const sessionKey = "agent:main:dashboard:incognito-child";
  const sessionFile = path.join(tempDir, "stored-child.jsonl");
  const harness = createClientHarness();
  ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
  const threadId = "thread-parent-owned";
  await writeTestConversationBinding(sessionFile, { threadId, cwd: tempDir });
  const before = await readTestConversationBinding(sessionFile);
  const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
    if (method === "thread/read") {
      return {
        thread: conversationThreadStartResult(tempDir, threadId, null).thread,
      } as never;
    }
    if (method === "thread/resume") {
      return conversationThreadStartResult(tempDir, threadId, false) as never;
    }
    if (method === "thread/unsubscribe") {
      return {} as never;
    }
    throw new Error(`unexpected Codex method ${method}`);
  });
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
  const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);

  try {
    await expect(handleCodexConversationInboundClaim(event, ctx)).resolves.toMatchObject({
      handled: true,
      reply: { text: expect.stringContaining("controlled by its parent") },
    });
    await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(before);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "thread/unsubscribe",
    ]);
    await expect(
      consumeCodexAppServerLiveThread(harness.client, threadId),
    ).resolves.toBeUndefined();
  } finally {
    harness.client.close();
  }
});

it.each([false, true])(
  "transfers exact physical ownership during bound turns (old release fails: %s)",
  async (rejectOldRelease) => {
    const sessionFile = path.join(tempDir, "same-thread-client-migration.jsonl");
    const { previousClient, replacementClient, operations, ownerDuringRelease, readOwner } =
      await createSameThreadClientMigrationFixture(sessionFile, {
        rejectOldRelease,
      });

    const { event, ctx } = boundConversationClaim(sessionFile);
    const result = await handleCodexConversationInboundClaim(event, ctx, { timeoutMs: 500 });
    expect(result?.reply?.text).toContain(
      rejectOldRelease ? "previous physical client unsubscribe failed" : "Migrated reply",
    );

    const expectedOperations = ["replacement:thread/resume", "previous:thread/unsubscribe"];
    if (rejectOldRelease) {
      expectedOperations.push("replacement:thread/unsubscribe");
    } else {
      expectedOperations.push("replacement:turn/start");
    }
    expect(operations).toEqual(expectedOperations);
    expect(ownerDuringRelease).toEqual(["client-before-migration"]);
    await expect(readOwner()).resolves.toMatchObject({
      threadId: "thread-migrated",
      clientId: rejectOldRelease ? "client-before-migration" : "client-after-migration",
    });
    const survivingClient = rejectOldRelease ? previousClient : replacementClient;
    const obsoleteClient = rejectOldRelease ? replacementClient : previousClient;
    await expectLiveThread(survivingClient, "thread-migrated");
    await expect(
      consumeCodexAppServerLiveThread(obsoleteClient, "thread-migrated"),
    ).resolves.toBeUndefined();
  },
);

it.each([
  {
    label: "binding-agent auto mode over a full host default",
    config: {
      tools: { exec: { mode: "full" } },
      agents: { entries: { "bot-a": { tools: { exec: { mode: "auto" } } } } },
    },
    approvals: { version: 1, agents: {} } satisfies ExecApprovalsFile,
    error: "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
  },
  {
    label: "host approval floor without config",
    config: undefined,
    approvals: {
      version: 1,
      defaults: { security: "deny", ask: "off" },
      agents: {},
    } satisfies ExecApprovalsFile,
    error: "tools.exec.mode=deny",
  },
])("rejects binding for $label before native requests", async ({ config, approvals, error }) => {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const request = vi.fn();
  execApprovalsRuntimeMocks.loadExecApprovalsReadOnlyAsync.mockResolvedValue(approvals);
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

  await expect(
    prepareTestConversationBinding({
      config: config as never,
      sessionFile,
      agentId: config ? "bot-a" : undefined,
      model: "gpt-5.4-mini",
    }),
  ).rejects.toThrow(error);
  expect(execApprovalsRuntimeMocks.loadExecApprovalsReadOnlyAsync).toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("retires an already-evicted conversation without disturbing its live client siblings", async () => {
  const identity = { kind: "conversation" as const, bindingId: "binding-evicted" };
  const client = {
    request: vi.fn(async () => ({})),
    addCloseHandler: vi.fn(),
    addNotificationHandler: vi.fn(),
    addRequestHandler: vi.fn(),
  } as unknown as CodexAppServerClient;
  ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
  const releaseEvicted = vi.fn(async (_threadId: string) => undefined);
  await retainCodexAppServerLiveThread(client, "thread-evicted", releaseEvicted);
  for (let index = 0; index < 64; index += 1) {
    await retainCodexAppServerLiveThread(client, `thread-sibling-${index}`, async () => undefined);
  }
  expect(releaseEvicted).toHaveBeenCalledExactlyOnceWith("thread-evicted", undefined, undefined);
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
    client,
    release: vi.fn(),
  });
  await seedBinding(identity, {
    threadId: "thread-evicted",
    clientId: "client-with-siblings",
    conversationStartId: "start-evicted",
  });

  await denyConversationBinding(
    conversationData(identity.bindingId, {
      start: { id: "start-evicted" },
    }),
  );

  expect(testCodexAppServerBindingStore.read(identity)).toBeUndefined();
  await expectLiveThread(client, "thread-sibling-0");
});

it("keeps a denied conversation binding when native unsubscribe fails", async () => {
  const identity = { kind: "conversation" as const, bindingId: "binding-failed-denial" };
  const request = vi.fn(async () => {
    throw new Error("native unsubscribe failed");
  });
  const closeAndWait = vi.fn(async () => true);
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
    client: { request, closeAndWait },
    release: vi.fn(),
  });
  await seedBinding(identity, {
    threadId: "thread-failed-denial",
    clientId: "client-failed-denial",
    conversationStartId: "start-failed-denial",
  });

  await expect(
    denyConversationBinding(
      conversationData(identity.bindingId, {
        source: {
          agentId: "main",
          sessionId: "session-incognito",
          threadId: "thread-source",
          sessionKey: "agent:main:dashboard:incognito-native-bind",
        },
        start: { id: "start-failed-denial" },
      }),
    ),
  ).rejects.toThrow("subscription could not be released");

  expect(request).toHaveBeenCalledWith(
    "thread/unsubscribe",
    { threadId: "thread-failed-denial" },
    expect.objectContaining({ timeoutMs: expect.any(Number) }),
  );
  expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
    threadId: "thread-failed-denial",
  });
  expect(closeAndWait).toHaveBeenCalledOnce();
});

it("preserves the live conversation generation when a replacement bind is denied", async () => {
  const identity = { kind: "conversation" as const, bindingId: "binding-data-1" };
  await seedBinding(identity, {
    threadId: "thread-old",
    conversationStartId: "start-old",
  });

  await denyConversationBinding(
    conversationData("binding-data-1", {
      start: { id: "start-new", threadId: "thread-new" },
    }),
  );

  expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
    threadId: "thread-old",
    conversationStartId: "start-old",
  });
});

it("rejects attaching a conversation to another session's owned thread", async () => {
  const otherIdentity = {
    kind: "session" as const,
    agentId: "main",
    sessionId: "session-other",
  };
  await seedBinding(otherIdentity, { threadId: "thread-owned" });
  const request = vi.fn(async () => conversationThreadStartResult(tempDir, "thread-owned"));
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({ request });

  await expect(
    prepareTestConversationBinding({
      sessionFile: path.join(tempDir, "session.jsonl"),
      threadId: "thread-owned",
    }),
  ).rejects.toThrow("owned by another OpenClaw session");
  expect(request).not.toHaveBeenCalled();
  expect(testCodexAppServerBindingStore.read(otherIdentity)).toMatchObject({
    threadId: "thread-owned",
  });
});

it.each([
  { commandAuthorized: undefined, reply: undefined },
  {
    commandAuthorized: true,
    reply: { text: "Only an owner or operator.admin can control Codex native execution." },
  },
])(
  "blocks unauthorized inbound bound turns (command auth: $commandAuthorized)",
  async ({ commandAuthorized, reply }) => {
    const result = await handleCodexConversationInboundClaim(
      {
        content: "run this",
        channel: "discord",
        isGroup: true,
        senderIsOwner: false,
        commandAuthorized,
      },
      conversationClaimContext(
        legacyConversationData(path.join(tempDir, "session.jsonl")),
        undefined,
        { channel: "discord", conversationId: "channel-1" },
      ),
    );

    expect(result).toEqual({ handled: true, ...(reply ? { reply } : {}) });
    expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
  },
);

it("keeps the bound agent node exec block ahead of current-session exec host overrides", async () => {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  await writeTestConversationBinding(sessionFile, { threadId: "thread-1", cwd: tempDir });
  await seedSession({ sessionKey: "agent:main:session-1", sessionId: "session-1" }, storePath, {
    execHost: "gateway",
  });

  const result = await handleCodexConversationInboundClaim(
    conversationMessage("continue the task", {
      channel: "discord",
      isGroup: true,
      sessionKey: "agent:main:session-1",
    }),
    conversationClaimContext(
      legacyConversationData(sessionFile, { agentId: "bot-a" }),
      "agent:main:session-1",
      { channel: "discord", conversationId: "channel-1" },
    ),
    {
      config: {
        session: {
          store: path.join(tempDir, "agents", "{agentId}", "sessions", "sessions.json"),
        },
        tools: { exec: { host: "gateway" } },
        agents: {
          entries: { "bot-a": { tools: { exec: { host: "node", node: "worker-1" } } } },
        },
      } as never,
    },
  );

  expect(result?.handled).toBe(true);
  expect(result?.reply?.text).toContain("OpenClaw exec host=node is active");
  expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
});

it("blocks bound Codex CLI node turns when the current OpenClaw session is sandboxed", async () => {
  const resumeCodexCliSessionOnNode = vi.fn();
  const config = { agents: { defaults: { sandbox: { mode: "all" as const } } } };
  setRuntimeConfigSnapshot(config);

  const result = await handleCodexConversationInboundClaim(
    conversationMessage("continue the task", {
      channel: "discord",
      isGroup: true,
      sessionKey: "sandboxed-session",
    }),
    conversationClaimContext(
      {
        kind: "codex-cli-node-session",
        version: 1,
        nodeId: "mb-m5",
        sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
        cwd: "/repo",
      },
      "sandboxed-session",
      { channel: "discord", conversationId: "channel-1" },
    ),
    {
      config,
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

it("re-reads source-owned permission roots while resuming an unloaded bound thread", async () => {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const storePath = path.join(tempDir, "recovery.sqlite");
  const source = sourceSession("recovery-source");
  const recoveredRoot = path.join(tempDir, "recovered-root");
  await seedSession(source, storePath, { permissionMode: "full", sessionRoot: tempDir });
  codexRequirementsTomlMock.mockReturnValue(WORKSPACE_REQUIREMENTS);
  agentRuntimeMocks.ensureAuthProfileStoreAsync.mockResolvedValue({
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
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    serviceTier: "fast",
  });
  let submitted = false;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const notificationHandlers: Array<(notification: Record<string, unknown>) => void> = [];
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
    request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
      requests.push({ method, params: requestParams });
      if (method === "turn/start" && !submitted) {
        submitted = true;
        await seedSession(source, storePath, {
          permissionMode: "workspace",
          sessionRoot: recoveredRoot,
        });
        throw rpcError("thread not found: thread-old", method);
      }
      if (method === "thread/read") {
        return { thread: conversationThreadStartResult(tempDir, "thread-old").thread };
      }
      if (method === "thread/resume") {
        return conversationThreadStartResult(recoveredRoot, "thread-old");
      }
      if (method === "turn/start" && requestParams.threadId === "thread-old") {
        setImmediate(() => {
          for (const handler of notificationHandlers) {
            handler(turnCompleted("thread-old", "turn-new", "Recovered", "assistant-1"));
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
    conversationMessage("hi again", { bodyForAgent: "hi again" }),
    conversationClaimContext(
      conversationData(legacyCodexConversationBindingId(sessionFile), {
        source: {
          agentId: source.agentId,
          sessionId: source.sessionId,
          threadId: source.threadId,
        },
      }),
    ),
    { config: { session: { store: storePath } }, timeoutMs: 500 },
  );

  await expectReply(result, "Recovered");
  expect(requests.map((request) => request.method)).toEqual([
    "turn/start",
    "thread/read",
    "thread/resume",
    "turn/start",
  ]);
  expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledWith(
    expect.objectContaining({ authProfileId: "work" }),
  );
  expect(requests[0]?.params).toMatchObject({
    ...workspacePolicy(tempDir),
  });
  expect(requests[2]?.params).toMatchObject({
    model: "gpt-5.4-mini",
    serviceTier: "priority",
    modelProvider: "openai",
    ...workspacePolicy(recoveredRoot),
    sandbox: "workspace-write",
  });
  expect(requests[3]?.params.input).toEqual(requests[0]?.params.input);
  expect(requests[3]?.params).toMatchObject({
    threadId: "thread-old",
    serviceTier: "priority",
    ...workspacePolicy(recoveredRoot),
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [recoveredRoot] },
  });
  const savedBinding = await readTestConversationBinding(sessionFile);
  expect(savedBinding).toMatchObject({
    threadId: "thread-old",
    authProfileId: "work",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    serviceTier: "priority",
  });
  expect(savedBinding).not.toHaveProperty("modelProvider");
});

it.each([
  ["untyped failure", new Error("thread not found: thread-1")],
  ["wrong method", rpcError("thread not found: thread-1", "turn/steer")],
  ["wrong thread", rpcError("thread not found: another-thread")],
  ["internal error", rpcError("thread not found: thread-1", "turn/start", -32_603)],
  ["auth failure", rpcError("authentication required")],
] satisfies [string, Error][])("does not replay a bound turn after %s", async (_label, error) => {
  const sessionFile = await boundSession("no-replay.jsonl");
  const binding = await readTestConversationBinding(sessionFile);
  const request = vi.fn(async () => {
    throw error;
  });
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
    request,
    addNotificationHandler: vi.fn(() => () => undefined),
    addRequestHandler: vi.fn(() => () => undefined),
  });
  const { event, ctx } = boundConversationClaim(sessionFile);
  await expectReply(
    handleCodexConversationInboundClaim(event, ctx),
    `Codex app-server turn failed: ${error.message}`,
  );
  expect(request).toHaveBeenCalledOnce();
  await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(binding);
});

it.each(["deleted history", "resume auth failure"] as const)(
  "preserves the binding and does not submit input when recovery encounters %s",
  async (failure) => {
    const sessionFile = await boundSession("failed-reload.jsonl");
    const binding = await readTestConversationBinding(sessionFile);
    const request = rpcResponses({
      "turn/start": rpcError("thread not found: thread-1"),
      "thread/read":
        failure === "deleted history"
          ? rpcError("thread not loaded: thread-1", "thread/read")
          : { thread: conversationThreadStartResult(tempDir, "thread-1").thread },
      "thread/resume": rpcError("authentication required; sign in again", "thread/resume"),
      "thread/unsubscribe": { status: "notLoaded" },
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const { event, ctx } = boundConversationClaim(sessionFile);
    const result = await handleCodexConversationInboundClaim(event, ctx);
    expect(result?.reply?.text).toContain(
      failure === "deleted history"
        ? "Your message was not submitted; rebind the conversation and resend it."
        : "authentication required; sign in again",
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual(
      failure === "deleted history"
        ? ["turn/start", "thread/read"]
        : ["turn/start", "thread/read", "thread/resume", "thread/unsubscribe"],
    );
    await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(binding);
  },
);

it("moves session history while clamping rootless inherited cwd to the agent workspace", async () => {
  const source = sourceSession("source-session");
  const storePath = path.join(tempDir, "source.sqlite");
  await seedSession(source, storePath, { permissionMode: "workspace" });
  await seedSession(sourceSession("destination-session"), storePath);
  codexRequirementsTomlMock.mockReturnValue(WORKSPACE_REQUIREMENTS);
  await appendSessionTranscriptMessageByIdentity({
    ...source,
    storePath,
    message: { role: "user", content: "Earlier question", timestamp: 1 },
  });
  await appendSessionTranscriptMessageByIdentity({
    ...source,
    storePath,
    message: { role: "assistant", content: "Earlier answer", timestamp: 2 },
  });
  const sourceIdentity = {
    kind: "session" as const,
    agentId: source.agentId,
    sessionId: source.sessionId,
    sessionKey: source.sessionKey,
  };
  await testCodexAppServerBindingStore.mutate(sourceIdentity, {
    kind: "set",
    binding: {
      threadId: source.threadId,
      clientId: "source-client",
      cwd: path.join(tempDir, "..", "outside-rootless-session"),
      model: "gpt-5.5",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      dynamicToolsFingerprint: "harness-only-tools",
    },
  });
  const releaseSource = vi.fn(async (_threadId: string, assertCurrent?: () => void) => {
    assertCurrent?.();
  });
  const { client, operations: requests } = replyingClient(
    "thread-bound",
    "turn-bound",
    "Bound reply",
    "source-client",
    {
      "thread/start": () => conversationThreadStartResult(tempDir, "thread-bound"),
      "thread/inject_items": () => ({}),
    },
  );
  ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
  await retainCodexAppServerLiveThread(client, source.threadId, releaseSource);
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
  sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
    client,
    release: vi.fn(),
  });
  const { event, ctx } = boundConversationClaim(
    path.join(tempDir, "session.jsonl"),
    "agent:main:destination-session",
  );
  ctx.pluginBinding.data = conversationData("binding-source-transfer", { source });

  await expectReply(
    handleCodexConversationInboundClaim(event, ctx, {
      config: { session: { store: storePath } },
      timeoutMs: 500,
    }),
    "Bound reply",
  );

  expect(requests.map(({ method }) => method)).toEqual([
    "thread/start",
    "thread/inject_items",
    "turn/start",
  ]);
  expect(requests[0]?.params).toMatchObject({
    cwd: "/agent/workspace",
    runtimeWorkspaceRoots: ["/agent/workspace"],
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    developerInstructions: expect.stringContaining("bound to an OpenClaw conversation"),
    config: { apps: { _default: { enabled: false } }, "features.apps": false },
  });
  expect(requests[2]?.params).toMatchObject({
    cwd: "/agent/workspace",
    runtimeWorkspaceRoots: ["/agent/workspace"],
    sandboxPolicy: { type: "workspaceWrite" },
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
  });
  expect(requests[0]?.params).not.toHaveProperty("dynamicTools");
  expect(requests[1]?.params.items).toMatchObject([
    { role: "user", content: [{ text: "Earlier question" }] },
    { role: "assistant", content: [{ text: "Earlier answer" }] },
  ]);
  expect(releaseSource).toHaveBeenCalledExactlyOnceWith(
    "thread-source",
    undefined,
    expect.any(Function),
  );
  expect(testCodexAppServerBindingStore.read(sourceIdentity)).toBeUndefined();
  await expectLiveThread(client, "thread-bound");
});

it.each([
  { label: "a registered source run after its client was retired", exposeClient: false },
  { label: "a live client whose source subscription is claimed", exposeClient: true },
])("does not transfer $label into a bound conversation", async ({ exposeClient }) => {
  const source = sourceSession("active-source-session", "thread-active-source");
  const sourceIdentity = {
    kind: "session" as const,
    agentId: source.agentId,
    sessionId: source.sessionId,
    sessionKey: source.sessionKey,
  };
  const storePath = path.join(tempDir, "active-source.sqlite");
  await seedSession(source, storePath);
  await seedBinding(sourceIdentity, { threadId: source.threadId, clientId: "active-client" });
  const request = rpcResponses({
    "thread/start": conversationThreadStartResult(tempDir, "thread-active-target"),
  });
  const client = {
    getInstanceId: () => "active-client",
    request,
    ...clientListeners(),
  } as unknown as CodexAppServerClient;
  ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
  if (exposeClient) {
    await retainCodexAppServerLiveThread(client, source.threadId, async () => undefined);
    await consumeCodexAppServerLiveThread(client, source.threadId);
    sharedClientMocks.retainSharedCodexAppServerClientByInstanceId.mockReturnValue({
      client,
      release: vi.fn(),
    });
  }
  const activeRun = {
    runId: "active-source-run",
    toolAuthorityFingerprint: undefined as string | undefined,
    queueMessage: async () => undefined,
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
  };
  const { event, ctx } = boundConversationClaim(path.join(tempDir, "active-source.jsonl"));
  ctx.pluginBinding.data = conversationData("binding-active-source", {
    source,
    start: { id: "start-active-source" },
  });

  const claimSource = async () => {
    const result = await handleCodexConversationInboundClaim(event, ctx, {
      config: { session: { store: storePath } },
      timeoutMs: 500,
    });

    expect(result?.reply?.text).toContain("active run");
    expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/start"]);
    expect(testCodexAppServerBindingStore.read(sourceIdentity)).toMatchObject({
      threadId: source.threadId,
    });
    expect(
      testCodexAppServerBindingStore.read({
        kind: "conversation",
        bindingId: "binding-active-source",
      }),
    ).not.toHaveProperty("conversationSourceTransferComplete", true);
  };
  if (exposeClient) {
    await claimSource();
    return;
  }
  // A registered source run owns an admitted turn on its session, as in a Gateway run.
  await runInHarnessToolAuthorityForTest(
    {
      ...source,
      sessionFile: path.join(tempDir, "active-source.jsonl"),
      workspaceDir: tempDir,
      runId: activeRun.runId,
      provider: "codex",
      modelId: "fixture",
    },
    "codex",
    async (prepared) => {
      activeRun.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
      const cleanup = setActiveEmbeddedRun(
        source.sessionId,
        activeRun,
        source.sessionKey,
        prepared.sessionFile,
        source.agentId,
      );
      try {
        await claimSource();
      } finally {
        clearActiveEmbeddedRun(
          source.sessionId,
          activeRun,
          source.sessionKey,
          prepared.sessionFile,
          undefined,
          cleanup,
        );
      }
    },
  );
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
  const sessionFile = await boundSession("session.jsonl", {
    threadId: "thread-1",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  });

  const result = await handleCodexConversationInboundClaim(
    conversationMessage("continue", {
      bodyForAgent: "continue",
      sessionKey: "agent:main:session-1",
    }),
    conversationClaimContext(legacyConversationData(sessionFile), "agent:main:session-1"),
    {
      timeoutMs: 50,
      config: {
        tools: {
          exec: {
            security: "full",
            ask: "on-miss",
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
          ask: "on-miss",
        },
      },
    },
    sessionKey: "agent:main:session-1",
    workspaceDir: "/agent/workspace",
  });
  expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
});

it.each([
  {
    label: "escapes a provider failure",
    retirementFails: false,
    error:
      "unexpected status 401 Unauthorized: Missing bearer <@U123> [trusted](https://evil) @here",
    expected:
      "unexpected status 401 Unauthorized: Missing bearer &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
  },
  {
    label: "preserves the original failure when client retirement also rejects",
    retirementFails: true,
    error: "original bound turn failure",
    expected: "original bound turn failure",
  },
])(
  "returns a clean incognito failure reply: $label",
  async ({ retirementFails, error, expected }) => {
    const sessionFile = path.join(tempDir, "session.jsonl");
    const sessionKey = "agent:main:dashboard:incognito-bound-failure";
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
    const request = rpcResponses({
      "turn/start": new Error(error),
      "thread/unsubscribe": retirementFails ? new Error("thread unsubscribe failed") : {},
    });
    const closeAndWait = vi.fn(async () => {
      throw new Error("client retirement failed");
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      ...(retirementFails ? { closeAndWait } : {}),
      request,
      addNotificationHandler: vi.fn(() => () => undefined),
      addRequestHandler: vi.fn(() => () => undefined),
    });

    try {
      const result = await handleCodexConversationInboundClaim(
        conversationMessage("hi", { bodyForAgent: "hi", sessionKey }),
        conversationClaimContext(legacyConversationData(sessionFile, { agentDir }), sessionKey),
        { timeoutMs: 50 },
      );
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      await expectReply(result, `Codex app-server turn failed: ${expected}`);
      const replyText = result?.reply?.text ?? "";
      expect(replyText).not.toContain("<@U123>");
      expect(replyText).not.toContain("[trusted](https://evil)");
      expect(replyText).not.toContain("@here");
      expect(sharedClientMocks.getSharedCodexAppServerClient).toHaveBeenCalledWith(
        expect.objectContaining({ agentDir }),
      );
      expect(unhandledRejections).toStrictEqual([]);
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "turn/start",
        "thread/unsubscribe",
      ]);
      if (retirementFails) {
        expect(closeAndWait).toHaveBeenCalledOnce();
      }
      await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  },
);

it.each([
  { label: "structured failure", code: -32_603, cleaned: true },
  { label: "overload rejection", code: -32_001, cleaned: false },
  { label: "indeterminate failure with sibling leases", code: undefined, cleaned: true },
])("preserves incognito reconnect $label without redundant cleanup", async ({ code, cleaned }) => {
  const sessionFile = await boundSession("incognito-reconnect.jsonl");
  const binding = await readTestConversationBinding(sessionFile);
  const retired = code === undefined;
  const rejection = retired
    ? new Error("thread not found: thread-1")
    : new CodexAppServerRpcError(
        {
          code,
          message: cleaned ? "resume response assembly failed" : "thread not found: thread-1",
        },
        "thread/resume",
      );
  let unsubscribed = false;
  const request = vi.fn(async (method: string) => {
    if (method === "thread/read") {
      return { thread: conversationThreadStartResult(tempDir, "thread-1").thread };
    }
    if (method === "thread/resume") {
      throw rejection;
    }
    if (method === "thread/unsubscribe" && cleaned && !retired && !unsubscribed) {
      unsubscribed = true;
      return { status: "unsubscribed" };
    }
    throw new Error(`unexpected cleanup or fallback: ${method}`);
  });
  const closeAndWait = vi.fn(async () => true);
  const client = { request, closeAndWait, getInstanceId: () => "reconnected-client" };
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
  if (retired) {
    sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed
      .mockReturnValueOnce({ found: true, closed: false })
      .mockReturnValue({ found: false, closed: false });
    sharedClientMocks.retireSharedCodexAppServerClientIfCurrent
      .mockReturnValueOnce({ activeLeases: 2, closed: false })
      .mockReturnValue(undefined);
  }
  const { event, ctx } = boundConversationClaim(
    sessionFile,
    "agent:main:dashboard:incognito-reconnect",
  );

  await expectReply(
    handleCodexConversationInboundClaim(event, ctx),
    `Codex app-server turn failed: ${rejection.message}`,
  );
  expect(request.mock.calls.map(([method]) => method)).toEqual(
    cleaned && !retired
      ? ["thread/read", "thread/resume", "thread/unsubscribe"]
      : ["thread/read", "thread/resume"],
  );
  if (retired) {
    expect(
      sharedClientMocks.retireSharedCodexAppServerClientIfCurrent,
    ).toHaveBeenCalledExactlyOnceWith(client);
  } else {
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
  }
  expect(closeAndWait).not.toHaveBeenCalled();
  await expect(readTestConversationBinding(sessionFile)).resolves.toEqual(
    cleaned ? undefined : binding,
  );
});

it("retains a pre-start final after a saturated commentary stream", async () => {
  const sessionFile = await boundSession();
  let notificationHandler: ((notification: unknown) => void) | undefined;
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
    request: vi.fn(async (method: string) => {
      if (method !== "turn/start") {
        throw new Error(`unexpected method: ${method}`);
      }
      for (let index = 0; index < 100; index += 1) {
        notificationHandler?.({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: `commentary-${index}`,
              text: `progress ${index}`,
              phase: "commentary",
            },
          },
        });
      }
      notificationHandler?.({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "agentMessage", id: "answer", text: "authoritative answer" },
        },
      });
      notificationHandler?.({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null, items: [] },
        },
      });
      return { turn: { id: "turn-1" } };
    }),
    addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
      notificationHandler = handler;
      return () => undefined;
    }),
    addRequestHandler: vi.fn(() => () => undefined),
  });
  const { event, ctx } = boundConversationClaim(sessionFile);

  await expectReply(handleCodexConversationInboundClaim(event, ctx), "authoritative answer");
});

it.each([
  { status: "interrupted", error: null, message: "codex app-server turn interrupted" },
  {
    status: "failed",
    error: { message: "codex app-server bound turn timed out" },
    message: "codex app-server bound turn timed out",
  },
])(
  "reports terminal $status without a partial reply or a local interrupt",
  async ({ status, error, message }) => {
    const sessionFile = await boundSession();
    let notificationHandler: ((notification: unknown) => void) | undefined;
    const request = vi.fn(async (method: string) => {
      if (method !== "turn/start") {
        throw new Error(`unexpected method: ${method}`);
      }
      queueMicrotask(() => {
        if (status === "interrupted") {
          notificationHandler?.({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "item-1",
              delta: "unfinished answer",
            },
          });
        }
        notificationHandler?.({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: {
              id: "turn-1",
              status,
              error,
              items: [],
            },
          },
        });
      });
      return { turn: { id: "turn-1" } };
    });
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
      request,
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandler = handler;
        return () => undefined;
      }),
      addRequestHandler: vi.fn(() => () => undefined),
    });
    const { event, ctx } = boundConversationClaim(sessionFile);

    await expectReply(
      handleCodexConversationInboundClaim(event, ctx),
      `Codex app-server turn failed: ${message}`,
    );

    expect(request.mock.calls.map(([method]) => method)).toEqual(["turn/start"]);
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
    await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
      threadId: "thread-1",
    });
  },
);

it("interrupts an indeterminate incognito native turn before cleanup", async () => {
  const sessionKey = "agent:main:dashboard:incognito-start-timeout";
  const sessionFile = path.join(tempDir, "session.jsonl");
  const harness = createClientHarness();
  await writeTestConversationBinding(sessionFile, {
    threadId: "thread-1",
    clientId: harness.client.getInstanceId(),
    cwd: tempDir,
  });
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(harness.client);
  const waitForRequest = async (method: string) =>
    await vi.waitFor(
      () => {
        const request = harness.writes
          .map((write) => JSON.parse(write) as { id: number; method: string; params: unknown })
          .find((message) => message.method === method);
        if (!request) {
          throw new Error(`Codex conversation harness did not write ${method}`);
        }
        return request;
      },
      { interval: 1, timeout: 5_000 },
    );
  const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);
  const result = handleCodexConversationInboundClaim(event, ctx, {
    pluginConfig: { appServer: { requestTimeoutMs: 100 } },
  });
  try {
    const turnStart = await waitForRequest("turn/start");
    const interrupt = await waitForRequest("turn/interrupt");
    expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "" });
    harness.send({ id: turnStart.id, result: { turn: { id: "turn-1" } } });
    harness.send({ id: interrupt.id, result: {} });
    const unsubscribe = await waitForRequest("thread/unsubscribe");
    harness.send({ id: unsubscribe.id, result: {} });

    await expectReply(result, "Codex app-server turn failed: turn/start timed out");
    expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
      "turn/start",
      "turn/interrupt",
      "thread/unsubscribe",
    ]);
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
    expect(readCodexConversationActiveTurn(testConversationIdentity(sessionFile))).toBeUndefined();
    await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
  } finally {
    harness.client.close();
    await Promise.allSettled([result]);
  }
});

it("interrupts a timed-out incognito turn before removing active tracking and handlers", async () => {
  const sessionKey = "agent:main:dashboard:incognito-turn-timeout";
  vi.useFakeTimers();
  try {
    const sessionFile = await boundSession();
    const identity = testConversationIdentity(sessionFile);
    const cleanupEvents: string[] = [];
    const notificationHandlers = new Set<(notification: unknown) => void>();
    const request = vi.fn(async (method: string) => {
      if (method === "turn/start") {
        return { turn: { id: "turn-1" } };
      }
      if (method === "thread/unsubscribe") {
        cleanupEvents.push("unsubscribe");
        return {};
      }
      if (method !== "turn/interrupt") {
        throw new Error(`unexpected method: ${method}`);
      }
      cleanupEvents.push("interrupt");
      expect(readCodexConversationActiveTurn(identity)).toMatchObject({
        threadId: "thread-1",
        turnId: "turn-1",
      });
      queueMicrotask(() => {
        cleanupEvents.push("turn completed");
        expect(readCodexConversationActiveTurn(identity)).toMatchObject({
          threadId: "thread-1",
          turnId: "turn-1",
        });
        for (const handler of notificationHandlers) {
          handler({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-1", status: "interrupted", error: null, items: [] },
            },
          });
        }
      });
      return {};
    });
    const client = {
      request,
      addNotificationHandler: vi.fn((handler: (notification: unknown) => void) => {
        notificationHandlers.add(handler);
        return () => {
          notificationHandlers.delete(handler);
          cleanupEvents.push("notification cleanup");
        };
      }),
      addRequestHandler: vi.fn(() => () => cleanupEvents.push("request cleanup")),
      addCloseHandler: vi.fn(() => () => undefined),
    };
    sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
    const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);
    const result = handleCodexConversationInboundClaim(event, ctx, { timeoutMs: 100 });

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledWith("turn/start", expect.any(Object), expect.any(Object));
    await vi.advanceTimersByTimeAsync(100);

    await expectReply(
      result,
      "Codex app-server turn failed: codex app-server bound turn timed out",
    );
    expect(request).toHaveBeenCalledWith(
      "turn/interrupt",
      { threadId: "thread-1", turnId: "turn-1" },
      { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
    );
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "turn/start",
      "turn/interrupt",
      "thread/unsubscribe",
    ]);
    expect(cleanupEvents).toEqual(["interrupt", "turn completed", "unsubscribe"]);
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
    expect(readCodexConversationActiveTurn(identity)).toBeUndefined();
    await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  { label: "an unconfirmed ordinary", sessionKey: undefined, acknowledged: true },
  {
    label: "a failed incognito",
    sessionKey: "agent:main:dashboard:incognito-interrupt-failure",
    acknowledged: false,
  },
])(
  "retires $label timeout interrupt once without closing sibling leases",
  async ({ sessionKey, acknowledged }) => {
    vi.useFakeTimers();
    try {
      const sessionFile = await boundSession();
      const identity = testConversationIdentity(sessionFile);
      const closeAndWait = vi.fn(async () => true);
      const request = rpcResponses({
        "turn/start": { turn: { id: "turn-1" } },
        "turn/interrupt": acknowledged ? {} : new Error("turn interrupt could not be confirmed"),
        "thread/unsubscribe": new Error("detached client must not receive another cleanup request"),
      });
      const client = {
        request,
        closeAndWait,
        ...clientListeners(),
      };
      sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
      sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed
        .mockReturnValueOnce({ found: true, closed: false })
        .mockReturnValue({ found: false, closed: false });
      sharedClientMocks.retireSharedCodexAppServerClientIfCurrent
        .mockReturnValueOnce({ activeLeases: 2, closed: false })
        .mockReturnValue(undefined);
      const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);
      const result = handleCodexConversationInboundClaim(event, ctx, { timeoutMs: 100 });

      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith("turn/start", expect.any(Object), expect.any(Object));
      await vi.advanceTimersByTimeAsync(100);
      expect(request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
      );
      if (acknowledged) {
        expect(readCodexConversationActiveTurn(identity)).toMatchObject({
          threadId: "thread-1",
          turnId: "turn-1",
        });
        expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000);
      }

      await expectReply(
        result,
        "Codex app-server turn failed: codex app-server bound turn timed out",
      );
      expect(request.mock.calls.map(([method]) => method)).toEqual([
        "turn/start",
        "turn/interrupt",
      ]);
      expect(
        sharedClientMocks.retireSharedCodexAppServerClientIfCurrent,
      ).toHaveBeenCalledExactlyOnceWith(client);
      expect(closeAndWait).not.toHaveBeenCalled();
      expect(readCodexConversationActiveTurn(identity)).toBeUndefined();
      if (sessionKey) {
        await expect(readTestConversationBinding(sessionFile)).resolves.toBeUndefined();
      } else {
        await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
          threadId: "thread-1",
        });
      }
    } finally {
      vi.useRealTimers();
    }
  },
);

it("refreshes stale network-proxy bound app-server threads before the turn", async () => {
  const sessionFile = await boundSession("session.jsonl", {
    threadId: "thread-old",
    networkProxyProfileName: "openclaw-network-stale",
    networkProxyConfigFingerprint: "stale-proxy-config",
    conversationStartId: "start-1",
    conversationSourceTransferComplete: true,
  });
  let notificationHandler: ((notification: unknown) => void) | undefined;
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue({
    request: vi.fn(async (method: string, requestParams: Record<string, unknown>) => {
      requests.push({ method, params: requestParams });
      if (method === "thread/start") {
        return conversationThreadStartResult(tempDir, "thread-new");
      }
      if (method === "turn/start") {
        setImmediate(() =>
          notificationHandler?.(turnCompleted("thread-new", "turn-1", "done", "item-1")),
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
    conversationMessage("hello"),
    conversationClaimContext(legacyConversationData(sessionFile)),
    {
      pluginConfig: {
        appServer: { ...NETWORK_PROXY_PLUGIN_CONFIG.appServer, serviceTier: "priority" },
      },
      timeoutMs: 50,
    },
  );

  await expectReply(result, "done");
  expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
  expect(requests[0]?.params.config).toMatchObject(NETWORK_PROXY_CONFIG_PATCH);
  expect(requests[0]?.params).not.toHaveProperty("sandbox");
  expect(requests[0]?.params.serviceTier).toBe("priority");
  expect(requests[1]?.params.threadId).toBe("thread-new");
  expect(requests[1]?.params).not.toHaveProperty("sandboxPolicy");
  const bindingAfterRefresh = await readTestConversationBinding(sessionFile);
  expect(bindingAfterRefresh).toMatchObject({
    threadId: "thread-new",
    networkProxyProfileName: NETWORK_PROXY_PROFILE_NAME,
    networkProxyConfigFingerprint: NETWORK_PROXY_CONFIG_FINGERPRINT,
    conversationStartId: "start-1",
    conversationSourceTransferComplete: true,
  });
});

it("restores the old owner and rolls back a network replacement when unsubscribe fails", async () => {
  const sessionFile = await boundSession("network-rotation-release-failure.jsonl", {
    threadId: "thread-old",
    clientId: "client-network-rotation",
    networkProxyProfileName: "openclaw-network-stale",
    networkProxyConfigFingerprint: "stale-proxy-config",
    conversationStartId: "start-1",
  });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    getInstanceId: () => "client-network-rotation",
    request: vi.fn(async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === "thread/start") {
        return conversationThreadStartResult(tempDir, "thread-new");
      }
      if (method === "thread/unsubscribe" && params.threadId === "thread-old") {
        throw new Error("old thread unsubscribe failed");
      }
      if (method === "thread/unsubscribe" && params.threadId === "thread-new") {
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    }),
    ...clientListeners(),
  } as unknown as CodexAppServerClient;
  ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
  await expect(
    retainCodexAppServerLiveThread(client, "thread-old", async (threadId) => {
      await client.request("thread/unsubscribe", { threadId });
    }),
  ).resolves.toBe(true);
  sharedClientMocks.getSharedCodexAppServerClient.mockResolvedValue(client);
  const { event, ctx } = boundConversationClaim(sessionFile);

  const result = await handleCodexConversationInboundClaim(event, ctx, {
    pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG,
  });

  expect(result?.reply?.text).toContain("old thread unsubscribe failed");
  expect(requests).toEqual([
    { method: "thread/start", params: expect.any(Object) },
    { method: "thread/unsubscribe", params: { threadId: "thread-old" } },
    { method: "thread/unsubscribe", params: { threadId: "thread-new" } },
  ]);
  await expect(readTestConversationBinding(sessionFile)).resolves.toMatchObject({
    clientId: "client-network-rotation",
    threadId: "thread-old",
  });
  expect(isCodexAppServerLiveThreadClaimed(client, "thread-old")).toBe(false);
  await expectLiveThread(client, "thread-old");
  await expect(consumeCodexAppServerLiveThread(client, "thread-new")).resolves.toBeUndefined();
});

it("refuses legacy custom-provider bindings requiring interactive approvals before connecting", async () => {
  const sessionFile = await boundSession("session.jsonl", {
    threadId: "thread-1",
    model: "lmstudio/local-model",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  await expect(
    handleCodexConversationInboundClaim(
      conversationMessage("hello"),
      conversationClaimContext(legacyConversationData(sessionFile)),
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

  expect(sharedClientMocks.getSharedCodexAppServerClient).not.toHaveBeenCalled();
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
