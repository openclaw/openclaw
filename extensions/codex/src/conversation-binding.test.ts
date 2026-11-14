import type { ReadFileSyncOptions } from "node:fs";
import path from "node:path";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { ExecApprovalsFile } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  runInHarnessToolAuthorityForTest,
  withAdmittedSessionTurnForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
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
  readBinding: vi.fn((): { bindingId: string } | null => ({ bindingId: "binding-1" })),
}));

const execApprovalsRuntimeMocks = vi.hoisted(() => ({
  loadExecApprovalsReadOnlyAsync: vi.fn<() => Promise<ExecApprovalsFile>>(async () => ({
    version: 1,
    agents: {},
  })),
}));

const agentRuntimeMocks = vi.hoisted(() => ({
  ensureAuthProfileStoreAsync: vi.fn(async () => ({ version: 1, profiles: {} })),
  loadAuthProfileStoreForSecretsRuntime: vi.fn(),
  resolveApiKeyForProfile: vi.fn(),
  resolveDefaultAgentDir: vi.fn(() => "/agent"),
  resolveAgentWorkspaceDir: vi.fn(() => "/agent/workspace"),
  resolvePersistedAuthProfileOwnerAgentDir: vi.fn(),
  resolveProviderIdForAuth: vi.fn((provider: string, _lookup?: { config?: unknown }) => provider),
  resolveSessionAgentIdsStrict: vi.fn(() => ({ defaultAgentId: "main", sessionAgentId: "main" })),
  saveAuthProfileStore: vi.fn(),
}));

const providerAuthMocks = vi.hoisted(() => ({ resolveAuthProfileOrder: vi.fn(() => []) }));

