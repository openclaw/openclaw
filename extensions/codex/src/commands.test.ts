import path from "node:path";
import {
  replaceRuntimeAuthProfileStoreSnapshots,
  resolveDefaultAgentDir,
  type AuthProfileStore,
} from "openclaw/plugin-sdk/agent-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "openclaw/plugin-sdk/model-session-runtime";
import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import {
  getSessionEntry,
  patchSessionEntry,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  consumeCodexAppServerLiveThread as consumeThread,
  ensureCodexAppServerClientRuntime as initializeClient,
  isCodexAppServerLiveThreadClaimed as isThreadClaimed,
  retainCodexAppServerLiveThread as retainThread,
} from "./app-server/client-runtime.js";
import { CodexAppServerRpcError, type CodexAppServerClient } from "./app-server/client.js";
import type { CodexComputerUseStatus } from "./app-server/computer-use.js";
import { codexNativeSubagentMonitorRuntime } from "./app-server/native-subagent-monitor.js";
import type { JsonValue } from "./app-server/protocol.js";
import {
  createCodexAppServerBindingStore,
  createCodexTestBindingStateStore,
  testCodexAppServerBindingStore,
} from "./app-server/session-binding.test-helpers.js";
import { createClientHarness } from "./app-server/test-support.js";
import type { CodexPluginsManagementIO } from "./command-plugin-config.js";
import type { CodexControlRequestOptions } from "./command-rpc.js";
import {
  createCodexRuntimeContextOverrides as runtimeContext,
  createDeps,
  type SafeCodexControlRequestFn,
  createThreadResumeResponse as threadResponse,
  holdCodexThreadQueue,
  expectResultTextContains as expectResultText,
  mockArg,
  mutatingCodexRequestMethods,
  oauthProfile,
  readDiagnosticsConfirmationToken,
  requestParams,
  runCommand,
  skillEntry,
  skillGroup,
  modelEntry,
  supervisedTestBinding,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";

const sessionIdentity = { kind: "session", agentId: "main", sessionId: "session-1" } as const;
const conversationIdentity = { kind: "conversation", bindingId: "binding-data-1" } as const;
type Binding = Parameters<typeof writeTestBinding>[1];
type BindingIdentity = Parameters<typeof writeTestBinding>[0];

function bindThread(
  threadId: string,
  fields: Partial<Omit<Binding, "threadId">> = {},
  identity: BindingIdentity = sessionIdentity,
) {
  return writeTestBinding(identity, { cwd: "/repo", ...fields, threadId });
}

async function expectCommand(text: string, ...args: Parameters<typeof runCommand>) {
  expect(await runCommand(...args)).toEqual({ text });
}

async function expectLiveThread(client: CodexAppServerClient, threadId: string) {
  await expect(consumeThread(client, threadId)).resolves.toEqual(
    expect.objectContaining({ release: expect.any(Function) }),
  );
}

function storedBinding(identity: BindingIdentity = sessionIdentity) {
  return testCodexAppServerBindingStore.read(identity);
}

function seedSession(
  storePath: string,
  sessionKey: string,
  entry: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
  agentId?: string,
) {
  return upsertSessionEntry({
    storePath,
    sessionKey,
    ...(agentId ? { agentId } : {}),
    entry: { sessionId: "session-1", updatedAt: Date.now(), ...entry },
  });
}

function nativeConversation(workspaceDir = "/repo", fields: Record<string, unknown> = {}) {
  return publicConversationBinding({
    kind: "codex-app-server-session",
    version: 2,
    bindingId: conversationIdentity.bindingId,
    workspaceDir,
    ...fields,
  });
}

function expectText(result: PluginCommandResult, ...parts: string[]) {
  for (const part of parts) {
    expect(result.text).toContain(part);
  }
}

function expectNoText(result: PluginCommandResult, ...parts: string[]) {
  for (const part of parts) {
    expect(result.text).not.toContain(part);
  }
}

const probeOk = <T>(value: T) => ({ ok: true as const, value });
const probeError = (error: string) => ({ ok: false as const, error });

function rateLimitSnapshot(
  limitId = "codex",
  planType: string | null = "plus",
  primary: {
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number | null;
  } | null = null,
) {
  return {
    limitId,
    limitName: limitId === "codex" ? "Codex" : limitId,
    primary,
    secondary: null,
    credits: null,
    planType,
    rateLimitReachedType: null,
  };
}

function goalResponse(threadId: string, objective: string, tokensUsed = 0) {
  return {
    goal: {
      threadId,
      objective,
      status: "active",
      tokenBudget: null,
      tokensUsed,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  };
}

async function diagnosticsFixture(threadId: string, context: Partial<PluginCommandContext> = {}) {
  await bindThread(
    threadId,
    {},
    { ...sessionIdentity, ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}) },
  );
  const upload = vi.fn<SafeCodexControlRequestFn>(async () => probeOk({ threadId }));
  const deps = createDeps({ safeCodexControlRequest: upload });
  const run = (args: string, overrides: Partial<PluginCommandContext> = {}) =>
    runCommand(args, deps, { ...context, ...overrides });
  return {
    upload,
    run,
    request: async (note = "") =>
      readDiagnosticsConfirmationToken(await run(`diagnostics ${note}`)),
  };
}

function publicConversationBinding(data?: Record<string, unknown>) {
  return {
    bindingId: "binding-1",
    pluginId: "codex",
    pluginRoot: "/plugin",
    channel: "test",
    accountId: "default",
    conversationId: "conversation",
    boundAt: 1,
    ...(data ? { data } : {}),
  };
}

let tempDir: string;
const resumeClients: CodexAppServerClient[] = [];

function nativeClient() {
  const harness = createClientHarness();
  initializeClient(harness.client, { agentDir: tempDir });
  resumeClients.push(harness.client);
  return harness;
}

function retainClientById(client: CodexAppServerClient) {
  return import("./app-server/shared-client.js").then((runtime) =>
    vi
      .spyOn(runtime, "retainSharedCodexAppServerClientByInstanceId")
      .mockImplementation(async (id) =>
        id === client.getInstanceId() ? { client, release: vi.fn() } : undefined,
      ),
  );
}

function mockResumeRequest(
  client: CodexAppServerClient,
  response: ReturnType<typeof threadResponse>,
  read?: Pick<ReturnType<typeof threadResponse>, "thread">,
) {
  return vi.spyOn(client, "request").mockImplementation(async (method) => {
    if (method === "thread/read" && read) {
      return read as never;
    }
    if (method === "thread/resume") {
      return response as never;
    }
    if (method === "thread/unsubscribe") {
      return {} as never;
    }
    throw new Error(`unexpected Codex method ${method}`);
  });
}

function captureBindingRequest() {
  const request = vi.fn<PluginCommandContext["requestConversationBinding"]>(async () => ({
    status: "bound",
    binding: publicConversationBinding(),
  }));
  return { request, data: () => request.mock.calls[0]?.[0]?.data };
}

function explicitStoreContext(sessionKey: string, sessionId = "session-1") {
  const storePath = path.join(tempDir, "explicit", "sessions.json");
  const configuredStorePath = path.join(tempDir, "configured", "sessions.json");
  return {
    storePath,
    configuredStorePath,
    context: {
      sessionKey,
      sessionId,
      config: { session: { store: configuredStorePath } },
      sessionTarget: { agentId: "main", sessionId, sessionKey, storePath },
    },
  };
}

async function runtimeSession(sessionKey?: string) {
  const context = await runtimeContext(tempDir, sessionKey);
  return {
    context,
    identity: { ...sessionIdentity, sessionKey: context.sessionKey },
    scope: { storePath: context.sessionTarget.storePath, sessionKey: context.sessionKey },
  };
}

function sandboxContext(
  overrides: Partial<PluginCommandContext> = {},
): Partial<PluginCommandContext> {
  return {
    config: { agents: { defaults: { sandbox: { mode: "all" } } } },
    sessionKey: "sandboxed-session",
    ...overrides,
  };
}

function nodeExecContext(
  overrides: Partial<PluginCommandContext> = {},
): Partial<PluginCommandContext> {
  return {
    config: { tools: { exec: { host: "node", node: "worker-1" } } },
    sessionKey: "node-session",
    ...overrides,
  };
}

function createResumeControlRequest(
  response: ReturnType<typeof threadResponse> | (() => Promise<ReturnType<typeof threadResponse>>),
  options: { client?: CodexAppServerClient; authProfileId?: string } = {},
) {
  const { client: suppliedClient, ...auth } = options;
  const client = suppliedClient ?? createClientHarness().client;
  if (!suppliedClient) {
    resumeClients.push(client);
    initializeClient(client, { agentDir: tempDir });
    vi.spyOn(client, "request").mockResolvedValue({} as never);
  }
  return vi.fn(
    async (
      _pluginConfig: unknown,
      _method: string,
      _params: unknown,
      requestOptions?: CodexControlRequestOptions,
    ) => {
      const value = typeof response === "function" ? await response() : response;
      const assertCurrent = requestOptions?.assertCurrent ?? (() => undefined);
      assertCurrent();
      await requestOptions?.beforeRequest?.(
        async <T>() => ({ thread: value.thread }) as T,
        client,
        { assertCurrent },
      );
      await requestOptions?.onResponse?.(value, client, {
        ...auth,
        assertCurrent,
      });
      return value;
    },
  );
}

async function createLockedSessionContextOverrides(
  sessionKey = "agent:main:test:locked",
): Promise<{ config: PluginCommandContext["config"]; sessionKey: string }> {
  const storePath = path.join(tempDir, "locked-sessions.json");
  await seedSession(storePath, sessionKey, {
    agentHarnessId: "codex",
    modelSelectionLocked: true,
  });
  return {
    config: { session: { store: storePath } },
    sessionKey,
  };
}

function disabledPluginsIO(): CodexPluginsManagementIO {
  return {
    readConfig: async () => ({ enabled: false, plugins: {} }),
    mutate: async () => {
      throw new Error("Discovery must not mutate plugin configuration");
    },
  };
}

function buttonCommands(result: PluginCommandResult): string[] {
  const block = result.presentation?.blocks.find((candidate) => candidate.type === "buttons");
  if (!block || block.type !== "buttons") {
    throw new Error("expected button presentation");
  }
  return block.buttons.map((button) =>
    button.action?.type === "command" ? button.action.command : "",
  );
}

function installAuthProfileStore(
  store: AuthProfileStore,
  config: PluginCommandContext["config"],
  agentDir = resolveDefaultAgentDir(config),
) {
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store,
    },
  ]);
}

function codexRateLimitPayload(params: {
  primaryUsedPercent: number;
  secondaryUsedPercent: number;
  primaryResetSeconds: number;
  secondaryResetSeconds: number;
  reached?: boolean;
}) {
  return {
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: {
          usedPercent: params.primaryUsedPercent,
          windowDurationMins: 300,
          resetsAt: params.primaryResetSeconds,
        },
        secondary: {
          usedPercent: params.secondaryUsedPercent,
          windowDurationMins: 10080,
          resetsAt: params.secondaryResetSeconds,
        },
        credits: null,
        planType: "plus",
        rateLimitReachedType: params.reached ? "rate_limit_reached" : null,
      },
    },
  };
}