const codexRequirementsTomlMock = vi.hoisted(() => vi.fn<() => string | undefined>());
const resolveSandboxContextMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => Promise<{ enabled: boolean } | null>>(async () => null),
);
const configLayerPolicyMocks = vi.hoisted(() => ({
  readCodexEffectiveConfig: vi.fn<
    typeof import("./app-server/config-layer-policy.js").readCodexEffectiveConfig
  >(async () => ({ config: {}, origins: {}, layers: [] })),
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
  return { ...actual, resolveSandboxContext: resolveSandboxContextMock };
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
  consumeCodexAppServerLiveThread as consumeThread,
  ensureCodexAppServerClientRuntime as initializeClient,
  isCodexAppServerLiveThreadClaimed as isThreadClaimed,
  retainCodexAppServerLiveThread as retainThread,
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
  testCodexAppServerBindingStore as bindings,
  testConversationIdentity as bindingIdentity,
  writeTestConversationBinding as writeBinding,
  readTestConversationBinding as readBinding,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import { withCodexConversationThreadActivity } from "./app-server/thread-ownership.js";
import { getCodexAppServerTurnRouter } from "./app-server/turn-router.js";
import {
  createCodexConversationBindingData,
  legacyCodexConversationBindingId,
} from "./conversation-binding-data.js";
import { handleCodexConversationInboundClaim as claimConversationImpl } from "./conversation-binding-hooks.js";
import { prepareCodexConversationBinding } from "./conversation-binding-preparation.js";
import {
  conversationMessage,
  conversationThreadStartResult as threadResult,
  createConversationClaimFixtures,
} from "./conversation-binding.test-helpers.js";
import { readCodexConversationActiveTurn as activeTurn } from "./conversation-control.js";

function turnCompleted(threadId: string, id: string, text: string, itemId = "answer") {
  return {
    method: "turn/completed",
    params: {
      threadId,
      turn: { id, status: "completed", items: [{ type: "agentMessage", id: itemId, text }] },
    },
  };
}

function turnEnded(status: string, error: unknown = null) {
  return {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-1", status, error, items: [] } },
  };
}

function clientListeners(handlers?: Set<(notification: unknown) => unknown>) {
  return {
    addNotificationHandler: vi.fn((handler: (notification: unknown) => unknown) => {
      handlers?.add(handler);
      return () => {
        handlers?.delete(handler);
      };
    }),
    addRequestHandler: vi.fn(() => () => undefined),
    addCloseHandler: vi.fn(() => () => undefined),
  };
}

type ConversationResponse =
  | Record<string, unknown>
  | Error
  | ((params: Record<string, unknown>) => unknown);

function conversationClient(
  responses: Record<string, ConversationResponse>,
  clientId = "test-client",
) {
  const notifications = new Set<(notification: unknown) => unknown>();
  const operations: Array<{ method: string; params: Record<string, unknown> }> = [];
  const request = rpcResponses(responses, operations);
  const client = {
    request,
    getInstanceId: () => clientId,
    ...clientListeners(notifications),
  } as unknown as CodexAppServerClient;
  const notify = (notification: unknown) => {
    for (const handler of notifications) {
      handler(notification);
    }
  };
  return { client, request, operations, notify };
}

function replyingClient(
  threadId: string,
  turnId: string,
  text: string,
  clientId: string,
  responses: Record<string, () => unknown>,
) {
  const fixture = conversationClient(
    {
      ...responses,
      "turn/start": () => {
        queueMicrotask(() => fixture.notify(turnCompleted(threadId, turnId, text)));
        return { turn: { id: turnId } };
      },
    },
    clientId,
  );
  return fixture;
}

async function expectReply(result: unknown, text: string) {
  expect(await result).toEqual({ handled: true, reply: { text } });
}

async function expectReplyContaining(result: unknown, text: string) {
  expect(await result).toMatchObject({
    handled: true,
    reply: { text: expect.stringContaining(text) },
  });
}

function respondingHarness(responses: Record<string, unknown>) {
  return createClientHarness({
    onWrite: (line, send) => {
      const { id, method }: { id: number; method: string } = JSON.parse(line);
      if (!(method in responses)) {
        throw new Error(`Unexpected native request: ${method}`);
      }
      send({ id, result: responses[method] });
    },
  });
}

async function boundSession(
  filename = "session.jsonl",
  binding: Omit<Parameters<typeof writeBinding>[1], "cwd"> & { cwd?: string } = {
    threadId: "thread-1",
  },
) {
  const sessionFile = path.join(tempDir, filename);
  await writeBinding(sessionFile, { cwd: tempDir, ...binding });
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

function sourceIdentity({ agentId, sessionId, sessionKey }: ReturnType<typeof sourceSession>) {
  return { kind: "session" as const, agentId, sessionId, sessionKey };
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
  identity: Parameters<typeof bindings.mutate>[0],
  binding: Omit<Parameters<typeof writeBinding>[1], "cwd">,
) {
  return bindings.mutate(identity, {
    kind: "set",
    binding: { cwd: tempDir, ...binding },
  });
}

function rpcError(message: string, method = "turn/start", code = -32_600) {
  return new CodexAppServerRpcError({ code, message }, method);
}

function rpcResponses(
  responses: Record<string, ConversationResponse>,
  operations?: Array<{ method: string; params: Record<string, unknown> }>,
) {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    operations?.push({ method, params });
    if (!(method in responses)) {
      throw new Error(`unexpected method: ${method}`);
    }
    const response = responses[method];
    if (response instanceof Error) {
      throw response;
    }
    return typeof response === "function" ? response(params) : response;
  });
}

async function expectLiveThread(client: CodexAppServerClient, threadId: string) {
  await expect(consumeThread(client, threadId)).resolves.toEqual(
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
  const readOwner = () => readBinding(sessionFile);
  await writeBinding(sessionFile, binding);
  const operations: string[] = [];
  const ownerDuringRelease: Array<string | undefined> = [];
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
  const { client: replacementClient, notify } = conversationClient(
    {
      "thread/read": { thread: threadResult(tempDir, "thread-migrated").thread },
      "thread/resume": () => {
        operations.push("replacement:thread/resume");
        return threadResult(tempDir, "thread-migrated");
      },
      "thread/unsubscribe": () => {
        operations.push("replacement:thread/unsubscribe");
        return {};
      },
      "turn/start": () => {
        operations.push("replacement:turn/start");
        queueMicrotask(() =>
          notify(turnCompleted("thread-migrated", "turn-migrated", "Migrated reply")),
        );
        return { turn: { id: "turn-migrated" } };
      },
    },
    "client-after-migration",
  );
  initializeClient(previousClient, { agentDir: tempDir });
  initializeClient(replacementClient, { agentDir: tempDir });
  await expect(retainThread(previousClient, "thread-migrated")).resolves.toBe(true);
  acquireClient.mockResolvedValue(replacementClient);
  retainClient.mockImplementation((clientId) =>
    clientId === previousClient.getInstanceId()
      ? { client: previousClient, release: vi.fn() }
      : undefined,
  );
  return { previousClient, replacementClient, operations, ownerDuringRelease, readOwner };
}

function claimConversation(
  event: Parameters<typeof claimConversationImpl>[0],
  ctx: Parameters<typeof claimConversationImpl>[1],
  options: Omit<Parameters<typeof claimConversationImpl>[2], "bindingStore"> = {},
) {
  return claimConversationImpl({ senderIsOwner: true, ...event }, ctx, {
    ...options,
    bindingStore: bindings,
  });
}

function prepareBinding({
  sessionFile,
  workspaceDir = tempDir,
  sessionKey,
  bindingStore = bindings,
  config,
  pluginConfig,
  agentId,
  agentDir,
  ...start
}: {
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
    bindingStore,
    config,
    pluginConfig,
    sessionKey,
    incognito: isIncognitoSessionKey(sessionKey),
    data: createCodexConversationBindingData({
      bindingId: bindingIdentity(sessionFile).bindingId,
      workspaceDir,
      agentId,
      agentDir,
      start: { id: "start-request", ...start },
    }),
  });
}

let tempDir: string;
const {
  conversationClaimContext,
  legacyConversationData,
  boundConversationClaim,
  denyConversationBinding,
} = createConversationClaimFixtures(() => tempDir, bindings);

function runBoundClaim(
  sessionFile: string,
  options: Parameters<typeof claimConversation>[2] = {},
  sessionKey?: string,
) {
  const { event, ctx } = boundConversationClaim(sessionFile, sessionKey);
  return claimConversation(event, ctx, options);
}

function claimData(
  data: Parameters<typeof conversationClaimContext>[0],
  options: Parameters<typeof claimConversation>[2] = {},
  sessionKey?: string,
  event: Parameters<typeof conversationMessage>[1] = {},
) {
  return claimConversation(
    conversationMessage("continue", { sessionKey, ...event }),
    conversationClaimContext(data, sessionKey),
    options,
  );
}

function exposeRetainedClient(client: CodexAppServerClient) {
  initializeClient(client, { agentDir: tempDir });
  acquireClient.mockResolvedValue(client);
  retainClient.mockReturnValue({ client, release: vi.fn() });
}

function retireWithSiblingLeases() {
  sharedClientMocks.clearSharedCodexAppServerClientIfCurrentAndUnclaimed
    .mockReturnValueOnce({ found: true, closed: false })
    .mockReturnValue({ found: false, closed: false });
  retireClient.mockReturnValueOnce({ activeLeases: 2, closed: false }).mockReturnValue(undefined);
}

function expectMethods(
  request: { mock: { calls: readonly (readonly unknown[])[] } },
  methods: string[],
) {
  expect(request.mock.calls.map(([method]) => method)).toEqual(methods);
}

const {
  getSharedCodexAppServerClient: acquireClient,
  retainSharedCodexAppServerClientByInstanceId: retainClient,
  retireSharedCodexAppServerClientIfCurrent: retireClient,
} = sharedClientMocks;

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
  for (const mocks of [
    sharedClientMocks,
    publicBindingMocks,
    execApprovalsRuntimeMocks,
    agentRuntimeMocks,
    providerAuthMocks,
    configLayerPolicyMocks,
  ]) {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
  }
  codexRequirementsTomlMock.mockReset();
  resolveSandboxContextMock.mockReset();
  setRuntimeConfigSnapshot({});
  resetCodexTestBindingStore();
  tempDir = sessionDirs.make();
});

afterEach(clearRuntimeConfigSnapshot);

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
  acquireClient.mockResolvedValue(client);
  const { event, ctx } = boundConversationClaim(sessionFile);

  try {
    await expectReply(claimConversation(event, ctx), "Bound answer");
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
  await bindingStore.mutate(bindingIdentity(sessionFile), {
    kind: "set",
    binding: { threadId: "bound-thread", clientId: "test-client", cwd: tempDir },
  });
  type InboundClaim = typeof claimConversationImpl;
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
  const order: string[] = [];
  const { client, request, notify } = conversationClient({
    "turn/start": () => {
      const turnId = `turn-${order.filter((entry) => entry.startsWith("turn-")).length + 1}`;
      order.push(turnId);
      return { turn: { id: turnId } };
    },
  });
  acquireClient.mockResolvedValue(client);
  const { event, ctx } = boundConversationClaim(sessionFile);
  const completeTurn = (turnId: string) =>
    notify(turnCompleted("bound-thread", turnId, turnId, `${turnId}-answer`));

  const firstTurn = handleClaim(event, ctx);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  const secondTurn = handleClaim(event, ctx);
  const retirement = withCodexConversationThreadActivity(
    legacyCodexConversationBindingId(sessionFile),
    async () => {
      order.push("retired");
    },
  );

  completeTurn("turn-1");
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
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
    await bindings.mutate(identity, { kind: "clear", threadId: "thread-retiring" });
    publicBindingMocks.readBinding.mockReturnValue(null);
  });
  await retirementStarted.promise;
  const bindingStore = {
    ...bindings,
    readAsync: async (requestedIdentity: Parameters<typeof bindings.readAsync>[0]) => {
      const binding = await bindings.readAsync(requestedIdentity);
      ownerCaptured.resolve();
      return binding;
    },
  };
  const { event, ctx } = boundConversationClaim(path.join(tempDir, "retiring-session.jsonl"));
  ctx.pluginBinding.data = conversationData(bindingId, { start: { id: "start-original" } });
  const queued = claimConversationImpl({ senderIsOwner: true, ...event }, ctx, { bindingStore });
  await ownerCaptured.promise;
  retirementReady.resolve();
  await retirement;
  await expectReply(
    queued,
    "This Codex conversation was detached or changed before its message could run.",
  );
  expect(acquireClient).not.toHaveBeenCalled();
  expect(bindings.read(identity)).toBeUndefined();
});