describe("codex command", () => {
  useCodexCommandTestState({
    onSetup: (stateDir) => {
      tempDir = stateDir;
    },
    beforeCleanup: () => {
      for (const client of resumeClients.splice(0)) {
        client.close();
      }
    },
  });

  it("escapes unknown subcommands before chat display", async () => {
    const result = await runCommand("<@U123> [trusted](https://evil) @here");

    expect(result.text).toContain("Unknown Codex command: &lt;\uff20U123&gt;");
    expect(result.text).not.toContain("<@U123>");
  });

  it("renders the command picker", async () => {
    expect(buttonCommands(await runCommand(""))).toContain("/codex plugins menu");
  });

  it("routes owner-only plugin discovery through the native command boundary with its workspace", async () => {
    const codexPluginsManagementIo = disabledPluginsIO();
    const sessionKey = "agent:main:plugin-discovery";
    const storePath = path.join(tempDir, "plugin-discovery-sessions.json");
    await seedSession(storePath, sessionKey, { agentHarnessId: "codex" });
    const codexControlRequest = vi.fn(async () => ({
      marketplaces: [
        {
          name: "company-tools",
          path: "/company/.agents/plugins/marketplace.json",
          plugins: [
            {
              id: "security-review@company-tools",
              name: "security-review",
              installed: false,
              enabled: false,
            },
          ],
        },
      ],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    }));

    const pluginConfig = { appServer: { defaultWorkspaceDir: "/company" } };
    const resolvePluginConfig = vi.fn(() => pluginConfig);
    const result = await runCommand(
      "plugins available",
      { codexPluginsManagementIo, codexControlRequest },
      {
        sessionKey,
        sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
      },
      { pluginConfig: { appServer: { defaultWorkspaceDir: "/stale" } }, resolvePluginConfig },
    );

    expectResultText(result, "security-review@company-tools");

    expect(mockArg(codexControlRequest, 0, 0)).toEqual(pluginConfig);
    expect(mockArg(codexControlRequest, 0, 1)).toBe(CODEX_CONTROL_METHODS.listPlugins);
    expect(requestParams(codexControlRequest)).toEqual({ cwds: ["/company"] });
    expect(mockArg(codexControlRequest, 0, 3)).toMatchObject({
      sessionId: "session-1",
      sessionKey,
      storePath,
    });

    codexControlRequest.mockClear();
    const denied = await runCommand(
      "plugins available",
      { codexPluginsManagementIo, codexControlRequest },
      { senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
    );
    expectResultText(denied, "Only an owner or operator.admin");
    expect(codexControlRequest).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "requires admin scope for non-owner account inspection (admin: %s)",
    async (admin) => {
      const request = vi.fn(async () => probeOk({}));
      const result = await runCommand(
        "account",
        { safeCodexControlRequest: request },
        {
          senderIsOwner: false,
          gatewayClientScopes: [admin ? "operator.admin" : "operator.write"],
        },
      );
      expectText(result, admin ? "Account: available" : "Only an owner or operator.admin");
      if (admin) {
        expect(request).toHaveBeenCalled();
      } else {
        expect(request).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])("lists scoped models safely (non-owner: %s)", async (nonOwner) => {
    const config = { auth: { order: { openai: ["openai:work"] } } };
    const listCodexAppServerModels = vi.fn(async () => ({
      models: (nonOwner ? [] : ["gpt-5.4", "unsafe_model <@U123> [trusted](https://evil)"]).map(
        modelEntry,
      ),
      ...(nonOwner ? {} : { truncated: true }),
    }));
    const result = await runCommand(
      "models",
      { listCodexAppServerModels },
      nonOwner
        ? {
            senderIsOwner: false,
            gatewayClientScopes: ["operator.write"],
            assertOwnerCurrent: () => {
              throw new Error("Caller is not a channel owner");
            },
          }
        : { config },
    );
    if (nonOwner) {
      expectNoText(result, "Only an owner or operator.admin", "Codex command failed");
    } else {
      expect(result.text).toBe(
        "Codex models:\n- gpt-5.4\n- unsafe\uff3fmodel &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09\n- More models available; output truncated.",
      );
      expect(listCodexAppServerModels).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ config, agentDir: resolveDefaultAgentDir(config), limit: 100 }),
      );
    }
  });

  it("never sends a paired-node workspace to the gateway Codex app-server", async () => {
    const codexPluginsManagementIo = disabledPluginsIO();
    const codexControlRequest = vi.fn(async () => ({
      marketplaces: [],
      marketplaceLoadErrors: [],
      featuredPluginIds: [],
    }));

    await runCommand(
      "plugins available",
      { codexPluginsManagementIo, codexControlRequest },
      {
        getCurrentConversationBinding: async () =>
          publicConversationBinding({
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "paired-node",
            sessionId: "remote-session",
            cwd: "/remote/node/private-workspace",
          }),
      },
      { pluginConfig: { appServer: { defaultWorkspaceDir: "/gateway/workspace" } } },
    );

    expect(codexControlRequest).toHaveBeenCalledWith(
      { appServer: { defaultWorkspaceDir: "/gateway/workspace" } },
      CODEX_CONTROL_METHODS.listPlugins,
      { cwds: ["/gateway/workspace"] },
      expect.anything(),
    );
    expect(codexControlRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      CODEX_CONTROL_METHODS.listPlugins,
      expect.objectContaining({ cwds: ["/remote/node/private-workspace"] }),
      expect.anything(),
    );
  });

  it.each([
    { knownBeforeResume: true, sameOwner: false },
    { knownBeforeResume: false, sameOwner: false },
    { knownBeforeResume: false, sameOwner: true },
  ])(
    "rejects a parent-owned child without displacing the current owner (preflight: $knownBeforeResume, same owner: $sameOwner)",
    async ({ knownBeforeResume, sameOwner }) => {
      const harness = nativeClient();

      const threadId = "thread-parent-owned";
      const existingThreadId = sameOwner ? threadId : "thread-existing";
      const identity = sessionIdentity;
      const release = vi.fn(async () => undefined);
      await retainThread(harness.client, existingThreadId, release);
      await bindThread(existingThreadId, { clientId: harness.client.getInstanceId() }, identity);
      const before = storedBinding(identity);
      const response = threadResponse({ threadId, canAcceptDirectInput: false });
      const request = mockResumeRequest(harness.client, response, {
        thread: { ...response.thread, canAcceptDirectInput: knownBeforeResume ? false : null },
      });
      const retainClient = await retainClientById(harness.client);
      const codexControlRequest = vi.fn(
        async (
          _pluginConfig: unknown,
          method: string,
          controlParams: unknown,
          options?: CodexControlRequestOptions,
        ) => {
          await options?.beforeRequest?.(
            async <T>({
              method: scopedMethod,
              requestParams: scopedParams,
            }: {
              method: string;
              requestParams?: unknown;
            }) => await harness.client.request<T>(scopedMethod, scopedParams),
            harness.client,
            { assertCurrent: () => undefined },
          );
          const value = await harness.client.request(method, controlParams);
          await options?.onResponse?.(value, harness.client, { assertCurrent: () => undefined });
          return value;
        },
      );

      try {
        const result = await runCommand(`resume ${threadId}`, { codexControlRequest });

        expect(result.text).toContain("controlled by its parent");
        expect(storedBinding(identity)).toEqual(before);
        expect(release).not.toHaveBeenCalled();
        const mutations = mutatingCodexRequestMethods(request.mock.calls);
        expect(mutations).toEqual(
          knownBeforeResume
            ? []
            : sameOwner
              ? ["thread/resume"]
              : ["thread/resume", "thread/unsubscribe"],
        );
        await expectLiveThread(harness.client, existingThreadId);
      } finally {
        retainClient.mockRestore();
      }
    },
  );

  it.each([
    { retainedBeforeResume: false, failure: "deadline" },
    { retainedBeforeResume: true, failure: "read" },
    { retainedBeforeResume: true, failure: "resume" },
  ])(
    "cleans up a rejected same-client resume only when no native owner remains (retained: $retainedBeforeResume, failure: $failure)",
    async ({ retainedBeforeResume, failure }) => {
      const { context, identity } = await runtimeSession("agent:main:test:same-client-resume");
      const { codexControlRequest } = await import("./command-rpc.js");
      const sharedClientRuntime = await import("./app-server/shared-client.js");
      const harness = nativeClient();

      const threadId = "thread-same-client-resume";

      const release = vi.fn(async () => undefined);
      if (retainedBeforeResume) {
        await retainThread(harness.client, threadId, release);
      }
      const releaseSibling = vi.fn(async () => undefined);
      await retainThread(harness.client, "thread-sibling", releaseSibling);
      await bindThread(threadId, { clientId: harness.client.getInstanceId() }, identity);
      const before = storedBinding(identity);
      const acquireClient = vi
        .spyOn(sharedClientRuntime, "getLeasedSharedCodexAppServerClient")
        .mockResolvedValue(harness.client);
      const releaseLease = vi.spyOn(sharedClientRuntime, "releaseLeasedSharedCodexAppServerClient");
      const response = threadResponse({ threadId, canAcceptDirectInput: true });
      let resumeAccepted = false;
      const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
        if (method === "thread/read") {
          return { thread: response.thread } as never;
        }
        if (method === "thread/resume") {
          resumeAccepted = true;
          if (failure === "resume") {
            throw new CodexAppServerRpcError(
              { code: -32_603, message: "resume response assembly failed" },
              method,
            );
          }
          return response as never;
        }
        if (method === "thread/unsubscribe") {
          return {} as never;
        }
        throw new Error(`unexpected Codex method ${method}`);
      });
      const elapsedClock = vi.spyOn(performance, "now").mockReturnValue(0);
      try {
        const result = await runCommand(
          `resume ${threadId}`,
          {
            codexControlRequest,
            bindingStore: {
              ...testCodexAppServerBindingStore,
              readAsync: async (bindingIdentity) => {
                if (resumeAccepted) {
                  if (failure === "read") {
                    throw new Error("Invalid Codex app-server binding row");
                  }
                  elapsedClock.mockReturnValue(1_001);
                }
                return await testCodexAppServerBindingStore.readAsync(bindingIdentity);
              },
            },
          },
          context,
          { pluginConfig: { appServer: { requestTimeoutMs: 1_000, homeScope: "user" } } },
        );

        const keepsExistingOwner = retainedBeforeResume && failure !== "resume";
        expect(result.text).toContain(
          failure === "resume"
            ? "resume response assembly failed"
            : failure === "read"
              ? "Invalid Codex app-server binding row"
              : "timed out",
        );
        expect(request.mock.calls.map(([method]) => method)).toEqual(
          keepsExistingOwner
            ? ["thread/read", "thread/resume"]
            : ["thread/read", "thread/resume", "thread/unsubscribe"],
        );
        expect(release).not.toHaveBeenCalled();
        expect(releaseSibling).not.toHaveBeenCalled();
        expect(releaseLease).toHaveBeenCalledExactlyOnceWith(harness.client);
        expect(harness.stdinDestroyed).toBe(false);
        expect(storedBinding(identity)).toEqual(before);
        await expect(consumeThread(harness.client, threadId)).resolves.toEqual(
          keepsExistingOwner
            ? expect.objectContaining({ release: expect.any(Function) })
            : undefined,
        );
        await expectLiveThread(harness.client, "thread-sibling");
      } finally {
        releaseLease.mockRestore();
        acquireClient.mockRestore();

        elapsedClock.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "migrates manual resume ownership across physical clients (old release fails: %s)",
    async (rejectOldRelease) => {
      const previous = nativeClient();
      const replacement = nativeClient();

      const identity = sessionIdentity;
      await bindThread(
        "thread-manual-migration",
        { clientId: previous.client.getInstanceId() },
        identity,
      );
      const operations: string[] = [];
      const ownerDuringRelease: Array<string | undefined> = [];
      vi.spyOn(previous.client, "request").mockImplementation(async (method) => {
        operations.push(`previous:${method}`);
        ownerDuringRelease.push(storedBinding(identity)?.clientId);
        if (rejectOldRelease) {
          throw new Error("previous manual owner unsubscribe failed");
        }
        return {} as never;
      });
      vi.spyOn(replacement.client, "request").mockImplementation(async (method) => {
        operations.push(`replacement:${method}`);
        return {} as never;
      });
      await expect(retainThread(previous.client, "thread-manual-migration")).resolves.toBe(true);
      const retainPreviousClient = await retainClientById(previous.client);
      const response = threadResponse({ threadId: "thread-manual-migration" });
      const codexControlRequest = createResumeControlRequest(response, {
        client: replacement.client,
      });

      try {
        const result = await runCommand("resume thread-manual-migration", { codexControlRequest });

        expect(result.text).toContain(
          rejectOldRelease
            ? "previous manual owner unsubscribe failed"
            : "Attached this OpenClaw session",
        );
        expect(operations).toEqual(
          rejectOldRelease
            ? ["previous:thread/unsubscribe", "replacement:thread/unsubscribe"]
            : ["previous:thread/unsubscribe"],
        );
        expect(ownerDuringRelease).toEqual([previous.client.getInstanceId()]);
        expect(storedBinding(identity)).toMatchObject({
          threadId: "thread-manual-migration",
          clientId: rejectOldRelease
            ? previous.client.getInstanceId()
            : replacement.client.getInstanceId(),
        });
        const survivingClient = rejectOldRelease ? previous.client : replacement.client;
        const obsoleteClient = rejectOldRelease ? replacement.client : previous.client;
        await expectLiveThread(survivingClient, "thread-manual-migration");
        await expect(
          consumeThread(obsoleteClient, "thread-manual-migration"),
        ).resolves.toBeUndefined();
      } finally {
        retainPreviousClient.mockRestore();
      }
    },
  );

  it("preserves known native config ownership when manually resuming the same thread", async () => {
    const harness = nativeClient();

    const identity = sessionIdentity;
    await bindThread(
      "thread-known-resume",
      {
        clientId: harness.client.getInstanceId(),
        authProfileId: "openai:previous",
        dynamicToolsFingerprint: "known-dynamic-tools",
        webSearchThreadConfigFingerprint: "known-web-search",
        pluginAppsFingerprint: "known-plugin-apps",
      },
      identity,
    );
    const release = vi.fn(async () => undefined);
    await retainThread(
      harness.client,
      "thread-known-resume",
      release,
      "known-native-config",
      "priority",
    );
    const response = threadResponse({ threadId: "thread-known-resume" });
    const codexControlRequest = createResumeControlRequest(response, { client: harness.client });

    await expect(
      runCommand("resume thread-known-resume", { codexControlRequest }),
    ).resolves.toMatchObject({
      text: "Attached this OpenClaw session to Codex thread thread-known-resume.",
    });
    expect(storedBinding(identity)).toMatchObject({
      dynamicToolsFingerprint: "known-dynamic-tools",
      pluginAppsFingerprint: "known-plugin-apps",
    });
    expect(storedBinding(identity)?.authProfileId).toBeUndefined();
    await expect(
      consumeThread(harness.client, "thread-known-resume", "known-native-config"),
    ).resolves.toEqual(
      expect.objectContaining({
        configFingerprint: "known-native-config",
        serviceTier: "priority",
      }),
    );
    expect(release).not.toHaveBeenCalled();
  });

  it("refuses an active native child while preserving another thread owner", async () => {
    const existingThreadId = "thread-existing-resume";

    const harness = nativeClient();

    const response = threadResponse({ threadId: "thread-active-resume" });
    const request = mockResumeRequest(harness.client, response);
    const parent = await codexNativeSubagentMonitorRuntime.register({
      client: harness.client,
      parentThreadId: "thread-parent",
    });
    const identity = sessionIdentity;
    await bindThread(existingThreadId, { clientId: harness.client.getInstanceId() }, identity);
    await retainThread(harness.client, existingThreadId);
    harness.send({
      method: "thread/started",
      params: {
        thread: {
          id: "thread-active-resume",
          parentThreadId: "thread-parent",
          source: {
            subAgent: {
              thread_spawn: {
                parent_thread_id: "thread-parent",
                depth: 1,
                agent_path: "thread-active-resume",
              },
            },
          },
        },
      },
    });
    const codexControlRequest = createResumeControlRequest(
      async () => {
        await harness.client.request("thread/resume", {
          threadId: "thread-active-resume",
          excludeTurns: true,
        });
        return response;
      },
      { client: harness.client },
    );

    try {
      await vi.waitFor(() =>
        expect(isThreadClaimed(harness.client, "thread-active-resume")).toBe(true),
      );
      const result = await runCommand("resume thread-active-resume", { codexControlRequest });

      expect(result.text).toContain("lost its native subscription owner");
      expect(mutatingCodexRequestMethods(request.mock.calls)).toEqual(["thread/resume"]);
      expect(isThreadClaimed(harness.client, "thread-active-resume")).toBe(true);
      expect(storedBinding(identity)).toMatchObject({
        threadId: existingThreadId,
      });
      await expect(retainThread(harness.client, "thread-active-resume")).resolves.toBe(false);
      const previousOwnership = await consumeThread(harness.client, existingThreadId);
      expect(previousOwnership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
      await expect(
        retainThread(harness.client, existingThreadId, previousOwnership?.release),
      ).resolves.toBe(true);
    } finally {
      await parent.unregister();
    }
  });

  it("serializes manual resume with other session binding owners", async () => {
    const identity = sessionIdentity;
    const order: string[] = [];
    const entered = createDeferred<void>();
    const contenderObserved = createDeferred<void>();
    const state = createCodexTestBindingStateStore();
    const bindingStore = createCodexAppServerBindingStore({
      ...state,
      withCurrent(authority) {
        const current = state.withCurrent(authority);
        return {
          ...current,
          async compareAndApply(key, comparison, intent) {
            const result = await current.compareAndApply(key, comparison, intent);
            if (intent.action === "keep") {
              contenderObserved.resolve();
            }
            return result;
          },
        };
      },
    });
    const resumeResponse = createDeferred<ReturnType<typeof threadResponse>>();
    const codexControlRequest = createResumeControlRequest(async () => {
      order.push("resume-start");
      entered.resolve();
      const response = await resumeResponse.promise;
      order.push("resume-done");
      return response;
    });

    const command = runCommand("resume thread-123", { bindingStore, codexControlRequest });
    let competingOwner: Promise<void> | undefined;
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), command.then(() => "settled")]),
      ).toBe("entered");
      competingOwner = bindingStore.withLease(identity, async () => {
        order.push("competing-owner");
        await bindingStore.mutate(identity, {
          kind: "set",
          binding: { threadId: "thread-later", cwd: "/later" },
        });
      });
      expect(
        await Promise.race([
          contenderObserved.promise.then(() => "waiting"),
          competingOwner.then(() => "settled"),
        ]),
      ).toBe("waiting");
      expect(order).toEqual(["resume-start"]);
      resumeResponse.resolve(threadResponse({ threadId: "thread-123" }));
      await expect(command).resolves.toEqual({
        text: "Attached this OpenClaw session to Codex thread thread-123. The next turn will validate its tools and apply this session's configuration before continuing.",
      });
      await competingOwner;
      expect(order).toEqual(["resume-start", "resume-done", "competing-owner"]);
      expect(bindingStore.read(identity)).toMatchObject({
        threadId: "thread-later",
        cwd: "/later",
      });
    } finally {
      resumeResponse.resolve(threadResponse({ threadId: "thread-123" }));
      await Promise.allSettled([command, competingOwner]);
    }
  });

  it("rejects manual resume of a thread owned by another OpenClaw session", async () => {
    const otherIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-other",
    };
    await bindThread("thread-owned", { cwd: "/other" }, otherIdentity);
    const codexControlRequest = vi.fn(async () => threadResponse({ threadId: "thread-owned" }));

    const result = await runCommand("resume thread-owned", { codexControlRequest });

    expect(result.text).toContain("owned by another OpenClaw session");
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(storedBinding(otherIdentity)).toMatchObject({
      threadId: "thread-owned",
    });
  });

  it("reclaims an unloaded plugin's stale generation before attaching a thread", async () => {
    const threadId = "thread-new <@U123> [trusted](https://evil)";
    const sessionKey = "agent:main:test:chat-1";
    const storePath = path.join(tempDir, "sessions.json");
    await bindThread(
      "thread-old",
      { cwd: "/old" },
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-old",
        sessionKey,
      },
    );
    await seedSession(storePath, sessionKey, { sessionId: "session-new" });
    const codexControlRequest = createResumeControlRequest(threadResponse({ threadId }));

    const result = await runCommand(
      `resume "${threadId}"`,
      { codexControlRequest },
      {
        sessionId: "session-new",
        sessionKey,
        config: { session: { store: storePath } },
      },
    );

    expect(result.text).toBe(
      "Attached this OpenClaw session to Codex thread thread-new &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09. The next turn will validate its tools and apply this session's configuration before continuing.",
    );
    expectNoText(result, "<@U123>", "[trusted](https://evil)");
    expect(
      storedBinding({
        kind: "session",
        agentId: "main",
        sessionId: "session-new",
        sessionKey,
      }),
    ).toMatchObject({ threadId });
  });

  it("resumes a replacement after adopting the explicit-store predecessor binding", async () => {
    const threadId = "thread-resumed";
    const sessionKey = "agent:main:test:explicit-resume";
    const { storePath, configuredStorePath, context } = explicitStoreContext(
      sessionKey,
      "session-new",
    );
    const identity = { kind: "session" as const, agentId: "main", sessionKey };
    await bindThread(
      "thread-existing",
      {
        dynamicToolsFingerprint: "existing-tools",
        webSearchThreadConfigFingerprint: "existing-web-search",
      },
      { ...identity, sessionId: "session-old" },
    );
    await seedSession(storePath, sessionKey, {
      sessionId: "session-new",
      previousSessionId: "session-old",
    });
    await seedSession(configuredStorePath, sessionKey, { sessionId: "unrelated-session" });
    const codexControlRequest = createResumeControlRequest(async () => {
      expect(storedBinding({ ...identity, sessionId: "session-new" })).toMatchObject({
        threadId: "thread-existing",
        dynamicToolsFingerprint: "existing-tools",
      });
      return threadResponse({ threadId });
    });

    const result = await runCommand(`resume ${threadId}`, { codexControlRequest }, context);

    expect(result.text).toBe(
      `Attached this OpenClaw session to Codex thread ${threadId}. The next turn will validate its tools and apply this session's configuration before continuing.`,
    );
    expect(mockArg(codexControlRequest, 0, 3)).toMatchObject({ storePath });
    expect(mockArg(codexControlRequest, 0, 1)).toBe(CODEX_CONTROL_METHODS.resumeThread);
    expect(storedBinding({ ...identity, sessionId: "session-new" })).toMatchObject({
      threadId,
    });
  });

  it.each(["queue", "RPC"])(
    "rejects resumed-thread publication after host rollover during %s",
    async (phase) => {
      const { context, identity, scope } = await runtimeSession();
      await seedSession(scope.storePath, scope.sessionKey, {
        previousSessionId: "session-old",
      });
      await bindThread("thread-existing", {}, { ...identity, sessionId: "session-old" });
      const rollover = () =>
        seedSession(scope.storePath, scope.sessionKey, {
          sessionId: "session-2",
          previousSessionId: "session-1",
        });
      const queue = phase === "queue" ? holdCodexThreadQueue("thread-resumed") : undefined;
      const codexControlRequest = createResumeControlRequest(async () => {
        if (phase === "RPC") {
          await rollover();
        }
        return threadResponse({ threadId: "thread-resumed" });
      });
      const command = runCommand("resume thread-resumed", { codexControlRequest }, context);
      try {
        if (queue) {
          expect(await queue.waitFor(command)).toMatchObject({
            threadId: "thread-resumed",
            identity: { ...identity, sessionId: "session-1" },
          });
          expect(storedBinding({ ...identity, sessionId: "session-1" })).toMatchObject({
            threadId: "thread-existing",
          });
          await rollover();
        }
      } finally {
        await queue?.release();
        await command;
      }
      expect((await command).text).toContain("Codex session generation is no longer current");
      expect(codexControlRequest).toHaveBeenCalledTimes(phase === "RPC" ? 1 : 0);
      expect(storedBinding({ ...identity, sessionId: "session-1" })).toMatchObject({
        threadId: "thread-existing",
      });
    },
  );

  it("rolls back replacement ownership when the host advances during displaced release", async ({
    signal,
  }) => {
    const { context, identity, scope } = await runtimeSession("agent:main:test:release-rollover");

    const predecessor = { ...identity, sessionId: "session-before-compaction" };
    await seedSession(scope.storePath, scope.sessionKey, {
      sessionId: predecessor.sessionId,
      agentHarnessId: "codex",
    });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: identity.sessionId }) });
    const previous = nativeClient();
    const replacement = nativeClient();

    await bindThread(
      "thread-release-rollover",
      { clientId: previous.client.getInstanceId() },
      predecessor,
    );
    const oldReleaseBlocked = createDeferred<void>();
    const entered = createDeferred<void>();
    const oldReleaseStarted = vi.fn(entered.resolve);
    const oldUnsubscribe = vi.fn();
    await retainThread(
      previous.client,
      "thread-release-rollover",
      async (_threadId, assertCurrent) => {
        oldReleaseStarted();
        await oldReleaseBlocked.promise;
        assertCurrent?.();
        oldUnsubscribe();
      },
    );
    const replacementRequest = vi
      .spyOn(replacement.client, "request")
      .mockImplementation(async (method) => (method === "skills/list" ? { data: [] } : {}));
    const retainPreviousClient = await retainClientById(previous.client);
    const codexControlRequest = createResumeControlRequest(
      threadResponse({ threadId: "thread-release-rollover" }),
      { client: replacement.client },
    );

    const command = runCommand("resume thread-release-rollover", { codexControlRequest }, context);
    try {
      await expect(
        withinTest(Promise.race([entered.promise, command]), signal),
      ).resolves.toBeUndefined();

      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "session-2" }) });
      oldReleaseBlocked.resolve();

      expect((await command).text).toContain("Codex session generation is no longer current");
      expect(storedBinding(identity)).toMatchObject({
        threadId: "thread-release-rollover",
        clientId: previous.client.getInstanceId(),
      });
      expect(oldUnsubscribe).not.toHaveBeenCalled();
      expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
        "thread/unsubscribe",
        { threadId: "thread-release-rollover" },
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      await expectLiveThread(previous.client, "thread-release-rollover");
      await expect(
        consumeThread(replacement.client, "thread-release-rollover"),
      ).resolves.toBeUndefined();
    } finally {
      oldReleaseBlocked.resolve();
      await command;
      retainPreviousClient.mockRestore();
    }
  });

  it("does not report a resumed thread as attached after a generation conflict", async () => {
    const mutate = vi.fn(async () => false);
    const codexControlRequest = createResumeControlRequest(
      threadResponse({ threadId: "thread-123", model: "gpt-5.5" }),
    );

    const result = await runCommand("resume thread-123", {
      bindingStore: { ...testCodexAppServerBindingStore, mutate },
      codexControlRequest,
    });

    expect(result.text).toContain(
      "Codex thread binding changed while attaching the resumed thread",
    );
    expect(result.text).not.toContain("Attached this OpenClaw session");
  });

  it("normalizes resumed global-session bindings against the host agent auth store", async () => {
    const agentDir = path.join(tempDir, "agents", "worker", "agent");
    installAuthProfileStore(
      {
        version: 1,
        profiles: { "openai:work": oauthProfile("worker@example.com", Date.now()) },
        order: { openai: ["openai:work"] },
      },
      {},
      agentDir,
    );
    const request = createResumeControlRequest(threadResponse({ threadId: "thread-123" }), {
      authProfileId: "openai:work",
    });
    const storePath = path.join(tempDir, "worker-sessions.json");
    await seedSession(storePath, "global", {}, "worker");
    await runCommand(
      "resume thread-123",
      { codexControlRequest: request },
      {
        agentId: "worker",
        sessionKey: "global",
        config: {
          agents: { entries: { main: {}, worker: {} } },
          session: { store: storePath, scope: "global" },
        },
      },
    );
    expect(mockArg(request, 0, 3)).toMatchObject({ agentDir, authProfileId: undefined });
    expect(
      storedBinding({
        kind: "session",
        agentId: "worker",
        sessionId: "session-1",
        sessionKey: "global",
      }),
    ).toMatchObject({
      threadId: "thread-123",
      authProfileId: "openai:work",
      pendingResumeConfiguration: true,
    });
    expect(storedBinding({ ...sessionIdentity, sessionKey: "global" })).toBeUndefined();
  });

  it("rejects malformed command arguments before invoking their owners", async () => {
    const bindUsage =
      "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]";
    const resumeUsage = "Usage: /codex resume <thread-id>";
    const nodeResumeUsage = "Usage: /codex resume <session-id> --host <node> --bind here";
    const cases: Array<{ args: string; text: string; sandbox?: boolean; bound?: boolean }> = [
      { args: "resume thread-123 extra", text: resumeUsage },
      { args: "bind --help", text: bindUsage, sandbox: true },
      { args: "model gpt-5.5 --help", text: "Usage: /codex model <model>", sandbox: true },
      { args: "resume", text: resumeUsage, sandbox: true },
      { args: "resume cli-1 --host node-1", text: nodeResumeUsage, sandbox: true },
      {
        args: "resume cli-1 --host node-1 --bind here extra",
        text: `${resumeUsage}\n${nodeResumeUsage}`,
        sandbox: true,
      },
      { args: "steer", text: "Usage: /codex steer <message>", sandbox: true },
      { args: "stop now", text: "Usage: /codex stop", sandbox: true },
      {
        args: "sessions --host mb-m5 --limit 5x",
        text: "Usage: /codex sessions --host <node> [filter] [--limit <n>]",
      },
      { args: "status now", text: "Usage: /codex status" },
      { args: "binding current", text: "Usage: /codex binding" },
      { args: "compact now", text: "Usage: /codex compact" },
      { args: "bind thread-123 --cwd --model gpt-5.4", text: bindUsage },
      { args: 'bind thread-123 --cwd ""', text: bindUsage },
      { args: "bind thread-123 --cwd /repo --cwd /other", text: bindUsage },
      { args: "fast on now", text: "Usage: /codex fast [on|off|status]" },
      { args: "permissions yolo now", text: "Usage: /codex permissions [default|yolo|status]" },
      {
        args: "goal __proto__",
        text: "Usage: /codex goal [status|set <objective>|pause|resume|block|complete|clear]",
        bound: true,
      },
    ];
    for (const { args, text, sandbox, bound } of cases) {
      if (bound) {
        await bindThread("thread-goal");
      }
      const operations = {
        codexControlRequest: vi.fn(),
        safeCodexControlRequest: vi.fn(),
        listCodexCliSessionsOnNode: vi.fn(),
        resolveCodexCliSessionForBindingOnNode: vi.fn(),
        readCodexStatusProbes: vi.fn(),
        listCodexAppServerModels: vi.fn(),
        setCodexConversationModel: vi.fn(),
        setCodexConversationFastMode: vi.fn(),
        setCodexConversationPermissions: vi.fn(),
        stopCodexConversationTurn: vi.fn(),
      };
      const mutate = vi.fn();
      const requestConversationBinding = vi.fn();
      const getCurrentConversationBinding = vi.fn();
      await expect(
        runCommand(
          args,
          {
            ...operations,
            ...(bound ? {} : { bindingStore: { ...testCodexAppServerBindingStore, mutate } }),
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          },
          {
            ...(sandbox ? sandboxContext() : {}),
            requestConversationBinding,
            getCurrentConversationBinding,
          },
        ),
        args,
      ).resolves.toEqual({ text });
      for (const operation of [...Object.values(operations), mutate, requestConversationBinding]) {
        expect(operation, args).not.toHaveBeenCalled();
      }
      if (args === "binding current") {
        expect(getCurrentConversationBinding, args).not.toHaveBeenCalled();
      }
    }
  });

  it.each([
    { label: "sandbox", context: sandboxContext(), reason: "OpenClaw sandboxing" },
    {
      label: "node config",
      context: nodeExecContext({ sessionKey: undefined }),
      reason: "OpenClaw exec host=node",
    },
  ])("blocks native binding under $label policy", async ({ context, reason }) => {
    const deps = {
      codexControlRequest: vi.fn(),
      steerCodexConversationTurn: vi.fn(),
      setCodexConversationModel: vi.fn(),
      setCodexConversationFastMode: vi.fn(),
      setCodexConversationPermissions: vi.fn(),
      stopCodexConversationTurn: vi.fn(),
    };
    const result = await runCommand("bind", deps, context);
    expect(result.text).toContain(
      `Codex-native /codex bind is unavailable because ${reason} is active for this session.`,
    );
    for (const operation of Object.values(deps)) {
      expect(operation).not.toHaveBeenCalled();
    }
  });

  it("allows local Codex binding status forms in sandboxed sessions", async () => {
    await seedSession(resolveStorePath(undefined, { agentId: "main" }), "sandboxed-session", {
      model: "gpt-5.6-sol",
      permissionMode: "full",
    });
    await bindThread(
      "thread-status",
      {
        cwd: tempDir,
        model: "codex-execution-model",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        serviceTier: "priority",
      },
      { ...sessionIdentity, sessionKey: "sandboxed-session" },
    );

    await expectCommand("Codex model: gpt-5.6-sol", "model", {}, sandboxContext());
    await expectCommand("Codex fast mode: on.", "fast status", {}, sandboxContext());
    await expectCommand(
      "Codex permissions: full access.",
      "permissions status",
      {},
      sandboxContext(),
    );
    await expectCommand(
      "Codex goal: Inspect status\n- Status: active\n- Tokens: 0",
      "goal",
      {
        codexControlRequest: vi.fn(async () => goalResponse("thread-status", "Inspect status")),
      },
      sandboxContext(),
    );
  });

  it.each([
    { args: "bridge", limit: undefined, populated: true },
    { args: "--limit +05 bridge", limit: 5, populated: false },
  ])("lists node sessions with normalized limits: $args", async ({ args, limit, populated }) => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        sessions: populated
          ? [
              {
                sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
                cwd: "/repo",
                updatedAt: "2026-05-13T06:30:00.000Z",
                lastMessage: "fix the bridge",
                messageCount: 2,
              },
            ]
          : [],
      },
    }));
    const result = await runCommand(`sessions --host mb-m5 ${args}`, {
      listCodexCliSessionsOnNode,
    });
    if (populated) {
      expectText(
        result,
        "Codex CLI sessions on mb-m5 / mb-m5:",
        "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
        "Bind: /codex resume 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd --host mb-m5 --bind here",
      );
    }
    expect(listCodexCliSessionsOnNode).toHaveBeenCalledWith({
      requestedNode: "mb-m5",
      filter: "bridge",
      limit,
    });
  });

  it.each([true, false])(
    "binds only a listed Codex CLI node session (listed: %s)",
    async (listed) => {
      const sessionId = "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd";
      const requestConversationBinding = vi.fn(async () => ({
        status: "bound" as const,
        binding: publicConversationBinding(),
      }));
      const resolveCodexCliSessionForBindingOnNode = vi.fn(async () => ({
        node: { nodeId: "node-123", displayName: "mb-m5" },
        session: listed ? { sessionId, cwd: "/repo", messageCount: 2 } : undefined,
      }));
      await expectCommand(
        listed
          ? `Bound this conversation to Codex CLI session ${sessionId} on node-123.`
          : `No Codex CLI session ${sessionId} was found on mb-m5.`,
        `resume ${sessionId} --host mb-m5 --bind here`,
        {
          resolveCodexCliSessionForBindingOnNode,
        },
        listed ? nodeExecContext({ requestConversationBinding }) : { requestConversationBinding },
      );
      if (listed) {
        expect(resolveCodexCliSessionForBindingOnNode).toHaveBeenCalledWith({
          requestedNode: "mb-m5",
          sessionId,
        });
        expect(requestConversationBinding).toHaveBeenCalledWith({
          summary: `Codex CLI session ${sessionId} on node-123`,
          detachHint: "/codex detach",
          data: {
            kind: "codex-cli-node-session",
            version: 1,
            nodeId: "node-123",
            sessionId,
            agentId: "main",
            cwd: "/repo",
          },
        });
      } else {
        expect(requestConversationBinding).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])("formats status probes safely (connected: %s)", async (connected) => {
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const offline = probeError(unsafe);
    const readCodexStatusProbes = vi.fn(async () =>
      connected
        ? {
            models: probeOk({
              models: [modelEntry(unsafe)],
            }),
            account: probeOk({
              account: { type: "chatgpt" as const, email: unsafe, planType: "plus" as const },
              requiresOpenaiAuth: false,
            }),
            limits: probeOk({
              rateLimits: rateLimitSnapshot("codex", null, {
                usedPercent: 42,
                windowDurationMins: 300,
                resetsAt: null,
              }),
            }),
            mcps: probeOk({ data: [] }),
            skills: probeOk({
              data: [skillGroup("/repo", [skillEntry("one"), skillEntry("two")])],
            }),
          }
        : { models: offline, account: offline, limits: offline, mcps: offline, skills: offline },
    );
    const result = await runCommand("status", { readCodexStatusProbes });
    const escaped = "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here";
    const lines = connected
      ? [
          "Codex app-server: connected",
          `Models: ${escaped}`,
          `Account: ${escaped}`,
          "Rate limits: Codex: primary 58% left",
          "MCP servers: none returned",
          "Skills: 2",
        ]
      : [
          "Codex app-server: unavailable",
          ...["Models", "Account", "Rate limits", "MCP servers", "Skills"].map(
            (label) => `${label}: ${escaped}`,
          ),
        ];
    expect(result.text).toBe(lines.join("\n"));
  });

  it("does not count empty Codex rate-limit buckets as returned limits", async () => {
    const limits = probeOk({
      rateLimits: [rateLimitSnapshot("codex", "plus")],
      rateLimitsByLimitId: {
        premium: rateLimitSnapshot("premium", "pro"),
        codex: rateLimitSnapshot("codex", "plus"),
      },
    });
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: probeError("offline"),
        account: probeError("offline"),
        limits,
        mcps: probeOk({ data: [], nextCursor: null }),
        skills: probeOk({ data: [] }),
      })),
      safeCodexControlRequest: vi
        .fn()
        .mockResolvedValueOnce(probeOk({ account: { email: "codex@example.com" } }))
        .mockResolvedValueOnce(limits),
    });

    const statusResult = await runCommand("status", deps);
    expectResultText(statusResult, "Rate limits: none returned");
    expectNoText(statusResult, "Rate limits: 1", "premium");

    const accountResult = await runCommand("account", deps);
    expectResultText(accountResult, "Rate limits: none returned");
    expectNoText(accountResult, "Rate limits: 1", "premium");
  });

  describe("account readouts", () => {
    const apiKeyProfile = (name: string) => ({
      type: "api_key" as const,
      provider: "openai",
      key: `sk-test-${name}`,
    });
    function installAccounts(
      names: string[],
      state: Pick<AuthProfileStore, "lastGood" | "usageStats" | "order"> = {},
      config: PluginCommandContext["config"] = {},
      agentDir?: string,
    ) {
      const profiles = Object.fromEntries(
        names.map((name) => [
          `openai:${name}`,
          name.includes("@") ? oauthProfile(name, Date.now()) : apiKeyProfile(name),
        ]),
      );
      installAuthProfileStore(
        {
          version: 1,
          profiles,
          order: { openai: names.map((name) => `openai:${name}`) },
          ...state,
        },
        config,
        agentDir,
      );
    }
    function accountRequests(...responses: Awaited<ReturnType<SafeCodexControlRequestFn>>[]) {
      const request = vi.fn<SafeCodexControlRequestFn>();
      for (const response of responses) {
        request.mockResolvedValueOnce(response);
      }
      return request;
    }
    function limits(primaryUsedPercent: number, secondaryUsedPercent: number, reached = false) {
      const reset = Math.ceil(Date.now() / 1000);
      return codexRateLimitPayload({
        primaryUsedPercent,
        secondaryUsedPercent,
        primaryResetSeconds: reset + 5 * 60 * 60,
        secondaryResetSeconds: reset + 23 * 60 * 60,
        reached,
      });
    }
    const readAccount = (
      safeCodexControlRequest: SafeCodexControlRequestFn,
      context: Partial<PluginCommandContext> = {},
    ) => runCommand("account", { safeCodexControlRequest }, context);

    it.each([false, true])("formats generated account responses (Bedrock: %s)", async (bedrock) => {
      const safeCodexControlRequest = accountRequests(
        probeOk<JsonValue>({
          account: bedrock
            ? { type: "amazonBedrock" }
            : { type: "chatgpt", email: "codex@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        }),
        probeOk(
          bedrock
            ? []
            : {
                rateLimits: rateLimitSnapshot("codex", "plus", {
                  usedPercent: 50,
                  windowDurationMins: 300,
                  resetsAt: Math.ceil(Date.now() / 1000) + 120,
                }),
                rateLimitsByLimitId: null,
              },
        ),
      );
      const result = await readAccount(safeCodexControlRequest);
      if (bedrock) {
        expect(result).toEqual({
          text: ["Account: Amazon Bedrock", "Rate limits: none returned"].join("\n\n"),
        });
      } else {
        expectText(result, "Account: codex@example.com", "Codex is available.");
        expect(requestParams(safeCodexControlRequest)).toEqual({ refreshToken: false });
      }
    });

    it("escapes failed account probes", async () => {
      const unsafe = "<@U123> [trusted](https://evil) @here";
      const result = await readAccount(accountRequests(probeError(unsafe), probeError(unsafe)));
      expect(result.text).toContain(
        "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
      );
      for (const raw of ["<@U123>", "[trusted](https://evil)", "@here"]) {
        expect(result.text).not.toContain(raw);
      }
    });

    it("prefers the configured ChatGPT subscription over stale API-key lastGood state", async () => {
      const config = {
        auth: { order: { openai: ["openai:personal-email@gmail.com", "openai:api-key-backup"] } },
      };
      installAccounts(
        ["personal-email@gmail.com", "api-key-backup"],
        { order: undefined, lastGood: { openai: "openai:api-key-backup" } },
        config,
      );
      const request = accountRequests(
        probeOk({
          account: { type: "chatgpt", email: "personal-email@gmail.com", planType: "pro" },
          requiresOpenaiAuth: false,
        }),
        probeOk(limits(12, 63)),
      );
      const result = await readAccount(request, { config });
      expectText(
        result,
        "Subscription  personal-email@gmail.com",
        "Weekly 63% · Short-term 12%",
        "\n  1. personal-email@gmail.com   ChatGPT subscription   — active now",
        "\n  2. api-key-backup   API key   — available if needed",
      );
      expectNoText(result, "Now using: api-key-backup", "subscription unavailable", "openai:");
    });

    it("explains when an API-key backup is active because the subscription is paused", async () => {
      const config = {};
      const agentDir = path.join(tempDir, "agents", "worker", "agent");
      const now = Date.now();
      installAccounts(
        [
          "personal-email@gmail.com",
          "api-key-backup",
          "work-email@gmail.com",
          "work-api-key-backup",
        ],
        {
          lastGood: { openai: "openai:personal-email@gmail.com" },
          usageStats: {
            "openai:personal-email@gmail.com": { blockedUntil: now + 23 * 60 * 60 * 1000 },
          },
        },
        config,
        agentDir,
      );
      const request = accountRequests(
        probeOk({ account: { type: "unknown" }, requiresOpenaiAuth: true }),
        probeError("chatgpt authentication required to read rate limits"),
        probeOk(limits(0, 100, true)),
      );
      const result = await readAccount(request, { config, sessionKey: "agent:worker:session-1" });
      expectText(
        result,
        "Now using: api-key-backup",
        "subscription rate-limited · switches back in",
        "Subscription  personal-email@gmail.com",
        "\n  Weekly 100% · Short-term 0% · Resets in",
        "\n  1. personal-email@gmail.com   ChatGPT subscription   — rate-limited",
        "\n  2. api-key-backup   API key   — active now · billed per token",
        "\n  3. work-email@gmail.com   ChatGPT subscription   — available if needed",
        "\n  4. work-api-key-backup   API key   — available if needed",
      );
      expectNoText(
        result,
        "Reason:",
        "fallback active",
        "not tracked",
        "chatgpt authentication required",
        "openai:",
        "primary",
        "secondary",
        "personal-email@gmail.com   ChatGPT subscription   — active now",
      );
      expect(request).toHaveBeenNthCalledWith(3, {}, CODEX_CONTROL_METHODS.rateLimits, undefined, {
        config,
        agentDir,
        authProfileId: "openai:personal-email@gmail.com",
        isolated: true,
      });
    });

    it("shows temporary and permanent auth cooldowns as expired subscriptions", async () => {
      const config = {};
      const now = Date.now();
      installAccounts(
        ["expired@example.com", "dead@example.com", "api-key"],
        {
          usageStats: {
            "openai:expired@example.com": {
              cooldownUntil: now + 60 * 60 * 1000,
              cooldownReason: "auth",
              cooldownClassification: "wham_token_expired",
            },
            "openai:dead@example.com": {
              cooldownUntil: now + 60 * 60 * 1000,
              cooldownReason: "auth_permanent",
              cooldownClassification: "wham_account_dead",
            },
          },
        },
        config,
      );
      const request = accountRequests(
        probeOk({ account: { type: "unknown" }, requiresOpenaiAuth: false }),
        probeError("rate limits unavailable"),
        probeError("subscription limits unavailable"),
      );
      const result = await readAccount(request, { config });
      expectText(
        result,
        "\n  1. expired@example.com   ChatGPT subscription   — sign-in expired",
        "\n  2. dead@example.com   ChatGPT subscription   — sign-in expired",
        "\n  3. api-key   API key   — active now",
      );
      expect(result.text).not.toContain("temporarily unavailable");
    });
  });

  it.each([true, false])("reports host compaction safely (compacted: %s)", async (compacted) => {
    const runtime = await runtimeContext(tempDir, "agent:main:test:conversation-compact-recovery");
    await seedSession(runtime.sessionTarget.storePath, runtime.sessionKey, {
      ...(compacted ? { previousSessionId: "session-before-compact" } : {}),
      agentHarnessId: "codex",
    });
    const owner = {
      threadId: compacted ? "thread-recovered-compact" : "thread-123",
      cwd: "/repo",
      ...(compacted
        ? {
            clientId: "client-recovered-compact",
            contextEngine: {
              schemaVersion: 1,
              engineId: "lossless-claw",
              policyFingerprint: "policy-1",
              projection: { schemaVersion: 1, mode: "thread_bootstrap", epoch: "epoch-1" },
            },
          }
        : {}),
    } satisfies Parameters<typeof writeTestBinding>[1];
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: compacted ? "session-before-compact" : "session-1",
        sessionKey: runtime.sessionKey,
      },
      owner,
    );
    if (compacted) {
      await writeTestBinding(conversationIdentity, owner);
    }
    const compactCurrent = vi.fn(async () =>
      compacted
        ? { compacted: true, tokensBefore: 900, tokensAfter: 123 }
        : { compacted: false, reason: "thread-123 <@U123>" },
    );
    const codexControlRequest = vi.fn();

    const result = await runCommand(
      "compact",
      { codexControlRequest },
      {
        ...runtime,
        runtimeContext: { compactCurrent },
        ...(compacted
          ? {
              getCurrentConversationBinding: async () => nativeConversation("/repo"),
            }
          : {}),
      },
    );
    if (compacted) {
      expect(result).toEqual({ text: "Compacted Codex session (123 tokens after)." });
    } else {
      expect(result.text).toContain("thread-123 &lt;\uff20U123&gt;");
      expect(result.text).not.toContain("<@U123>");
    }

    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(storedBinding({ ...sessionIdentity, sessionKey: runtime.sessionKey })).toMatchObject(
      owner,
    );
  });

  it.each([
    { mode: "wrong-runtime", expected: "not using the Codex runtime" },
    { mode: "different-thread", expected: "conversation-bound thread differs" },
    {
      mode: "missing-binding",
      expected: "No Codex thread is attached to this OpenClaw session yet.",
    },
    { mode: "missing-target", expected: "not bound to a complete session identity" },
  ])("rejects host compaction with $mode", async ({ mode, expected }) => {
    const runtime = mode === "missing-target" ? undefined : await runtimeContext(tempDir);
    if (mode !== "missing-binding") {
      await bindThread(
        "thread-session",
        { clientId: "client-session" },
        { ...sessionIdentity, ...(runtime ? { sessionKey: runtime.sessionKey } : {}) },
      );
    }
    if (mode === "wrong-runtime" && runtime) {
      await seedSession(runtime.sessionTarget.storePath, runtime.sessionKey, {
        agentHarnessId: "openclaw",
      });
    }
    if (mode === "different-thread") {
      await bindThread(
        "thread-conversation",
        { clientId: "client-conversation" },
        conversationIdentity,
      );
    }
    const compactCurrent = vi.fn(async () => ({ compacted: true, tokensAfter: 321 }));
    const result = await runCommand(
      "compact",
      {},
      {
        ...runtime,
        runtimeContext: { compactCurrent },
        ...(mode === "different-thread"
          ? {
              getCurrentConversationBinding: async () => nativeConversation("/repo"),
            }
          : {}),
      },
    );
    if (mode === "missing-binding") {
      expect(result).toEqual({ text: expected });
    } else {
      expect(result.text).toContain(expected);
    }
    expect(compactCurrent).not.toHaveBeenCalled();
  });

  it("starts supervised review through the native user-home connection", async () => {
    const runtime = await runtimeContext(tempDir);
    await writeTestBinding(
      { ...sessionIdentity, sessionKey: runtime.sessionKey },
      supervisedTestBinding(),
    );
    const request = vi.fn(async () => undefined);
    const result = await runCommand("review", { codexControlRequest: request }, runtime, {
      pluginConfig: { supervision: { enabled: true } },
    });
    expect(result.text).toBe("Started Codex review for thread thread-supervised.");
    expect(requestParams(request)).toEqual({
      threadId: "thread-supervised",
      target: { type: "uncommittedChanges" },
    });
    expect(mockArg(request, 0, 3)).toMatchObject({
      config: runtime.config,
      authProfileId: null,
      startOptions: { homeScope: "user" },
    });
  });

  it("formats failed Codex Computer Use live probes as not ready", async () => {
    const ready = computerUseReadyStatus();
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...ready,
      ready: false,
      reason: "live_test_failed" as const,
      pluginName: "<@U123>",
      mcpServerName: "computer-use [server](https://evil)",
      marketplaceName: "desktop_tools",
      tools: ["list_apps", "[click](https://evil)"],
      liveTest: {
        ...ready.liveTest,
        status: "failed" as const,
        ok: false,
        attempts: 2,
        retried: true,
      },
      warnings: ["Computer Use live test failed"],
      message: "Computer Use live test failed @here.",
    }));
    const result = await runCommand("computer-use status", { readCodexComputerUseStatus });
    expectText(
      result,
      "Computer Use: not ready",
      "Live test: failed (2 attempts, 60000ms)",
      "Warning: Computer Use live test failed",
      "Plugin: &lt;\uff20U123&gt; (installed)",
      "MCP server: computer-use \uff3bserver\uff3d\uff08https://evil\uff09 (2 tools)",
      "Marketplace: desktop\uff3ftools",
      "Tools: list\uff3fapps, \uff3bclick\uff3d\uff08https://evil\uff09",
      "Computer Use live test failed \uff20here.",
    );
    expectNoText(result, "<@U123>", "[click](https://evil)", "@here");
  });

  it("formats disabled installed Codex Computer Use plugins", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      ready: false,
      reason: "plugin_disabled" as const,
      pluginEnabled: false,
      mcpServerAvailable: false,
      tools: [],
    }));
    const result = await runCommand("computer-use status", { readCodexComputerUseStatus });
    expectText(result, "Plugin: computer-use (installed, disabled)");
  });

  it("installs Codex Computer Use from command overrides", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await runCommand(
      "computer-use install --source github:example/desktop-tools --marketplace desktop-tools",
      { installCodexComputerUse },
    );

    expectResultText(result, "Computer Use: ready");
    expect(mockArg(installCodexComputerUse, 0, 0)).toMatchObject({
      agentDir: path.join(tempDir, "agents", "main", "agent"),
      forceEnable: true,
      overrides: {
        marketplaceSource: "github:example/desktop-tools",
        marketplaceName: "desktop-tools",
      },
    });
  });

  it.each([
    [
      "install --mcp-server custom-server",
      'computerUse.mcpServerName = "custom-server"',
      "install",
    ],
    [
      'install --plugin custom-plugin --source github:example/tools --marketplace tools --marketplace-path "/tmp/My Tools"',
      'computerUse.pluginName = "custom-plugin"',
      'install --source "github:example/tools" --marketplace-path "/tmp/My Tools" --marketplace "tools"',
    ],
  ])(
    "routes legacy one-off Computer Use identity override %s to persistent config",
    async (command, setting, action) => {
      const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());
      const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());

      const result = await runCommand(`computer-use ${command}`, {
        installCodexComputerUse,
        readCodexComputerUseStatus,
      });

      expectResultText(result, setting);
      expectResultText(result, `rerun /codex computer-use ${action}`);
      expect(installCodexComputerUse).not.toHaveBeenCalled();
      expect(readCodexComputerUseStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects ambiguous Computer Use actions before setup checks", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await runCommand("computer-use status install", {
      readCodexComputerUseStatus,
      installCodexComputerUse,
    });

    expectResultText(result, "Usage: /codex computer-use");
    expect(readCodexComputerUseStatus).not.toHaveBeenCalled();
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("uses the host agent for diagnostics inventory sessions with unscoped keys", async () => {
    await bindThread(
      "thread-global",
      {},
      {
        kind: "session",
        agentId: "first",
        sessionId: "session-global",
        sessionKey: "global",
      },
    );

    const request = await runCommand(
      "diagnostics global repro",
      {},
      {
        agentId: "first",
        sessionId: undefined,
        diagnosticsSessions: [
          {
            sessionKey: "global",
            sessionId: "session-global",
            channel: "telegram",
          },
        ],
      },
    );

    expectText(
      request,
      "Codex runtime thread detected.",
      "OpenClaw session key: `global`",
      "Codex thread id: `thread-global`",
    );
  });

  it.each([
    { context: { senderIsOwner: false }, text: "Only an owner can send Codex diagnostics." },
    {
      context: { senderId: undefined },
      text: "Cannot send Codex diagnostics because this command did not include a sender identity.",
    },
  ])("rejects diagnostics without requester authority: $text", async ({ context, text }) => {
    await bindThread("thread-owner");
    const safeCodexControlRequest = vi.fn(async () => probeOk({ threadId: "thread-owner" }));
    await expectCommand(text, "diagnostics", { safeCodexControlRequest }, context);
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it.each([
    {
      changed: { senderId: "user-2" },
      text: "Only the user who requested these Codex diagnostics can confirm the upload.",
    },
    {
      changed: { accountId: "account-2" },
      text: "This Codex diagnostics confirmation belongs to a different account.",
    },
  ])("keeps diagnostics confirmation scoped to its requester: $text", async ({ changed, text }) => {
    const f = await diagnosticsFixture("thread-account", {
      senderId: "user-1",
      accountId: "account-1",
      channelId: "channel-1",
      messageThreadId: "thread-1",
      threadParentId: "parent-1",
      sessionKey: "session-key-1",
    });
    const token = await f.request();
    await expect(f.run(`diagnostics confirm ${token}`, changed)).resolves.toEqual({ text });
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("consumes diagnostics confirmations before async upload work", async () => {
    await bindThread("thread-race");
    const firstConfirmUpload = createDeferred<void>();
    const firstConfirmUploadStarted = createDeferred<void>();
    const safeCodexControlRequest = vi.fn(async () => {
      firstConfirmUploadStarted.resolve();
      await firstConfirmUpload.promise;
      return probeOk({ threadId: "thread-race" });
    });
    const deps = createDeps({ safeCodexControlRequest });

    const request = await runCommand("diagnostics", deps, { senderId: "user-1" });
    const token = readDiagnosticsConfirmationToken(request);
    const firstConfirm = runCommand(`diagnostics confirm ${token}`, deps, { senderId: "user-1" });
    try {
      expect(
        await Promise.race([
          firstConfirmUploadStarted.promise.then(() => "entered"),
          firstConfirm.then(() => "settled"),
        ]),
      ).toBe("entered");
      await expectCommand(
        "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.",
        `diagnostics confirm ${token}`,
        deps,
        { senderId: "user-1" },
      );
    } finally {
      firstConfirmUpload.resolve();
      await firstConfirm;
    }
    const firstConfirmResult = await firstConfirm;
    expectResultText(firstConfirmResult, "Codex diagnostics sent to OpenAI servers:");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("allows private-routed diagnostics confirmations from the owner DM", async () => {
    const f = await diagnosticsFixture("thread-private", {
      accountId: "account-1",
      channelId: "group-channel",
      messageThreadId: "group-topic",
      sessionKey: "group-session",
      diagnosticsPrivateRouted: true,
    });
    const token = await f.request();
    const result = await f.run(`diagnostics confirm ${token}`, {
      channelId: "owner-dm",
      sessionKey: "owner-dm-session",
      diagnosticsPrivateRouted: false,
    });
    expectText(
      result,
      "Codex diagnostics sent to OpenAI servers:",
      "OpenClaw session key: `group-session`",
      "Codex thread id: `thread-private`",
    );
    expect(requestParams(f.upload)).toMatchObject({
      classification: "bug",
      threadId: "thread-private",
      includeLogs: true,
    });
    await bindThread(
      "thread-private-next",
      {},
      { ...sessionIdentity, sessionKey: "group-session" },
    );
    expectText(
      await f.run("diagnostics"),
      "Codex diagnostics were already sent for this account or channel recently",
    );
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics confirmation eviction scoped to account identity", async () => {
    const f = await diagnosticsFixture("thread-confirm-scope", {
      accountId: "account-kept",
      channelId: "channel-kept",
    });
    const token = await f.request();
    for (let index = 0; index < 100; index += 1) {
      await f.run(`diagnostics ${index}`, {
        accountId: "account-noisy",
        channelId: "channel-noisy",
      });
    }
    expectText(
      await f.run(`diagnostics cancel ${token}`),
      "Codex diagnostics upload canceled.",
      "Codex thread id: `thread-confirm-scope`",
    );
    expect(f.upload).not.toHaveBeenCalled();
  });

  it("throttles repeated diagnostics uploads for the same thread", async () => {
    const f = await diagnosticsFixture("thread-cooldown");
    const token = await f.request("first");
    expectText(
      await f.run(`diagnostics confirm ${token}`),
      "Codex diagnostics sent to OpenAI servers:",
      "Codex thread id: `thread-cooldown`",
    );
    await expect(f.run("diagnostics again")).resolves.toEqual({
      text: "Codex diagnostics were already sent for thread thread-cooldown recently. Try again in 60s.",
    });
    expect(f.upload).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "short delimiter-containing ids",
      scopes: [
        { accountId: "a", channelId: "b", channel: "test|channel:x" },
        { accountId: "a|channelId:b", channel: "test|channel:x" },
      ],
    },
    {
      label: "long ids with a shared prefix",
      scopes: [
        { accountId: "account-".repeat(40) + "first", channelId: "channel-long" },
        { accountId: "account-".repeat(40) + "second", channelId: "channel-long" },
      ],
    },
  ])("keeps diagnostics cooldown scopes independent for $label", async ({ scopes }) => {
    const safeCodexControlRequest = vi.fn(async () => probeOk({}));
    for (const [index, scope] of scopes.entries()) {
      await bindThread(`thread-scope-${index}`);
      const request = await runCommand("diagnostics", { safeCodexControlRequest }, scope);
      const token = readDiagnosticsConfirmationToken(request);
      const result = await runCommand(
        `diagnostics confirm ${token}`,
        { safeCodexControlRequest },
        scope,
      );
      expectText(
        result,
        "Codex diagnostics sent to OpenAI servers:",
        `Codex thread id: \`thread-scope-${index}\``,
      );
    }
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("sanitizes a failed upload and permits a fresh diagnostics retry", async () => {
    const threadId = "thread-123'`\n\u009b\u202e; echo bad";
    await bindThread(threadId);
    const prefix = "bad\n\u009b\u202e <@U123> [trusted](https://evil) @here ";
    const padding = "x".repeat(499 - prefix.length);
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce(probeError(`${prefix}${padding}😀tail`))
      .mockResolvedValueOnce(probeOk({ threadId }));
    const deps = createDeps({ safeCodexControlRequest });
    const request = await runCommand("diagnostics", deps);
    expect(request.text).toContain("Codex thread id: thread-123'\uff40???; echo bad");
    const token = readDiagnosticsConfirmationToken(request);
    const failure = await runCommand(`diagnostics confirm ${token}`, deps);
    expect(failure.text).toBe(
      [
        "Could not send Codex diagnostics:",
        "- channel test, OpenClaw session session-1, Codex thread thread-123'\uff40???; echo bad: bad??? &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here " +
          padding,
        "Inspect locally:",
        "- run codex resume and paste the thread id shown above",
      ].join("\n"),
    );
    const retry = await runCommand("diagnostics", deps);
    const retryToken = readDiagnosticsConfirmationToken(retry);
    const success = await runCommand(`diagnostics confirm ${retryToken}`, deps);
    expect(success.text).toBe(
      [
        "Codex diagnostics sent to OpenAI servers:",
        "Session 1",
        "Channel: test",
        "OpenClaw session id: `session-1`",
        "Codex thread id: thread-123'\uff40???; echo bad",
        "Inspect locally: run codex resume and paste the thread id shown above",
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    );
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("explains diagnostics when no Codex thread is attached", async () => {
    await expectCommand(
      [
        "No Codex thread is attached to this OpenClaw session yet.",
        "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
      ].join("\n"),
      "diagnostics",
    );
  });

  it("escapes Codex MCP and skill list entries before chat display", async () => {
    const codexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ name: "<@U123> [mcp](https://evil)" }] })
      .mockResolvedValueOnce({
        data: [skillGroup("/repo", [skillEntry("skill_1 @here", "/repo")])],
      });
    const deps = createDeps({ codexControlRequest });

    const mcp = await runCommand("mcp", deps);
    const skills = await runCommand("skills", deps);

    expect(mcp.text).toContain("&lt;\uff20U123&gt; \uff3bmcp\uff3d\uff08https://evil\uff09");
    expect(skills.text).toContain("- `skill\uff3f1 \uff20here`");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("<@U123>");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("[mcp](https://evil)");
    expect(`${mcp.text}\n${skills.text}`).not.toContain("@here");
  });

  it("scopes Codex read commands to the bound agent and auth profile", async () => {
    const agentDir = path.join(tempDir, "agents", "worker", "agent");
    const storePath = path.join(tempDir, "worker", "sessions.json");
    await upsertSessionEntry({
      agentId: "worker",
      storePath,
      sessionKey: "agent:worker:session-1",
      entry: { sessionId: "session-1", updatedAt: Date.now(), agentHarnessId: "codex" },
    });
    const getCurrentConversationBinding = async () =>
      publicConversationBinding({
        kind: "codex-app-server-session" as const,
        version: 2 as const,
        bindingId: "binding-data-1",
        workspaceDir: "/repo",
        agentDir,
        start: { id: "generation-1", authProfileId: "openai:work" },
      });
    const codexControlRequest = vi.fn(async (_pluginConfig: unknown, _method: string) => ({
      data: [],
    }));
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: {},
    }));
    const deps = createDeps({ codexControlRequest, safeCodexControlRequest });
    const context: Partial<PluginCommandContext> = {
      sessionKey: "agent:worker:session-1",
      sessionTarget: {
        agentId: "worker",
        sessionId: "session-1",
        sessionKey: "agent:worker:session-1",
        storePath,
      },
      getCurrentConversationBinding,
    };

    for (const command of ["threads", "mcp", "skills", "account"]) {
      await runCommand(command, deps, context);
    }

    const expectedScope = expect.objectContaining({
      agentDir,
      authProfileId: "openai:work",
      sessionKey: "agent:worker:session-1",
      sessionId: "session-1",
      storePath,
      assertCurrent: expect.any(Function),
    });
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      1,
      {},
      CODEX_CONTROL_METHODS.listThreads,
      { limit: 10 },
      expectedScope,
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      2,
      {},
      CODEX_CONTROL_METHODS.listMcpServers,
      { limit: 100 },
      expectedScope,
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      3,
      {},
      CODEX_CONTROL_METHODS.listSkills,
      {},
      expectedScope,
    );
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      1,
      {},
      CODEX_CONTROL_METHODS.account,
      { refreshToken: false },
      expectedScope,
    );
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      2,
      {},
      CODEX_CONTROL_METHODS.rateLimits,
      undefined,
      expectedScope,
    );
  });

  it("filters supervised thread reads and escapes native fields and resume hints", async () => {
    await writeTestBinding(sessionIdentity, supervisedTestBinding());
    const codexControlRequest = vi.fn(async () => ({
      data: [
        { id: "thread-123", title: "Fix the thing", model: "gpt-5.4", cwd: "/repo" },
        {
          id: "thread-123\n`bad`",
          title: "<@U123> [trusted](https://evil) @here",
          model: "gpt_5",
          cwd: "/repo_(x)",
        },
      ],
    }));
    const pluginConfig = { supervision: { enabled: true } };
    const result = await runCommand("threads fix", { codexControlRequest }, {}, { pluginConfig });
    expect(requestParams(codexControlRequest)).toEqual({ limit: 10, searchTerm: "fix" });
    expect(mockArg(codexControlRequest, 0, 3)).toMatchObject({
      authProfileId: null,
      startOptions: { homeScope: "user" },
    });
    expectText(
      result,
      "- thread-123 - Fix the thing (gpt-5.4, /repo)\n  Resume: /codex resume thread-123",
      "thread-123?\uff40bad\uff40",
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
      "(gpt\uff3f5, /repo\uff3f\uff08x\uff09)",
      "Resume: copy the thread id above and run /codex resume <thread-id>",
    );
    expectNoText(result, "<@U123>", "[trusted](https://evil)", "Resume: /codex resume thread-123?");
  });

  it("reads, updates, and clears goals through the bound native Codex thread", async () => {
    await bindThread("thread-goal");
    const codexControlRequest = vi.fn(
      async (_pluginConfig: unknown, method: string): Promise<JsonValue> => {
        if (method === CODEX_CONTROL_METHODS.clearThreadGoal) {
          return { cleared: true };
        }
        return goalResponse("thread-goal", "Ship native goals", 120);
      },
    );
    const deps = createDeps({ codexControlRequest });

    const steps: Array<[command: string, method: string, objective?: string]> = [
      ["goal", CODEX_CONTROL_METHODS.getThreadGoal],
      ["goal set Ship native goals", CODEX_CONTROL_METHODS.setThreadGoal, "Ship native goals"],
      ["goal clear", CODEX_CONTROL_METHODS.clearThreadGoal],
    ];
    for (const [index, [args, method, objective]] of steps.entries()) {
      await expectCommand(
        args === "goal clear"
          ? "Cleared the Codex goal."
          : "Codex goal: Ship native goals\n- Status: active\n- Tokens: 120",
        args,
        deps,
      );
      expect(codexControlRequest).toHaveBeenNthCalledWith(
        index + 1,
        {},
        method,
        { threadId: "thread-goal", ...(objective ? { objective } : {}) },
        expect.any(Object),
      );
    }
  });

  it("recovers the predecessor binding before enabling fast mode", async () => {
    const sessionKey = "agent:main:test:first-fast";
    const storePath = path.join(tempDir, "explicit", `${sessionKey}.json`);
    await seedSession(storePath, sessionKey, {
      sessionId: "session-successor",
      previousSessionId: "session-predecessor",
      agentHarnessId: "codex",
    });
    await bindThread(
      "thread-first-control",
      { model: "gpt-5.4" },
      { kind: "session", agentId: "main", sessionId: "session-predecessor", sessionKey },
    );

    await expectCommand(
      "Codex fast mode enabled.",
      "fast on",
      {},
      {
        sessionId: "session-successor",
        sessionKey,
        sessionTarget: {
          agentId: "main",
          sessionId: "session-successor",
          sessionKey,
          storePath,
        },
      },
    );
  });

  it.each(["goal", "permissions default"])(
    "rejects queued %s after host rollover",
    async (args) => {
      const runtime = await runtimeContext(tempDir, "agent:main:test:queued-control");
      if (args === "goal") {
        await bindThread(
          "thread-queued-goal",
          {},
          { ...sessionIdentity, sessionKey: runtime.sessionKey },
        );
      }
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let writes = 0;
      const beforeWrite = async (assertCurrent?: () => void) => {
        entered.resolve();
        await release.promise;
        assertCurrent?.();
        writes += 1;
      };
      const codexControlRequest = vi.fn(
        async (
          _pluginConfig: unknown,
          _method: string,
          _params: unknown,
          options?: CodexControlRequestOptions,
        ): Promise<JsonValue> => {
          await beforeWrite(options?.assertCurrent);
          return { goal: null };
        },
      );
      const setCodexConversationPermissions = vi.fn(
        async (params: { assertCurrent?: () => void }) => {
          await beforeWrite(params.assertCurrent);
          return "Codex permissions set to guarded.";
        },
      );
      const command = runCommand(
        args,
        { codexControlRequest, setCodexConversationPermissions },
        runtime,
      );
      try {
        expect(
          await Promise.race([
            entered.promise.then(() => "entered"),
            command.then(() => "settled"),
          ]),
        ).toBe("entered");
        await seedSession(runtime.sessionTarget.storePath, runtime.sessionKey, {
          sessionId: "session-next",
          previousSessionId: "session-1",
          agentHarnessId: "codex",
        });
        release.resolve();
        expect((await command).text).toMatch(
          /Codex session (generation is no longer current|execution policy changed)/,
        );
        expect(writes).toBe(0);
      } finally {
        release.resolve();
        await command;
      }
    },
  );

  it.each([false, true])(
    "renders skills and load failures (no enabled skills: %s)",
    async (empty) => {
      const malformedSkillEntries: JsonValue[] = [
        null,
        { description: "missing name" },
        skillEntry("final-skill", "/repo-b", true, "Final skill"),
      ];
      const codexControlRequest = vi.fn(async () => ({
        data: empty
          ? [
              skillGroup(
                "/repo-a",
                [skillEntry("disabled-skill", "/repo-a", false, "Disabled skill")],
                [
                  { path: "/repo-a/bad/SKILL.md", message: "bad skill <@U123>" },
                  { path: "/repo-a/other/SKILL.md", message: "other bad skill @here" },
                ],
              ),
            ]
          : [
              skillGroup(
                "/repo-a",
                Array.from({ length: 26 }, (_, index) =>
                  skillEntry(`skill-${index + 1}`, "/repo-a", true, `Skill ${index + 1}`),
                ).concat(skillEntry("disabled-skill", "/repo-a", false, "Disabled skill")),
                [{ path: "/repo-a/bad/SKILL.md", message: "bad skill" }],
              ),
              skillGroup("/repo-b", malformedSkillEntries),
              "malformed group",
            ],
      }));
      const deps = createDeps({ codexControlRequest });

      const result = await runCommand("skills", deps);

      if (empty) {
        expect(result.text).toBe("Codex skills: none returned (2 load errors).");
        expectNoText(result, "<@U123>", "@here");
      } else {
        expectText(result, "- `skill-1`", "- `skill-26`", "- `&lt;unknown&gt;`", "- `final-skill`");
        expectNoText(
          result,
          "Workspace:",
          "Error:",
          "More skills available",
          "Skill 1",
          "/repo-a/.codex/skills",
          "disabled-skill",
        );
      }
    },
  );

  it("returns sanitized command failures instead of leaking app-server errors", async () => {
    const runtime = await runtimeContext(tempDir);
    await bindThread("thread-123", {}, { ...sessionIdentity, sessionKey: runtime.sessionKey });
    const codexControlRequest = vi.fn(() => {
      throw new Error("app-server failed <@U123> [trusted](https://evil) @here");
    });
    const result = await runCommand("threads", { codexControlRequest }, runtime);
    expectText(
      result,
      "Codex command failed: app-server failed &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expectNoText(result, "<@U123>", "[trusted](https://evil)", "@here");
  });

  it("does not transfer a replacement session thread while recording bind intent", async () => {
    const identity = sessionIdentity;
    await bindThread("thread-old", {}, identity);
    const bindingRequest = captureBindingRequest();
    bindingRequest.request.mockImplementation(async () => {
      await bindThread("thread-new", {}, identity);
      return { status: "bound", binding: publicConversationBinding() };
    });

    await runCommand(
      "bind thread-target --cwd /repo",
      {},
      {
        requestConversationBinding: bindingRequest.request,
      },
    );

    expect(bindingRequest.data()).toMatchObject({
      source: {
        agentId: "main",
        sessionId: "session-1",
        threadId: "thread-old",
      },
    });
    expect(storedBinding(identity)).toMatchObject({
      threadId: "thread-new",
    });
  });

  it("preserves significant whitespace in bind --cwd through command dispatch", async () => {
    const input = " /tmp/job ";
    const { request, data } = captureBindingRequest();
    await runCommand(`bind --cwd "${input}"`, {}, { requestConversationBinding: request });
    expect(data()?.workspaceDir).toBe(input);
  });

  it("reuses the existing owner for a lazy Codex rebind", async () => {
    await bindThread(
      "thread-old",
      { cwd: "/old-repo", authProfileId: "openai:work" },
      conversationIdentity,
    );
    const { request: requestConversationBinding } = captureBindingRequest();
    const getCurrentConversationBinding = vi.fn(async () => nativeConversation("/old-repo"));

    await runCommand(
      "bind thread-456 --cwd /repo",
      { resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default") },
      {
        getCurrentConversationBinding,
        requestConversationBinding,
      },
    );

    expect(storedBinding(conversationIdentity)).toMatchObject({ threadId: "thread-old" });
    expect(requestConversationBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bindingId: "binding-data-1",
          start: expect.objectContaining({
            id: expect.any(String),
            threadId: "thread-456",
            authProfileId: "openai:work",
          }),
        }),
      }),
    );
  });

  it.each(["pending", "error"] as const)(
    "preserves binding ownership when bind is %s",
    async (status) => {
      await bindThread("thread-before-approval");
      const reply = { text: "Approve this?" };
      const mutate = vi.fn(async () => true);
      const requestConversationBinding = vi.fn<PluginCommandContext["requestConversationBinding"]>(
        async () =>
          status === "pending"
            ? {
                status: "pending",
                approvalId: "approval-1",
                reply,
              }
            : {
                status: "error",
                message: "binding unsupported <@U123> [trusted](https://evil)",
              },
      );
      await expect(
        runCommand(
          "bind",
          {
            bindingStore: { ...testCodexAppServerBindingStore, mutate },
            resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
          },
          { requestConversationBinding },
        ),
      ).resolves.toEqual(
        status === "pending"
          ? reply
          : {
              text: "binding unsupported &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
            },
      );
      const bindingId = requestConversationBinding.mock.calls[0]?.[0]?.data?.bindingId;
      expect(
        storedBinding({
          kind: "conversation",
          bindingId: typeof bindingId === "string" ? bindingId : "missing",
        }),
      ).toBeUndefined();
      expect(storedBinding()).toMatchObject({
        threadId: "thread-before-approval",
      });
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it("stops the active bound Codex turn in sandboxed sessions", async () => {
    const stopCodexConversationTurn = vi.fn(async () => ({
      stopped: true,
      message: "Codex stop requested.",
    }));

    await expectCommand(
      "Codex stop requested.",
      "stop",
      { stopCodexConversationTurn },
      sandboxContext(),
    );
    expect(stopCodexConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: { ...sessionIdentity, sessionKey: "sandboxed-session" },
      }),
    );
  });

  it("uses the admitted explicit store for model and permission reads and writes", async () => {
    const sessionKey = "agent:main:test:explicit-control-store";
    const { storePath, configuredStorePath, context } = explicitStoreContext(sessionKey);
    for (const [targetStore, model, permissionMode] of [
      [storePath, "model_<@U123>_[trusted](https://evil)", "full"],
      [configuredStorePath, "configured-model", "guarded"],
    ] as const) {
      await seedSession(targetStore, sessionKey, {
        model,
        permissionMode,
        agentHarnessId: "codex",
      });
    }
    await bindThread(
      "thread-explicit-store",
      { model: "native-model" },
      { ...sessionIdentity, sessionKey },
    );

    const modelStatus = await runCommand("model", {}, context);
    const permissionStatus = await runCommand("permissions status", {}, context);
    await runCommand("model gpt-5.5", {}, context);
    await runCommand("permissions default", {}, context);

    expect(modelStatus.text).toBe(
      "Codex model: model\uff3f&lt;\uff20U123&gt;\uff3f\uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(permissionStatus.text).toBe("Codex permissions: full access.");
    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      modelOverride: "gpt-5.5",
      permissionMode: "guarded",
    });
    const configuredEntry = getSessionEntry({ storePath: configuredStorePath, sessionKey });
    expect(configuredEntry).toMatchObject({
      model: "configured-model",
      permissionMode: "guarded",
    });
    expect(configuredEntry?.modelOverride).toBeUndefined();
  });

  it("updates a bound conversation without changing its ambient outer session", async () => {
    const sessionKey = "agent:main:session-1";
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await seedSession(
      storePath,
      sessionKey,
      {
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        agentRuntimeOverride: "claude-cli",
        authProfileOverride: "anthropic:personal",
        authProfileOverrideSource: "user",
      },
      "main",
    );
    await bindThread(
      "thread-conversation",
      { model: "gpt-5.4", modelProvider: "openai" },
      conversationIdentity,
    );
    const getCurrentConversationBinding = async () => nativeConversation("/repo");

    await expectCommand(
      "Codex model set to gpt-5.5.",
      "model gpt-5.5",
      {},
      {
        sessionKey,
        getCurrentConversationBinding,
      },
    );

    expect(storedBinding(conversationIdentity)).toMatchObject({
      threadId: "thread-conversation",
      model: "gpt-5.5",
      modelProvider: "openai",
    });
    expect(getSessionEntry({ storePath, sessionKey })).toMatchObject({
      providerOverride: "anthropic",
      modelOverride: "claude-sonnet-4-6",
      agentRuntimeOverride: "claude-cli",
      authProfileOverride: "anthropic:personal",
      authProfileOverrideSource: "user",
    });
  });

  it.each([false, true])(
    "requires admin authority for full permissions (admin: %s)",
    async (admin) => {
      const sessionKey = "agent:main:test:permissions-yolo";
      const storePath = path.join(tempDir, "permission-sessions.json");
      await seedSession(storePath, sessionKey, { sessionRoot: tempDir });

      const before = getSessionEntry({ sessionKey, storePath, readConsistency: "latest" });
      await expectCommand(
        admin
          ? "Codex permissions set to full access."
          : "Full Codex permissions require operator.admin. Choose Admin in the Control UI permission picker, or use an admin-authenticated CLI.",
        "permissions yolo",
        {},
        {
          config: { session: { store: storePath } },
          sessionKey,
          senderIsOwner: !admin,
          gatewayClientScopes: [admin ? "operator.admin" : "operator.write"],
        },
      );
      const after = getSessionEntry({ sessionKey, storePath, readConsistency: "latest" });
      expect(after?.permissionMode).toBe(admin ? "full" : undefined);
      expect(after?.sessionRoot).toBe(tempDir);
      if (!admin) {
        expect(after).toEqual(before);
      }
    },
  );

  it("rejects model and binding replacement under the admitted store lock", async () => {
    const locked = await createLockedSessionContextOverrides();
    const sessionTarget = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: locked.sessionKey,
      storePath: locked.config.session!.store!,
    };
    locked.config = { session: { store: path.join(tempDir, "unrelated", "sessions.json") } };
    const requestConversationBinding = vi.fn<PluginCommandContext["requestConversationBinding"]>();
    const detachConversationBinding = vi.fn<PluginCommandContext["detachConversationBinding"]>();
    const getCurrentConversationBinding =
      vi.fn<PluginCommandContext["getCurrentConversationBinding"]>();
    const setCodexConversationModel = vi.fn();
    const codexControlRequest = vi.fn();
    const resolveCodexCliSessionForBindingOnNode = vi.fn();
    const deps = createDeps({
      codexControlRequest,
      resolveCodexCliSessionForBindingOnNode,
      setCodexConversationModel,
    });

    for (const args of [
      "model gpt-5.4",
      "bind thread-other",
      "resume thread-other",
      "resume cli-other --host node-1 --bind here",
      "detach",
      "unbind",
    ]) {
      await expectCommand(MODEL_SELECTION_LOCKED_MESSAGE, args, deps, {
        ...locked,
        sessionTarget,
        detachConversationBinding,
        getCurrentConversationBinding,
        requestConversationBinding,
      });
    }

    expect(setCodexConversationModel).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();
    expect(requestConversationBinding).not.toHaveBeenCalled();
    expect(detachConversationBinding).not.toHaveBeenCalled();
    expect(getCurrentConversationBinding).not.toHaveBeenCalled();
  });

  it("rejects bind and resume replacement from private supervision state without a public lock", async () => {
    await writeTestBinding(sessionIdentity, supervisedTestBinding("thread-private-owner"));
    const requestConversationBinding = vi.fn<PluginCommandContext["requestConversationBinding"]>();
    const codexControlRequest = vi.fn();
    const resolveCodexCliSessionForBindingOnNode = vi.fn();
    const deps = createDeps({ codexControlRequest, resolveCodexCliSessionForBindingOnNode });

    for (const args of [
      "bind thread-other",
      "resume thread-other",
      "resume cli-other --host node-1 --bind here",
    ]) {
      const result = await runCommand(
        args,
        deps,
        { requestConversationBinding },
        { pluginConfig: { supervision: { enabled: true } } },
      );
      expectResultText(result, "Refusing to replace supervised Codex thread");
    }

    expect(requestConversationBinding).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "keeps conversation model status independent from its ambient session (ambient: %s)",
    async (hasSession) => {
      const sessionKey = "agent:main:conversation-model";
      if (hasSession) {
        await seedSession(
          resolveStorePath(undefined, { agentId: "main" }),
          sessionKey,
          { modelOverride: "outer-override-model" },
          "main",
        );
      }
      await writeTestBinding(conversationIdentity, {
        threadId: "thread-conversation",
        cwd: "/repo",
        ...(hasSession ? {} : { model: "bound-model" }),
      });

      const result = await runCommand(
        "model",
        {},
        {
          sessionId: hasSession ? "session-1" : undefined,
          sessionKey: hasSession ? sessionKey : undefined,
          getCurrentConversationBinding: async () => nativeConversation(tempDir),
        },
      );

      expect(result).toEqual({
        text: hasSession ? "Usage: /codex model <model>" : "Codex model: bound-model",
      });
    },
  );

  it.each([true, false])(
    "renders and escapes binding fields from their owners (active: %s)",
    async (active) => {
      const sessionKey = "agent:main:binding-preferences";
      const { storePath, configuredStorePath, context } = explicitStoreContext(sessionKey);
      if (active) {
        await seedSession(storePath, sessionKey, { permissionMode: "full" });
        await seedSession(configuredStorePath, sessionKey, { permissionMode: "guarded" });
      }
      const threadId = "thread-123 <@U123>";
      await writeTestBinding(conversationIdentity, {
        threadId,
        cwd: "/repo",
        model: "gpt [trusted](https://evil)",
        ...(active
          ? {
              serviceTier: "fast",
              approvalPolicy: "never" as const,
              sandbox: "danger-full-access" as const,
            }
          : {}),
      });

      const result = await runCommand(
        "binding",
        {
          readCodexConversationActiveTurn: vi.fn(() =>
            active
              ? {
                  identity: conversationIdentity,
                  client: { request: vi.fn() } as never,
                  requestTimeoutMs: 60_000,
                  threadId,
                  turnId: "turn-1",
                  interrupt: vi.fn(),
                  steer: vi.fn(),
                }
              : undefined,
          ),
        },
        {
          ...(active ? context : {}),
          getCurrentConversationBinding: async () => nativeConversation("/repo <@U123>"),
        },
      );
      expect(result).toEqual({
        text: [
          "Codex conversation binding:",
          "- Thread: thread-123 &lt;\uff20U123&gt;",
          "- Workspace: /repo &lt;\uff20U123&gt;",
          "- Model: gpt \uff3btrusted\uff3d\uff08https://evil\uff09",
          `- Fast: ${active ? "on" : "off"}`,
          `- Permissions: ${active ? "full access" : "default"}`,
          `- Active run: ${active ? "turn-1" : "none"}`,
          "- Binding: binding-data-1",
        ].join("\n"),
      });
    },
  );
});

function computerUseReadyStatus(): CodexComputerUseStatus {
  return {
    enabled: true,
    ready: true,
    reason: "ready",
    installed: true,
    pluginEnabled: true,
    mcpServerAvailable: true,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
    marketplaceName: "desktop-tools",
    tools: ["list_apps"],
    installation: "installed",
    exposure: "available",
    liveTest: {
      status: "passed",
      ok: true,
      attempted: true,
      attempts: 1,
      timeoutMs: 60_000,
      retried: false,
      repaired: false,
      message: "Computer Use live test passed.",
    },
    warnings: [],
    message: "Computer Use is ready.",
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