it.each([true, false])(
  "uses the persisted source lifecycle, not the destination (ephemeral: %s)",
  async (ephemeral) => {
    const sourceSessionKey = ephemeral
      ? "agent:main:dashboard:incognito-source"
      : "agent:main:telegram:ordinary-source";
    const destinationSessionKey = ephemeral
      ? "agent:main:telegram:ordinary-destination"
      : "agent:main:dashboard:incognito-destination";
    const bindingId = "binding-source-lifecycle";
    const storePath = path.join(tempDir, "mixed-source-lifecycle.sqlite");
    const source = { ...sourceSession("source"), sessionKey: sourceSessionKey, storePath };
    try {
      await seedSession(source, storePath);
      const threadId = "thread-1";
      const { client, operations } = replyingClient(
        threadId,
        "turn-1",
        "Bound reply",
        "test-client",
        {
          "thread/start": () => threadResult(tempDir, threadId),
          "thread/unsubscribe": () => ({}),
        },
      );
      exposeRetainedClient(client);
      const data = conversationData(bindingId, {
        source,
        start: { id: "start-source-lifecycle" },
      });
      const sql = ephemeral ? observeHostDataSql() : undefined;
      try {
        await expectReply(
          claimData(
            data,
            {
              config: { session: { store: path.join(tempDir, "unrelated-session.sqlite") } },
            },
            destinationSessionKey,
          ),
          "Bound reply",
        );
        if (sql) {
          expect(sql.queries).toEqual([]);
        }
      } finally {
        sql?.restore();
      }

      expect(operations.map(({ method }) => method)).toEqual(["thread/start", "turn/start"]);
      if (ephemeral) {
        expect(operations[0]?.params.ephemeral).toBe(true);
        await expect(consumeThread(client, threadId)).resolves.toBeUndefined();
      } else {
        expect(operations[0]?.params).not.toHaveProperty("ephemeral");
        const ownership = await consumeThread(client, threadId);
        expect(ownership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
        await expect(
          retainThread(
            client,
            threadId,
            ownership?.release,
            ownership?.configFingerprint,
            ownership?.serviceTier,
          ),
        ).resolves.toBe(true);
      }

      await denyConversationBinding(data);

      expect(operations.at(-1)).toEqual({
        method: "thread/unsubscribe",
        params: { threadId },
      });
      expect(bindings.read({ kind: "conversation", bindingId })).toBeUndefined();
    } finally {
      await deleteSessionEntry({ agentId: "main", sessionKey: sourceSessionKey, storePath });
    }
  },
);

it("fails closed before client startup when the source session is rebound", async () => {
  const bindingId = "binding-rebound-source";
  const storePath = path.join(tempDir, "rebound-source.sqlite");
  const source = sourceSession("source-session");
  await seedSession(source, storePath, { sessionId: "replacement-session" });
  await seedBinding({ kind: "conversation", bindingId }, { threadId: "thread-bound" });
  acquireClient.mockRejectedValue(new Error("Codex client must not start"));

  await expectReplyContaining(
    claimData(conversationData(bindingId, { source }), {
      config: { session: { store: storePath } },
    }),
    "source session is missing or no longer current",
  );
  expect(acquireClient).not.toHaveBeenCalled();
});

it("rejects sandbox revocation while a conversation awaits client acquisition", async () => {
  const source = {
    ...sourceSession("sandbox-source"),
    storePath: path.join(tempDir, "sandbox-source.sqlite"),
  };
  await seedSession(source, source.storePath, { updatedAt: 1, sandboxMode: "off" });
  const request = vi.fn(async () => {
    throw new Error("Native requests must not run after sandbox revocation");
  });
  acquireClient.mockImplementation(async () => {
    await patchSessionEntry({ ...source, update: () => ({ sandboxMode: undefined }) });
    return { request };
  });

  const result = await claimData(conversationData("binding-sandbox-source", { source }), {
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
  });

  expect(acquireClient).toHaveBeenCalledOnce();
  expect(result?.reply?.text).toContain("selected session changed");
  expect(request).not.toHaveBeenCalled();
});

it("starts a fresh proxy-backed thread when binding an explicit app-server thread id", async () => {
  const sessionFile = path.join(tempDir, "session.jsonl");
  const agentDir = path.join(tempDir, "agents", "bot-a", "agent");
  const { client, operations: requests } = conversationClient({
    "thread/start": threadResult(tempDir, "thread-new"),
    "thread/resume": new Error("thread/resume should not receive network proxy config"),
  });
  acquireClient.mockResolvedValue(client);

  await prepareBinding({
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
  expect(acquireClient).toHaveBeenCalledWith(expect.objectContaining({ agentDir }));
  const bindingAfterStart = await readBinding(sessionFile);
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
  const harness = createClientHarness();
  initializeClient(harness.client, { agentDir: tempDir });
  const releaseBoundThread = vi.fn(async () => undefined);
  const releaseSibling = vi.fn(async () => undefined);
  await retainThread(harness.client, "thread-current", releaseBoundThread);
  await retainThread(harness.client, "thread-sibling", releaseSibling);
  const sessionFile = await boundSession("pending-config-read.jsonl", {
    threadId: "thread-current",
    clientId: harness.client.getInstanceId(),
  });
  const before = await readBinding(sessionFile);
  acquireClient.mockResolvedValue(harness.client);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const result = prepareBinding({
    pluginConfig: { appServer: { requestTimeoutMs: 1_000 } },
    sessionFile,
    threadId: "thread-current",
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    expect(JSON.parse(await harness.waitForWrite(0)).method).toBe("config/read");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toMatchObject({ message: "config/read timed out" });
    expect(harness.writes).toHaveLength(1);
    expect(releaseLease).toHaveBeenCalledOnce();
    expect(releaseBoundThread).not.toHaveBeenCalled();
    expect(releaseSibling).not.toHaveBeenCalled();
    expect(harness.stdinDestroyed).toBe(false);
    await expect(readBinding(sessionFile)).resolves.toEqual(before);
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
  const threadId = "thread-selected-config-owner";
  const createBudgetClient = (budget: number) =>
    respondingHarness({
      "config/read": {
        config: { project_doc_max_bytes: budget },
        origins: {
          project_doc_max_bytes: {
            name: { type: "user", file: "/codex/config.toml", profile: null },
            version: "sha256:authored-budget",
          },
        },
        layers: [],
      },
      "thread/read": { thread: threadResult(tempDir, threadId).thread },
      "thread/resume": threadResult(tempDir, threadId),
      "thread/unsubscribe": {},
    });
  const previous = createBudgetClient(180_000);
  const selected = createBudgetClient(240_000);
  initializeClient(previous.client, { agentDir: tempDir });
  initializeClient(selected.client, { agentDir: tempDir });
  await retainThread(previous.client, threadId);
  const sessionFile = await boundSession("selected-config-owner.jsonl", {
    threadId,
    clientId: previous.client.getInstanceId(),
  });
  acquireClient.mockResolvedValue(selected.client);
  retainClient.mockImplementation((clientId) =>
    clientId === previous.client.getInstanceId()
      ? { client: previous.client, release: vi.fn() }
      : undefined,
  );
  try {
    await prepareBinding({ sessionFile, threadId });
    const selectedRequests = selected.writes.map((line): { method: string; params: unknown } =>
      JSON.parse(line),
    );
    expect(selectedRequests.find(({ method }) => method === "thread/resume")?.params).toMatchObject(
      { config: { project_doc_max_bytes: 240_000 } },
    );
    await expect(readBinding(sessionFile)).resolves.toMatchObject({
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
    const threadId = "thread-expired-attachment";
    const existingThreadId = expiresDuring === "commit" ? "thread-previous-attachment" : threadId;
    const harness = createClientHarness();
    initializeClient(harness.client, { agentDir: tempDir });
    const release = vi.fn(async () => undefined);
    await retainThread(harness.client, existingThreadId, release);
    const releaseSibling = vi.fn(async () => undefined);
    await retainThread(harness.client, "thread-sibling", releaseSibling);
    const sessionFile = await boundSession("expired-attachment.jsonl", {
      threadId: existingThreadId,
      clientId: harness.client.getInstanceId(),
    });
    const before = await readBinding(sessionFile);
    const response = threadResult(tempDir, threadId, true);
    exposeRetainedClient(harness.client);
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
        prepareBinding({
          pluginConfig: { appServer: { requestTimeoutMs: 1_000 } },
          sessionFile,
          threadId,
          bindingStore: {
            ...bindings,
            readAsync: async (identity) => {
              if (resumeAccepted) {
                if (expiresDuring === "retention") {
                  elapsedClock.mockReturnValue(1_001);
                }
              }
              return await bindings.readAsync(identity);
            },
            mutate: async (...args) => {
              if (expiresDuring === "commit") {
                elapsedClock.mockReturnValue(1_001);
              }
              return await bindings.mutate(...args);
            },
          },
        }),
      ).rejects.toThrow("timed out");

      expectMethods(request, ["thread/read", "thread/resume", "thread/unsubscribe"]);
      expect(release).toHaveBeenCalledOnce();
      expect(releaseSibling).not.toHaveBeenCalled();
      expect(harness.stdinDestroyed).toBe(false);
      await expectLiveThread(harness.client, "thread-sibling");
      await expect(readBinding(sessionFile)).resolves.toEqual(before);
      await expect(consumeThread(harness.client, threadId)).resolves.toBeUndefined();
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
    .mockResolvedValue(threadResult(tempDir, "thread-active-child") as never);
  initializeClient(harness.client, { agentDir: tempDir });
  const parent = await codexNativeSubagentMonitorRuntime.register({
    client: harness.client,
    parentThreadId: "thread-parent",
  });
  acquireClient.mockResolvedValue(harness.client);

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
      expect(isThreadClaimed(harness.client, "thread-active-child")).toBe(true),
    );

    await expect(prepareBinding({ sessionFile, threadId: "thread-active-child" })).rejects.toThrow(
      "active run",
    );

    expect(request).not.toHaveBeenCalled();
    expect(isThreadClaimed(harness.client, "thread-active-child")).toBe(true);
  } finally {
    await parent.unregister();
    harness.client.close();
  }
});

it("preserves a stored child binding when resumed direct input is refused", async () => {
  const sessionKey = "agent:main:dashboard:incognito-child";
  const harness = createClientHarness();
  initializeClient(harness.client, { agentDir: tempDir });
  const threadId = "thread-parent-owned";
  const sessionFile = await boundSession("stored-child.jsonl", { threadId });
  const before = await readBinding(sessionFile);
  const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
    if (method === "thread/read") {
      return { thread: threadResult(tempDir, threadId, null).thread } as never;
    }
    if (method === "thread/resume") {
      return threadResult(tempDir, threadId, false) as never;
    }
    if (method === "thread/unsubscribe") {
      return {} as never;
    }
    throw new Error(`unexpected Codex method ${method}`);
  });
  acquireClient.mockResolvedValue(harness.client);
  try {
    await expectReplyContaining(
      runBoundClaim(sessionFile, {}, sessionKey),
      "controlled by its parent",
    );
    await expect(readBinding(sessionFile)).resolves.toEqual(before);
    expectMethods(request, ["thread/read", "thread/resume", "thread/unsubscribe"]);
    await expect(consumeThread(harness.client, threadId)).resolves.toBeUndefined();
  } finally {
    harness.client.close();
  }
});

it.each([false, true])(
  "transfers exact physical ownership during bound turns (old release fails: %s)",
  async (rejectOldRelease) => {
    const sessionFile = path.join(tempDir, "same-thread-client-migration.jsonl");
    const { previousClient, replacementClient, operations, ownerDuringRelease, readOwner } =
      await createSameThreadClientMigrationFixture(sessionFile, { rejectOldRelease });

    const result = await runBoundClaim(sessionFile);
    expect(result?.reply?.text).toContain(
      rejectOldRelease ? "previous physical client unsubscribe failed" : "Migrated reply",
    );

    expect(operations).toEqual([
      "replacement:thread/resume",
      "previous:thread/unsubscribe",
      rejectOldRelease ? "replacement:thread/unsubscribe" : "replacement:turn/start",
    ]);
    expect(ownerDuringRelease).toEqual(["client-before-migration"]);
    await expect(readOwner()).resolves.toMatchObject({
      threadId: "thread-migrated",
      clientId: rejectOldRelease ? "client-before-migration" : "client-after-migration",
    });
    const survivingClient = rejectOldRelease ? previousClient : replacementClient;
    const obsoleteClient = rejectOldRelease ? replacementClient : previousClient;
    await expectLiveThread(survivingClient, "thread-migrated");
    await expect(consumeThread(obsoleteClient, "thread-migrated")).resolves.toBeUndefined();
  },
);

it.each(["agent", "host"] as const)(
  "rejects binding from its %s approval policy before native requests",
  async (owner) => {
    const request = vi.fn();
    acquireClient.mockResolvedValue({ request });
    execApprovalsRuntimeMocks.loadExecApprovalsReadOnlyAsync.mockResolvedValue({
      version: 1,
      agents: {},
      ...(owner === "host" ? { defaults: { security: "deny", ask: "off" } } : {}),
    });
    await expect(
      prepareBinding({
        sessionFile: path.join(tempDir, "session.jsonl"),
        agentId: owner === "agent" ? "bot-a" : undefined,
        config:
          owner === "agent"
            ? ({
                tools: { exec: { mode: "full" } },
                agents: { entries: { "bot-a": { tools: { exec: { mode: "auto" } } } } },
              } as never)
            : undefined,
        model: "gpt-5.4-mini",
      }),
    ).rejects.toThrow(
      owner === "host" ? "tools.exec.mode=deny" : "cannot route interactive approvals yet",
    );
    expect(request).not.toHaveBeenCalled();
  },
);

it("refuses legacy custom-provider bindings before connecting", async () => {
  const sessionFile = await boundSession("session.jsonl", {
    threadId: "thread-1",
    model: "lmstudio/local-model",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  await expectReplyContaining(
    runBoundClaim(sessionFile, { pluginConfig: { appServer: { mode: "guardian" } } }),
    "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
  );
  expect(acquireClient).not.toHaveBeenCalled();
});

it("retires an already-evicted conversation without disturbing its live client siblings", async () => {
  const identity = { kind: "conversation" as const, bindingId: "binding-evicted" };
  const { client } = conversationClient({ "thread/unsubscribe": {} });
  initializeClient(client, { agentDir: tempDir });
  const releaseEvicted = vi.fn(async (_threadId: string) => undefined);
  await retainThread(client, "thread-evicted", releaseEvicted);
  for (let index = 0; index < 64; index += 1) {
    await retainThread(client, `thread-sibling-${index}`, async () => undefined);
  }
  expect(releaseEvicted).toHaveBeenCalledExactlyOnceWith("thread-evicted", undefined, undefined);
  retainClient.mockReturnValue({ client, release: vi.fn() });
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

  expect(bindings.read(identity)).toBeUndefined();
  await expectLiveThread(client, "thread-sibling-0");
});

it("keeps a denied conversation binding when native unsubscribe fails", async () => {
  const identity = { kind: "conversation" as const, bindingId: "binding-failed-denial" };
  const request = vi.fn(async () => {
    throw new Error("native unsubscribe failed");
  });
  const closeAndWait = vi.fn(async () => true);
  retainClient.mockReturnValue({
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
  expect(bindings.read(identity)).toMatchObject({ threadId: "thread-failed-denial" });
  expect(closeAndWait).toHaveBeenCalledOnce();
});

it("preserves the live conversation generation when a replacement bind is denied", async () => {
  const identity = { kind: "conversation" as const, bindingId: "binding-data-1" };
  await seedBinding(identity, { threadId: "thread-old", conversationStartId: "start-old" });

  await denyConversationBinding(
    conversationData("binding-data-1", {
      start: { id: "start-new", threadId: "thread-new" },
    }),
  );

  expect(bindings.read(identity)).toMatchObject({
    threadId: "thread-old",
    conversationStartId: "start-old",
  });
});

it("rejects attaching a conversation to another session's owned thread", async () => {
  const otherIdentity = { kind: "session" as const, agentId: "main", sessionId: "session-other" };
  await seedBinding(otherIdentity, { threadId: "thread-owned" });
  const request = vi.fn(async () => threadResult(tempDir, "thread-owned"));
  acquireClient.mockResolvedValue({ request });

  await expect(
    prepareBinding({ sessionFile: path.join(tempDir, "session.jsonl"), threadId: "thread-owned" }),
  ).rejects.toThrow("owned by another OpenClaw session");
  expect(request).not.toHaveBeenCalled();
  expect(bindings.read(otherIdentity)).toMatchObject({ threadId: "thread-owned" });
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
    const result = await claimConversation(
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
    expect(acquireClient).not.toHaveBeenCalled();
  },
);

it("keeps the bound agent node exec block ahead of current-session exec host overrides", async () => {
  const storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  const sessionFile = await boundSession();
  await seedSession({ sessionKey: "agent:main:session-1", sessionId: "session-1" }, storePath, {
    execHost: "gateway",
  });

  const result = await claimConversation(
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
  expect(acquireClient).not.toHaveBeenCalled();
});

it("blocks bound Codex CLI node turns when the current OpenClaw session is sandboxed", async () => {
  const resumeCodexCliSessionOnNode = vi.fn();
  const config = { agents: { defaults: { sandbox: { mode: "all" as const } } } };
  setRuntimeConfigSnapshot(config);

  const result = await claimConversation(
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
    { config, resumeCodexCliSessionOnNode },
  );

  await expectReply(
    result,
    expect.stringContaining(
      "Codex-native Codex CLI node conversation binding is unavailable because OpenClaw sandboxing is active for this session.",
    ),
  );
  expect(resumeCodexCliSessionOnNode).not.toHaveBeenCalled();
});

it("re-reads source-owned permission roots while resuming an unloaded bound thread", async () => {
  const storePath = path.join(tempDir, "recovery.sqlite");
  const source = sourceSession("recovery-source");
  const recoveredRoot = path.join(tempDir, "recovered-root");
  await seedSession(source, storePath, { permissionMode: "full", sessionRoot: tempDir });
  codexRequirementsTomlMock.mockReturnValue(WORKSPACE_REQUIREMENTS);
  agentRuntimeMocks.ensureAuthProfileStoreAsync.mockResolvedValue({
    version: 1,
    profiles: {
      work: { type: "oauth", provider: "openai", access: "access-token" },
    },
  });
  const sessionFile = await boundSession("session.jsonl", {
    threadId: "thread-old",
    authProfileId: "work",
    model: "gpt-5.4-mini",
    modelProvider: "openai",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    serviceTier: "fast",
  });
  let submitted = false;
  const {
    client,
    operations: requests,
    notify,
  } = conversationClient({
    "thread/read": { thread: threadResult(tempDir, "thread-old").thread },
    "thread/resume": () => threadResult(recoveredRoot, "thread-old"),
    "turn/start": async (requestParams) => {
      if (!submitted) {
        submitted = true;
        await seedSession(source, storePath, {
          permissionMode: "workspace",
          sessionRoot: recoveredRoot,
        });
        throw rpcError("thread not found: thread-old");
      }
      if (requestParams.threadId === "thread-old") {
        setImmediate(() =>
          notify(turnCompleted("thread-old", "turn-new", "Recovered", "assistant-1")),
        );
        return { turn: { id: "turn-new" } };
      }
      throw new Error("unexpected turn/start");
    },
  });
  acquireClient.mockResolvedValue(client);

  const result = await claimData(
    conversationData(legacyCodexConversationBindingId(sessionFile), {
      source: { agentId: source.agentId, sessionId: source.sessionId, threadId: source.threadId },
    }),
    { config: { session: { store: storePath } } },
  );

  await expectReply(result, "Recovered");
  expect(requests.map((request) => request.method)).toEqual([
    "turn/start",
    "thread/read",
    "thread/resume",
    "turn/start",
  ]);
  expect(requests[0]?.params).toMatchObject({ ...workspacePolicy(tempDir) });
  expect(requests[2]?.params).toMatchObject({
    serviceTier: "priority",
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
  const savedBinding = await readBinding(sessionFile);
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
  const binding = await readBinding(sessionFile);
  const { client, request } = conversationClient({ "turn/start": error });
  acquireClient.mockResolvedValue(client);
  await expectReply(runBoundClaim(sessionFile), `Codex app-server turn failed: ${error.message}`);
  expect(request).toHaveBeenCalledOnce();
  await expect(readBinding(sessionFile)).resolves.toEqual(binding);
});

it.each(["deleted history", "resume auth failure"] as const)(
  "preserves the binding and does not submit input when recovery encounters %s",
  async (failure) => {
    const sessionFile = await boundSession("failed-reload.jsonl");
    const binding = await readBinding(sessionFile);
    const { client, request } = conversationClient({
      "turn/start": rpcError("thread not found: thread-1"),
      "thread/read":
        failure === "deleted history"
          ? rpcError("thread not loaded: thread-1", "thread/read")
          : { thread: threadResult(tempDir, "thread-1").thread },
      "thread/resume": rpcError("authentication required; sign in again", "thread/resume"),
      "thread/unsubscribe": { status: "notLoaded" },
    });
    acquireClient.mockResolvedValue(client);
    const result = await runBoundClaim(sessionFile);
    expect(result?.reply?.text).toContain(
      failure === "deleted history"
        ? "Your message was not submitted; rebind the conversation and resend it."
        : "authentication required; sign in again",
    );
    expectMethods(
      request,
      failure === "deleted history"
        ? ["turn/start", "thread/read"]
        : ["turn/start", "thread/read", "thread/resume", "thread/unsubscribe"],
    );
    await expect(readBinding(sessionFile)).resolves.toEqual(binding);
  },
);

it("moves queued session history while clamping rootless inherited cwd to the agent workspace", async () => {
  const source = sourceSession("source-session");
  const storePath = path.join(tempDir, "source.sqlite");
  await seedSession(source, storePath, { permissionMode: "workspace" });
  await seedSession(sourceSession("destination-session"), storePath);
  codexRequirementsTomlMock.mockReturnValue(WORKSPACE_REQUIREMENTS);
  for (const [role, content, timestamp] of [
    ["user", "Earlier question", 1],
    ["assistant", "Earlier answer", 2],
  ] as const) {
    await appendSessionTranscriptMessageByIdentity({
      ...source,
      storePath,
      message: { role, content, timestamp },
    });
  }
  const identity = sourceIdentity(source);
  await bindings.mutate(identity, {
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
      "thread/start": () => threadResult(tempDir, "thread-bound"),
      "thread/inject_items": () => ({}),
    },
  );
  exposeRetainedClient(client);
  await retainThread(client, source.threadId, releaseSource);
  await withAdmittedSessionTurnForTest({ ...source, storePath }, async (operation) => {
    expect(operation.phase).toBe("queued");
    await expectReply(
      claimData(
        conversationData("binding-source-transfer", { source }),
        { config: { session: { store: storePath } } },
        source.sessionKey,
      ),
      "Bound reply",
    );
  });

  expect(requests.map(({ method }) => method)).toEqual([
    "thread/start",
    "thread/inject_items",
    "turn/start",
  ]);
  expect(requests[0]?.params).toMatchObject({
    ...workspacePolicy("/agent/workspace"),
    sandbox: "workspace-write",
    developerInstructions: expect.stringContaining("bound to an OpenClaw conversation"),
    config: { apps: { _default: { enabled: false } }, "features.apps": false },
  });
  expect(requests[2]?.params).toMatchObject({
    ...workspacePolicy("/agent/workspace"),
    sandboxPolicy: { type: "workspaceWrite" },
  });
  expect(requests[0]?.params).not.toHaveProperty("dynamicTools");
  expect(requests[1]?.params.items).toMatchObject([
    { role: "user", content: [{ text: "Earlier question" }] },
    { role: "assistant", content: [{ text: "Earlier answer" }] },
  ]);
  expect(releaseSource).toHaveBeenCalledOnce();
  expect(bindings.read(identity)).toBeUndefined();
  await expectLiveThread(client, "thread-bound");
});

it.each([
  { label: "a registered source run after its client was retired", exposeClient: false },
  { label: "a live client whose source subscription is claimed", exposeClient: true },
])("does not transfer $label into a bound conversation", async ({ exposeClient }) => {
  const source = sourceSession("active-source-session", "thread-active-source");
  const identity = sourceIdentity(source);
  const storePath = path.join(tempDir, "active-source.sqlite");
  await seedSession(source, storePath);
  await seedBinding(identity, { threadId: source.threadId, clientId: "active-client" });
  const { client, request } = conversationClient(
    {
      "thread/start": threadResult(tempDir, "thread-active-target"),
    },
    "active-client",
  );
  initializeClient(client, { agentDir: tempDir });
  acquireClient.mockResolvedValue(client);
  if (exposeClient) {
    await retainThread(client, source.threadId, async () => undefined);
    await consumeThread(client, source.threadId);
    retainClient.mockReturnValue({ client, release: vi.fn() });
  }
  const activeRun = {
    runId: "active-source-run",
    toolAuthorityFingerprint: undefined as string | undefined,
    queueMessage: async () => undefined,
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
  };
  const data = conversationData("binding-active-source", {
    source,
    start: { id: "start-active-source" },
  });

  const claimSource = async () => {
    const result = await claimData(data, {
      config: { session: { store: storePath } },
    });

    expect(result?.reply?.text).toContain("active run");
    expectMethods(request, ["thread/start"]);
    expect(bindings.read(identity)).toMatchObject({ threadId: source.threadId });
    expect(
      bindings.read({ kind: "conversation", bindingId: "binding-active-source" }),
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
  const config = { tools: { exec: { security: "full", ask: "on-miss" } } };
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

  const result = await claimData(
    legacyConversationData(sessionFile),
    { config: config as never },
    "agent:main:session-1",
    { bodyForAgent: "continue" },
  );

  expect(result?.handled).toBe(true);
  expect(result?.reply?.text).toContain(
    "OpenClaw native Codex conversation binding cannot route interactive approvals yet",
  );
  expect(result?.reply?.text).not.toContain(
    "legacy full exec security with ask requires Codex app-server danger-full-access",
  );
  expect(acquireClient).not.toHaveBeenCalled();
});

it.each([false, true])(
  "returns the escaped original failure when incognito cleanup fails: %s",
  async (retirementFails) => {
    const error =
      "unexpected status 401 Unauthorized: Missing bearer <@U123> [trusted](https://evil) @here";
    const expected =
      "unexpected status 401 Unauthorized: Missing bearer &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here";
    const sessionKey = "agent:main:dashboard:incognito-bound-failure";
    const sessionFile = await boundSession();
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
    acquireClient.mockResolvedValue({
      ...(retirementFails ? { closeAndWait } : {}),
      request,
      ...clientListeners(),
    });

    try {
      const result = await runBoundClaim(sessionFile, {}, sessionKey);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      await expectReply(result, `Codex app-server turn failed: ${expected}`);
      expect(unhandledRejections).toStrictEqual([]);
      expectMethods(request, ["turn/start", "thread/unsubscribe"]);
      if (retirementFails) {
        expect(closeAndWait).toHaveBeenCalledOnce();
      }
      await expect(readBinding(sessionFile)).resolves.toBeUndefined();
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
  const binding = await readBinding(sessionFile);
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
      return { thread: threadResult(tempDir, "thread-1").thread };
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
  acquireClient.mockResolvedValue(client);
  if (retired) {
    retireWithSiblingLeases();
  }
  await expectReply(
    runBoundClaim(sessionFile, {}, "agent:main:dashboard:incognito-reconnect"),
    `Codex app-server turn failed: ${rejection.message}`,
  );
  expectMethods(
    request,
    cleaned && !retired
      ? ["thread/read", "thread/resume", "thread/unsubscribe"]
      : ["thread/read", "thread/resume"],
  );
  if (retired) {
    expect(retireClient).toHaveBeenCalledExactlyOnceWith(client);
  } else {
    expect(retireClient).not.toHaveBeenCalled();
  }
  expect(closeAndWait).not.toHaveBeenCalled();
  await expect(readBinding(sessionFile)).resolves.toEqual(cleaned ? undefined : binding);
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
    const { client, request, notify } = conversationClient({
      "turn/start": () => {
        queueMicrotask(() => {
          if (status === "interrupted") {
            notify({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "item-1",
                delta: "unfinished answer",
              },
            });
          }
          notify(turnEnded(status, error));
        });
        return { turn: { id: "turn-1" } };
      },
    });
    acquireClient.mockResolvedValue(client);
    await expectReply(runBoundClaim(sessionFile), `Codex app-server turn failed: ${message}`);

    expectMethods(request, ["turn/start"]);
    expect(retireClient).not.toHaveBeenCalled();
    await expect(readBinding(sessionFile)).resolves.toMatchObject({ threadId: "thread-1" });
  },
);

it("interrupts an indeterminate incognito native turn before cleanup", async () => {
  const sessionKey = "agent:main:dashboard:incognito-start-timeout";
  const harness = createClientHarness();
  const sessionFile = await boundSession("session.jsonl", {
    threadId: "thread-1",
    clientId: harness.client.getInstanceId(),
  });
  acquireClient.mockResolvedValue(harness.client);
  const readRequest = async (
    index: number,
  ): Promise<{
    id: number;
    method: string;
    params: unknown;
  }> => JSON.parse(await harness.waitForWrite(index));
  const result = runBoundClaim(
    sessionFile,
    {
      pluginConfig: { appServer: { requestTimeoutMs: 100 } },
    },
    sessionKey,
  );
  try {
    const turnStart = await readRequest(0);
    const interrupt = await readRequest(1);
    expect(interrupt.params).toEqual({ threadId: "thread-1", turnId: "" });
    harness.send({ id: turnStart.id, result: { turn: { id: "turn-1" } } });
    harness.send({ id: interrupt.id, result: {} });
    const unsubscribe = await readRequest(2);
    harness.send({ id: unsubscribe.id, result: {} });

    await expectReply(result, "Codex app-server turn failed: turn/start timed out");
    expect(harness.writes.map((write) => JSON.parse(write).method)).toEqual([
      "turn/start",
      "turn/interrupt",
      "thread/unsubscribe",
    ]);
    expect(retireClient).not.toHaveBeenCalled();
    expect(activeTurn(bindingIdentity(sessionFile))).toBeUndefined();
    await expect(readBinding(sessionFile)).resolves.toBeUndefined();
  } finally {
    harness.client.close();
    await Promise.allSettled([result]);
  }
});

it.each([
  ["confirmed incognito", "agent:main:dashboard:incognito-turn-timeout", "confirmed"],
  ["unconfirmed ordinary", undefined, "unconfirmed"],
  ["failed incognito", "agent:main:dashboard:incognito-interrupt-failure", "failed"],
] as const)(
  "settles a timed-out %s turn before releasing its ownership",
  async (_label, sessionKey, outcome) => {
    vi.useFakeTimers();
    try {
      const sessionFile = await boundSession();
      const identity = bindingIdentity(sessionFile);
      const events: string[] = [];
      const confirmed = outcome === "confirmed";
      const closeAndWait = vi.fn(async () => true);
      const {
        client: baseClient,
        request,
        notify,
      } = conversationClient({
        "turn/start": { turn: { id: "turn-1" } },
        ...(confirmed
          ? {
              "thread/unsubscribe": () => {
                events.push("unsubscribe");
                return {};
              },
            }
          : {}),
        "turn/interrupt": () => {
          events.push("interrupt");
          expect(activeTurn(identity)).toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
          if (outcome === "failed") {
            throw new Error("turn interrupt could not be confirmed");
          }
          if (confirmed) {
            queueMicrotask(() => {
              events.push("turn completed");
              expect(activeTurn(identity)).toMatchObject({
                threadId: "thread-1",
                turnId: "turn-1",
              });
              notify(turnEnded("interrupted"));
            });
          }
          return {};
        },
      });
      const client = Object.assign(baseClient, !confirmed ? { closeAndWait } : {});
      acquireClient.mockResolvedValue(client);
      if (!confirmed) {
        retireWithSiblingLeases();
      }
      const result = runBoundClaim(sessionFile, {}, sessionKey);
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledWith("turn/start", expect.any(Object), expect.any(Object));
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(request).toHaveBeenCalledWith(
        "turn/interrupt",
        { threadId: "thread-1", turnId: "turn-1" },
        { timeoutMs: 5_000, signal: expect.any(AbortSignal) },
      );
      if (outcome === "unconfirmed") {
        expect(activeTurn(identity)).toMatchObject({ threadId: "thread-1", turnId: "turn-1" });
        expect(retireClient).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000);
      }
      await expectReply(
        result,
        "Codex app-server turn failed: codex app-server bound turn timed out",
      );
      expectMethods(
        request,
        confirmed
          ? ["turn/start", "turn/interrupt", "thread/unsubscribe"]
          : ["turn/start", "turn/interrupt"],
      );
      if (confirmed) {
        expect(events).toEqual(["interrupt", "turn completed", "unsubscribe"]);
        expect(retireClient).not.toHaveBeenCalled();
      } else {
        expect(retireClient).toHaveBeenCalledExactlyOnceWith(client);
        expect(closeAndWait).not.toHaveBeenCalled();
      }
      expect(activeTurn(identity)).toBeUndefined();
      await expect(readBinding(sessionFile)).resolves.toEqual(
        sessionKey ? undefined : expect.objectContaining({ threadId: "thread-1" }),
      );
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
  const {
    client,
    operations: requests,
    notify,
  } = conversationClient({
    "thread/start": () => threadResult(tempDir, "thread-new"),
    "turn/start": () => {
      setImmediate(() => notify(turnCompleted("thread-new", "turn-1", "done", "item-1")));
      return { turn: { id: "turn-1" } };
    },
  });
  acquireClient.mockResolvedValue(client);

  const result = await runBoundClaim(sessionFile, {
    pluginConfig: {
      appServer: { ...NETWORK_PROXY_PLUGIN_CONFIG.appServer, serviceTier: "priority" },
    },
  });

  await expectReply(result, "done");
  expect(requests.map((request) => request.method)).toEqual(["thread/start", "turn/start"]);
  expect(requests[0]?.params.config).toMatchObject(NETWORK_PROXY_CONFIG_PATCH);
  expect(requests[0]?.params).not.toHaveProperty("sandbox");
  expect(requests[0]?.params.serviceTier).toBe("priority");
  expect(requests[1]?.params.threadId).toBe("thread-new");
  expect(requests[1]?.params).not.toHaveProperty("sandboxPolicy");
  const bindingAfterRefresh = await readBinding(sessionFile);
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
  const { client } = conversationClient(
    {
      "thread/start": () => threadResult(tempDir, "thread-new"),
      "thread/unsubscribe": (params) => {
        if (params.threadId === "thread-old") {
          throw new Error("old thread unsubscribe failed");
        }
        if (params.threadId === "thread-new") {
          return {};
        }
        throw new Error("unexpected thread/unsubscribe");
      },
    },
    "client-network-rotation",
  );
  initializeClient(client, { agentDir: tempDir });
  await expect(
    retainThread(client, "thread-old", async (threadId) => {
      await client.request("thread/unsubscribe", { threadId });
    }),
  ).resolves.toBe(true);
  acquireClient.mockResolvedValue(client);
  const result = await runBoundClaim(sessionFile, { pluginConfig: NETWORK_PROXY_PLUGIN_CONFIG });

  expect(result?.reply?.text).toContain("old thread unsubscribe failed");
  await expect(readBinding(sessionFile)).resolves.toMatchObject({
    clientId: "client-network-rotation",
    threadId: "thread-old",
  });
  expect(isThreadClaimed(client, "thread-old")).toBe(false);
  await expectLiveThread(client, "thread-old");
  await expect(consumeThread(client, "thread-new")).resolves.toBeUndefined();
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
