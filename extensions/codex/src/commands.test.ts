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
import { describe, expect, it, vi } from "vitest";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import {
  consumeCodexAppServerLiveThread,
  ensureCodexAppServerClientRuntime,
  isCodexAppServerLiveThreadClaimed,
  retainCodexAppServerLiveThread,
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
import { withCodexAppServerThreadMutation } from "./app-server/thread-ownership.js";
import { handleCodexCommand as dispatchCodexCommand } from "./command-dispatch.js";
import type { CodexPluginsConfigBlock, CodexPluginsManagementIO } from "./command-plugin-config.js";
import type { CodexControlRequestOptions, SafeCodexControlRequestFn } from "./command-rpc.js";
import {
  createContext,
  createCodexRuntimeContextOverrides,
  createDeps,
  createThreadResumeResponse,
  expectedDiagnosticsTargetBlock,
  expectResultTextContains,
  mockArg,
  readDiagnosticsConfirmationToken,
  requestParams,
  requireResultText,
  runCommand,
  supervisedTestBinding,
  useCodexCommandTestState,
  writeTestBinding,
} from "./commands.test-support.js";

type CodexPluginConfigEntry = NonNullable<CodexPluginsConfigBlock["plugins"]>[string];

const sessionIdentity = { kind: "session", agentId: "main", sessionId: "session-1" } as const;

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

function oauthProfile(email: string, now: number) {
  return {
    type: "oauth" as const,
    provider: "openai",
    access: "access-token",
    refresh: "refresh-token",
    expires: now + 60 * 60 * 1000,
    email,
  };
}

let tempDir: string;
const resumeClients: CodexAppServerClient[] = [];

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

const handleCodexCommand = dispatchCodexCommand;

function createResumeControlRequest(
  response:
    | ReturnType<typeof createThreadResumeResponse>
    | (() => Promise<ReturnType<typeof createThreadResumeResponse>>),
  options: { client?: CodexAppServerClient; authProfileId?: string } = {},
) {
  const { client: suppliedClient, ...auth } = options;
  const client = suppliedClient ?? createClientHarness().client;
  if (!suppliedClient) {
    resumeClients.push(client);
    ensureCodexAppServerClientRuntime(client, { agentDir: tempDir });
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
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: {
      sessionId: "session-1",
      updatedAt: Date.now(),
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    },
  });
  return {
    config: { session: { store: storePath } },
    sessionKey,
  };
}

function inMemoryCodexPluginsIO(
  initial: Record<string, CodexPluginConfigEntry> = {},
  options: { enabled?: boolean } = { enabled: true },
): CodexPluginsManagementIO & {
  current: () => Record<string, CodexPluginConfigEntry>;
  currentConfig: () => CodexPluginsConfigBlock;
} {
  const store: CodexPluginsConfigBlock = {
    enabled: options.enabled,
    plugins: structuredClone(initial),
  };
  return {
    current: () => structuredClone(store.plugins ?? {}),
    currentConfig: () => structuredClone(store),
    readConfig: () => Promise.resolve(structuredClone(store)),
    mutate: async (update, assertCurrent) => {
      assertCurrent?.();
      update(store);
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

  it("renders the top-level Codex menu as portable native slash commands", async () => {
    const result = await runCommand("");

    expectResultTextContains(result, "/codex plugins menu");
    expect(buttonCommands(result)).toEqual([
      "/codex plugins menu",
      "/codex permissions menu",
      "/codex fast menu",
      "/codex computer-use menu",
      "/codex account",
      "/codex plugins refresh",
      "/codex help",
    ]);
  });

  it("routes /codex plugins menu to the Codex-owned plugin picker", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO();

    const result = await runCommand("plugins menu", { codexPluginsManagementIo });

    expectResultTextContains(result, "/codex plugins enable");
    expect(buttonCommands(result)).toContain("/codex plugins list");
    expect(buttonCommands(result)).toContain("/codex plugins refresh");
    expectResultTextContains(result, "/codex plugins refresh");
  });

  it("lists Codex sub-plugins through the /codex plugins command surface", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const result = await runCommand("plugins list", { codexPluginsManagementIo });

    expectResultTextContains(result, "ON   google-calendar");
    expectResultTextContains(result, "openclaw.json");
  });

  it("routes owner-only plugin discovery through the native command boundary with its workspace", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO({}, { enabled: false });
    const sessionKey = "agent:main:plugin-discovery";
    const storePath = path.join(tempDir, "plugin-discovery-sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "session-1", updatedAt: Date.now(), agentHarnessId: "codex" },
    });
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

    expectResultTextContains(result, "security-review@company-tools");
    expect(resolvePluginConfig).toHaveBeenCalledOnce();
    expect(codexControlRequest).toHaveBeenCalledWith(
      { appServer: { defaultWorkspaceDir: "/company" } },
      "plugin/list",
      { cwds: ["/company"] },
      expect.objectContaining({
        config: {},
        sessionId: "session-1",
        sessionKey,
        storePath,
        assertCurrent: expect.any(Function),
      }),
    );

    codexControlRequest.mockClear();
    const denied = await runCommand(
      "plugins available",
      { codexPluginsManagementIo, codexControlRequest },
      { senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
    );
    expectResultTextContains(denied, "Only an owner or operator.admin");
    expect(codexControlRequest).not.toHaveBeenCalled();
  });

  it("keeps host-wide account inspection owner-only", async () => {
    const args = "account";

    const codexControlRequest = vi.fn();
    const safeCodexControlRequest = vi.fn();
    const readCodexStatusProbes = vi.fn();
    const listCodexCliSessionsOnNode = vi.fn();

    const result = await runCommand(
      args,
      {
        codexControlRequest,
        safeCodexControlRequest,
        readCodexStatusProbes,
        listCodexCliSessionsOnNode,
      },
      { senderIsOwner: false, gatewayClientScopes: ["operator.write"] },
    );

    expectResultTextContains(result, "Only an owner or operator.admin");
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
    expect(readCodexStatusProbes).not.toHaveBeenCalled();
    expect(listCodexCliSessionsOnNode).not.toHaveBeenCalled();
  });

  it("allows operator.admin to inspect host-wide Codex account state", async () => {
    const safeCodexControlRequest = vi.fn(async () => ({ ok: true as const, value: {} }));

    const result = await runCommand(
      "account",
      { safeCodexControlRequest },
      { senderIsOwner: false, gatewayClientScopes: ["operator.admin"] },
    );

    expectResultTextContains(result, "Account: available");
    expect(safeCodexControlRequest).toHaveBeenCalled();
  });

  it("preserves model inspection for authorized non-owners", async () => {
    const args = "models";

    const result = await runCommand(
      args,
      { listCodexAppServerModels: vi.fn(async () => ({ models: [] })) },
      {
        senderIsOwner: false,
        gatewayClientScopes: ["operator.write"],
        assertOwnerCurrent: () => {
          throw new Error("Caller is not a channel owner");
        },
      },
    );

    expect(result.text).not.toContain("Only an owner or operator.admin");
    expect(result.text).not.toContain("Codex command failed");
  });

  it("never sends a paired-node workspace to the gateway Codex app-server", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO({}, { enabled: false });
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
      "plugin/list",
      { cwds: ["/gateway/workspace"] },
      expect.anything(),
    );
    expect(codexControlRequest).not.toHaveBeenCalledWith(
      expect.anything(),
      "plugin/list",
      expect.objectContaining({ cwds: ["/remote/node/private-workspace"] }),
      expect.anything(),
    );
  });

  it("enables and disables Codex sub-plugins through the /codex plugins command surface", async () => {
    const codexPluginsManagementIo = inMemoryCodexPluginsIO({
      "google-calendar": {
        enabled: true,
        marketplaceName: "openai-curated",
        pluginName: "google-calendar",
      },
    });

    const disabled = await runCommand("plugins disable google-calendar", {
      codexPluginsManagementIo,
    });
    expectResultTextContains(disabled, "google-calendar: disabled in openclaw.json");
    expect(codexPluginsManagementIo.current()["google-calendar"]?.enabled).toBe(false);

    const enabled = await runCommand("plugins enable google-calendar", {
      codexPluginsManagementIo,
    });
    expectResultTextContains(enabled, "google-calendar: enabled in openclaw.json");
    expect(codexPluginsManagementIo.currentConfig().enabled).toBe(true);
    expect(codexPluginsManagementIo.current()["google-calendar"]?.enabled).toBe(true);
  });

  it.each([
    { knownBeforeResume: true, sameOwner: false },
    { knownBeforeResume: false, sameOwner: false },
    { knownBeforeResume: false, sameOwner: true },
  ])(
    "rejects a parent-owned child without displacing the current owner (preflight: $knownBeforeResume, same owner: $sameOwner)",
    async ({ knownBeforeResume, sameOwner }) => {
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
      const threadId = "thread-parent-owned";
      const existingThreadId = sameOwner ? threadId : "thread-existing";
      const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
      const release = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(harness.client, existingThreadId, release);
      await writeTestBinding(identity, {
        threadId: existingThreadId,
        clientId: harness.client.getInstanceId(),
        cwd: "/repo",
      });
      const before = testCodexAppServerBindingStore.read(identity);
      const response = createThreadResumeResponse({ threadId, canAcceptDirectInput: false });
      const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
        if (method === "thread/read") {
          return {
            thread: { ...response.thread, canAcceptDirectInput: knownBeforeResume ? false : null },
          } as never;
        }
        if (method === "thread/resume") {
          return response as never;
        }
        if (method === "thread/unsubscribe") {
          return {} as never;
        }
        throw new Error(`unexpected Codex method ${method}`);
      });
      const sharedClientRuntime = await import("./app-server/shared-client.js");
      const retainClient = vi
        .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
        .mockResolvedValue({ client: harness.client, release: vi.fn() });
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
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
        expect(release).not.toHaveBeenCalled();
        const mutations = request.mock.calls
          .map(([method]) => method)
          .filter((method) => method !== "thread/read");
        expect(mutations).toEqual(
          knownBeforeResume
            ? []
            : sameOwner
              ? ["thread/resume"]
              : ["thread/resume", "thread/unsubscribe"],
        );
        await expect(
          consumeCodexAppServerLiveThread(harness.client, existingThreadId),
        ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
      } finally {
        retainClient.mockRestore();
        harness.client.close();
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
      const context = await createCodexRuntimeContextOverrides(
        tempDir,
        "agent:main:test:same-client-resume",
      );
      const { codexControlRequest } = await import("./command-rpc.js");
      const sharedClientRuntime = await import("./app-server/shared-client.js");
      const harness = createClientHarness();
      ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
      const threadId = "thread-same-client-resume";
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-1",
        sessionKey: context.sessionKey,
      };
      const release = vi.fn(async () => undefined);
      if (retainedBeforeResume) {
        await retainCodexAppServerLiveThread(harness.client, threadId, release);
      }
      const releaseSibling = vi.fn(async () => undefined);
      await retainCodexAppServerLiveThread(harness.client, "thread-sibling", releaseSibling);
      await writeTestBinding(identity, {
        threadId,
        clientId: harness.client.getInstanceId(),
        cwd: "/repo",
      });
      const before = testCodexAppServerBindingStore.read(identity);
      const acquireClient = vi
        .spyOn(sharedClientRuntime, "getLeasedSharedCodexAppServerClient")
        .mockResolvedValue(harness.client);
      const releaseLease = vi.spyOn(sharedClientRuntime, "releaseLeasedSharedCodexAppServerClient");
      const response = createThreadResumeResponse({ threadId, canAcceptDirectInput: true });
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
              read: (bindingIdentity) => {
                if (resumeAccepted) {
                  if (failure === "read") {
                    throw new Error("Invalid Codex app-server binding row");
                  }
                  elapsedClock.mockReturnValue(1_001);
                }
                return testCodexAppServerBindingStore.read(bindingIdentity);
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
        expect(testCodexAppServerBindingStore.read(identity)).toEqual(before);
        await expect(consumeCodexAppServerLiveThread(harness.client, threadId)).resolves.toEqual(
          keepsExistingOwner
            ? expect.objectContaining({ release: expect.any(Function) })
            : undefined,
        );
        await expect(
          consumeCodexAppServerLiveThread(harness.client, "thread-sibling"),
        ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
      } finally {
        releaseLease.mockRestore();
        acquireClient.mockRestore();
        harness.client.close();
        elapsedClock.mockRestore();
      }
    },
  );

  it("unsubscribes a manually resumed thread when its idle owner cannot be published", async () => {
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const request = vi.spyOn(harness.client, "request").mockResolvedValue({} as never);
    const oldestRelease = vi.fn(async () => {
      throw new Error("oldest thread could not be unsubscribed");
    });
    await retainCodexAppServerLiveThread(harness.client, "thread-oldest", oldestRelease);
    for (let index = 1; index < 63; index += 1) {
      await retainCodexAppServerLiveThread(harness.client, `thread-idle-${index}`);
    }
    await retainCodexAppServerLiveThread(harness.client, "thread-existing");
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
    };
    await writeTestBinding(identity, {
      threadId: "thread-existing",
      clientId: harness.client.getInstanceId(),
      cwd: "/repo",
    });
    const response = createThreadResumeResponse({ threadId: "thread-overflow" });
    const codexControlRequest = createResumeControlRequest(response, { client: harness.client });

    try {
      const result = await runCommand("resume thread-overflow", { codexControlRequest });

      expect(result.text).toContain("lost its native subscription owner");
      expect(oldestRelease).toHaveBeenCalledOnce();
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "thread/unsubscribe",
        { threadId: "thread-overflow" },
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        threadId: "thread-existing",
      });
      await expect(
        consumeCodexAppServerLiveThread(harness.client, "thread-existing"),
      ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
    } finally {
      harness.client.close();
    }
  });

  it.each([false, true])(
    "migrates manual resume ownership across physical clients (old release fails: %s)",
    async (rejectOldRelease) => {
      const previous = createClientHarness();
      const replacement = createClientHarness();
      ensureCodexAppServerClientRuntime(previous.client, { agentDir: tempDir });
      ensureCodexAppServerClientRuntime(replacement.client, { agentDir: tempDir });
      const identity = {
        kind: "session" as const,
        agentId: "main",
        sessionId: "session-1",
      };
      await writeTestBinding(identity, {
        threadId: "thread-manual-migration",
        clientId: previous.client.getInstanceId(),
        cwd: "/repo",
      });
      const operations: string[] = [];
      const ownerDuringRelease: Array<string | undefined> = [];
      vi.spyOn(previous.client, "request").mockImplementation(async (method) => {
        operations.push(`previous:${method}`);
        ownerDuringRelease.push(testCodexAppServerBindingStore.read(identity)?.clientId);
        if (rejectOldRelease) {
          throw new Error("previous manual owner unsubscribe failed");
        }
        return {} as never;
      });
      vi.spyOn(replacement.client, "request").mockImplementation(async (method) => {
        operations.push(`replacement:${method}`);
        return {} as never;
      });
      await expect(
        retainCodexAppServerLiveThread(previous.client, "thread-manual-migration"),
      ).resolves.toBe(true);
      const sharedClientRuntime = await import("./app-server/shared-client.js");
      const retainPreviousClient = vi
        .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
        .mockImplementation(async (clientId) =>
          clientId === previous.client.getInstanceId()
            ? { client: previous.client, release: vi.fn() }
            : undefined,
        );
      const response = createThreadResumeResponse({ threadId: "thread-manual-migration" });
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
        expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
          threadId: "thread-manual-migration",
          clientId: rejectOldRelease
            ? previous.client.getInstanceId()
            : replacement.client.getInstanceId(),
        });
        const survivingClient = rejectOldRelease ? previous.client : replacement.client;
        const obsoleteClient = rejectOldRelease ? replacement.client : previous.client;
        await expect(
          consumeCodexAppServerLiveThread(survivingClient, "thread-manual-migration"),
        ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
        await expect(
          consumeCodexAppServerLiveThread(obsoleteClient, "thread-manual-migration"),
        ).resolves.toBeUndefined();
      } finally {
        retainPreviousClient.mockRestore();
        previous.client.close();
        replacement.client.close();
      }
    },
  );

  it("preserves known native config ownership when manually resuming the same thread", async () => {
    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
    };
    await writeTestBinding(identity, {
      threadId: "thread-known-resume",
      clientId: harness.client.getInstanceId(),
      cwd: "/repo",
      authProfileId: "openai:previous",
      dynamicToolsFingerprint: "known-dynamic-tools",
      webSearchThreadConfigFingerprint: "known-web-search",
      pluginAppsFingerprint: "known-plugin-apps",
    });
    const release = vi.fn(async () => undefined);
    await retainCodexAppServerLiveThread(
      harness.client,
      "thread-known-resume",
      release,
      "known-native-config",
      "priority",
    );
    const response = createThreadResumeResponse({ threadId: "thread-known-resume" });
    const codexControlRequest = createResumeControlRequest(response, { client: harness.client });

    try {
      await expect(
        runCommand("resume thread-known-resume", { codexControlRequest }),
      ).resolves.toMatchObject({
        text: "Attached this OpenClaw session to Codex thread thread-known-resume.",
      });
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        dynamicToolsFingerprint: "known-dynamic-tools",
        pluginAppsFingerprint: "known-plugin-apps",
      });
      expect(testCodexAppServerBindingStore.read(identity)?.authProfileId).toBeUndefined();
      await expect(
        consumeCodexAppServerLiveThread(
          harness.client,
          "thread-known-resume",
          "known-native-config",
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          configFingerprint: "known-native-config",
          serviceTier: "priority",
        }),
      );
      expect(release).not.toHaveBeenCalled();
    } finally {
      harness.client.close();
    }
  });

  it("refuses an active native child while preserving another thread owner", async () => {
    const existingThreadId = "thread-existing-resume";

    const harness = createClientHarness();
    ensureCodexAppServerClientRuntime(harness.client, { agentDir: tempDir });
    const response = createThreadResumeResponse({ threadId: "thread-active-resume" });
    const request = vi.spyOn(harness.client, "request").mockImplementation(async (method) => {
      if (method === "thread/resume") {
        return response as never;
      }
      if (method === "thread/unsubscribe") {
        return {} as never;
      }
      throw new Error(`unexpected Codex method ${method}`);
    });
    const parent = await codexNativeSubagentMonitorRuntime.register({
      client: harness.client,
      parentThreadId: "thread-parent",
    });
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
    };
    await writeTestBinding(identity, {
      threadId: existingThreadId,
      clientId: harness.client.getInstanceId(),
      cwd: "/repo",
    });
    await retainCodexAppServerLiveThread(harness.client, existingThreadId);
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
        expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-active-resume")).toBe(
          true,
        ),
      );
      const result = await runCommand("resume thread-active-resume", { codexControlRequest });

      expect(result.text).toContain("lost its native subscription owner");
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/resume"]);
      expect(isCodexAppServerLiveThreadClaimed(harness.client, "thread-active-resume")).toBe(true);
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        threadId: existingThreadId,
      });
      await expect(
        retainCodexAppServerLiveThread(harness.client, "thread-active-resume"),
      ).resolves.toBe(false);
      const previousOwnership = await consumeCodexAppServerLiveThread(
        harness.client,
        existingThreadId,
      );
      expect(previousOwnership).toEqual(expect.objectContaining({ release: expect.any(Function) }));
      await expect(
        retainCodexAppServerLiveThread(
          harness.client,
          existingThreadId,
          previousOwnership?.release,
        ),
      ).resolves.toBe(true);
    } finally {
      await parent.unregister();
      harness.client.close();
    }
  });

  it("serializes manual resume with other session binding owners", async () => {
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
    };
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
    const resumeResponse = createDeferred<ReturnType<typeof createThreadResumeResponse>>();
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
      resumeResponse.resolve(createThreadResumeResponse({ threadId: "thread-123" }));
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
      resumeResponse.resolve(createThreadResumeResponse({ threadId: "thread-123" }));
      await Promise.allSettled([command, competingOwner]);
    }
  });

  it("rejects manual resume of a thread owned by another OpenClaw session", async () => {
    const otherIdentity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-other",
    };
    await writeTestBinding(otherIdentity, { threadId: "thread-owned", cwd: "/other" });
    const codexControlRequest = vi.fn(async () =>
      createThreadResumeResponse({ threadId: "thread-owned" }),
    );

    const result = await runCommand("resume thread-owned", { codexControlRequest });

    expect(result.text).toContain("owned by another OpenClaw session");
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(testCodexAppServerBindingStore.read(otherIdentity)).toMatchObject({
      threadId: "thread-owned",
    });
  });

  it("reclaims an unloaded plugin's stale generation before attaching a thread", async () => {
    const sessionKey = "agent:main:test:chat-1";
    const storePath = path.join(tempDir, "sessions.json");
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-old",
        sessionKey,
      },
      { threadId: "thread-old", cwd: "/old" },
    );
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "session-new", updatedAt: Date.now() },
    });
    const codexControlRequest = createResumeControlRequest(
      createThreadResumeResponse({ threadId: "thread-new" }),
    );

    const result = await runCommand(
      "resume thread-new",
      { codexControlRequest },
      {
        sessionId: "session-new",
        sessionKey,
        config: { session: { store: storePath } },
      },
    );

    expect(result.text).toBe(
      "Attached this OpenClaw session to Codex thread thread-new. The next turn will validate its tools and apply this session's configuration before continuing.",
    );
    expect(codexControlRequest).toHaveBeenCalledTimes(1);
    expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-new",
        sessionKey,
      }),
    ).toMatchObject({ threadId: "thread-new" });
  });

  it("resumes a replacement after adopting the explicit-store predecessor binding", async () => {
    const threadId = "thread-resumed";

    const sessionKey = "agent:main:test:explicit-resume";
    const storePath = path.join(tempDir, "explicit", "sessions.json");
    const configuredStorePath = path.join(tempDir, "configured", "sessions.json");
    const identity = { kind: "session" as const, agentId: "main", sessionKey };
    await writeTestBinding(
      { ...identity, sessionId: "session-old" },
      {
        threadId: "thread-existing",
        cwd: "/repo",
        dynamicToolsFingerprint: "existing-tools",
        webSearchThreadConfigFingerprint: "existing-web-search",
      },
    );
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "session-new",
        previousSessionId: "session-old",
        updatedAt: Date.now(),
      },
    });
    await upsertSessionEntry({
      storePath: configuredStorePath,
      sessionKey,
      entry: { sessionId: "unrelated-session", updatedAt: Date.now() },
    });
    const codexControlRequest = createResumeControlRequest(async () => {
      expect(
        testCodexAppServerBindingStore.read({ ...identity, sessionId: "session-new" }),
      ).toMatchObject({ threadId: "thread-existing", dynamicToolsFingerprint: "existing-tools" });
      return createThreadResumeResponse({ threadId });
    });

    const result = await runCommand(
      `resume ${threadId}`,
      { codexControlRequest },
      {
        sessionId: "session-new",
        sessionKey,
        config: { session: { store: configuredStorePath } },
        sessionTarget: { agentId: "main", sessionId: "session-new", sessionKey, storePath },
      },
    );

    expect(result.text).toBe(
      `Attached this OpenClaw session to Codex thread ${threadId}. The next turn will validate its tools and apply this session's configuration before continuing.`,
    );
    expect(codexControlRequest).toHaveBeenCalledTimes(1);
    expect(codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.resumeThread,
      expect.anything(),
      expect.objectContaining({ storePath }),
    );
    expect(
      testCodexAppServerBindingStore.read({ ...identity, sessionId: "session-new" }),
    ).toMatchObject({
      threadId,
    });
  });

  it("rejects host rollover while resume waits for the native queue", async () => {
    const context = await createCodexRuntimeContextOverrides(tempDir);
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionKey: context.sessionKey,
    };
    await upsertSessionEntry({
      storePath: context.sessionTarget.storePath,
      sessionKey: context.sessionKey,
      entry: { sessionId: "session-1", previousSessionId: "session-old", updatedAt: Date.now() },
    });
    await writeTestBinding(
      { ...identity, sessionId: "session-old" },
      { threadId: "thread-existing", cwd: "/repo" },
    );
    let releaseQueue!: () => void;
    const queueBlocked = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const queue = withCodexAppServerThreadMutation("thread-resumed", () => queueBlocked);
    const codexControlRequest = createResumeControlRequest(
      createThreadResumeResponse({ threadId: "thread-resumed" }),
    );
    const command = runCommand("resume thread-resumed", { codexControlRequest }, context);
    try {
      await vi.waitFor(() =>
        expect(
          testCodexAppServerBindingStore.read({ ...identity, sessionId: "session-1" }),
        ).toMatchObject({ threadId: "thread-existing" }),
      );
      await upsertSessionEntry({
        storePath: context.sessionTarget.storePath,
        sessionKey: context.sessionKey,
        entry: { sessionId: "session-2", previousSessionId: "session-1", updatedAt: Date.now() },
      });
    } finally {
      releaseQueue();
      await Promise.allSettled([queue, command]);
    }
    expect((await command).text).toContain("Codex session generation is no longer current");
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(
      testCodexAppServerBindingStore.read({
        ...identity,
        sessionId: "session-1",
      }),
    ).toMatchObject({ threadId: "thread-existing" });
  });

  it("rejects resumed-thread publication when the verified host generation changes during RPC", async () => {
    const context = await createCodexRuntimeContextOverrides(tempDir);
    const identity = { kind: "session" as const, agentId: "main", sessionKey: context.sessionKey };
    await upsertSessionEntry({
      storePath: context.sessionTarget.storePath,
      sessionKey: context.sessionKey,
      entry: { sessionId: "session-1", previousSessionId: "session-old", updatedAt: Date.now() },
    });
    await writeTestBinding(
      { ...identity, sessionId: "session-old" },
      { threadId: "thread-existing", cwd: "/repo" },
    );
    const codexControlRequest = createResumeControlRequest(async () => {
      await upsertSessionEntry({
        storePath: context.sessionTarget.storePath,
        sessionKey: context.sessionKey,
        entry: { sessionId: "session-2", previousSessionId: "session-1", updatedAt: Date.now() },
      });
      return createThreadResumeResponse({ threadId: "thread-resumed" });
    });

    const result = await runCommand("resume thread-resumed", { codexControlRequest }, context);

    expect(result.text).toContain("Codex session generation is no longer current");
    expect(codexControlRequest).toHaveBeenCalledOnce();
    expect(
      testCodexAppServerBindingStore.read({ ...identity, sessionId: "session-1" }),
    ).toMatchObject({ threadId: "thread-existing" });
  });

  it("rolls back replacement ownership when the host advances during displaced release", async () => {
    const context = await createCodexRuntimeContextOverrides(
      tempDir,
      "agent:main:test:release-rollover",
    );
    const scope = {
      storePath: context.sessionTarget.storePath,
      sessionKey: context.sessionKey,
    };
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: context.sessionKey,
    };
    const predecessor = { ...identity, sessionId: "session-before-compaction" };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: predecessor.sessionId, updatedAt: Date.now(), agentHarnessId: "codex" },
    });
    await patchSessionEntry({ ...scope, update: () => ({ sessionId: identity.sessionId }) });
    const previous = createClientHarness();
    const replacement = createClientHarness();
    ensureCodexAppServerClientRuntime(previous.client, { agentDir: tempDir });
    ensureCodexAppServerClientRuntime(replacement.client, { agentDir: tempDir });
    await writeTestBinding(predecessor, {
      threadId: "thread-release-rollover",
      clientId: previous.client.getInstanceId(),
      cwd: "/repo",
    });
    let releaseOld!: () => void;
    const oldReleaseBlocked = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldReleaseStarted = vi.fn();
    const oldUnsubscribe = vi.fn();
    await retainCodexAppServerLiveThread(
      previous.client,
      "thread-release-rollover",
      async (_threadId, assertCurrent) => {
        oldReleaseStarted();
        await oldReleaseBlocked;
        assertCurrent?.();
        oldUnsubscribe();
      },
    );
    const replacementRequest = vi
      .spyOn(replacement.client, "request")
      .mockResolvedValue({} as never);
    const sharedClientRuntime = await import("./app-server/shared-client.js");
    const retainPreviousClient = vi
      .spyOn(sharedClientRuntime, "retainSharedCodexAppServerClientByInstanceId")
      .mockImplementation(async (clientId) =>
        clientId === previous.client.getInstanceId()
          ? { client: previous.client, release: vi.fn() }
          : undefined,
      );
    const codexControlRequest = createResumeControlRequest(
      createThreadResumeResponse({ threadId: "thread-release-rollover" }),
      { client: replacement.client },
    );

    const command = runCommand("resume thread-release-rollover", { codexControlRequest }, context);
    try {
      await vi.waitFor(() => expect(oldReleaseStarted).toHaveBeenCalledOnce());
      await patchSessionEntry({ ...scope, update: () => ({ sessionId: "session-2" }) });
      releaseOld();

      expect((await command).text).toContain("Codex session generation is no longer current");
      expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
        threadId: "thread-release-rollover",
        clientId: previous.client.getInstanceId(),
      });
      expect(oldUnsubscribe).not.toHaveBeenCalled();
      expect(replacementRequest).toHaveBeenCalledExactlyOnceWith(
        "thread/unsubscribe",
        { threadId: "thread-release-rollover" },
        expect.objectContaining({ timeoutMs: expect.any(Number) }),
      );
      await expect(
        consumeCodexAppServerLiveThread(previous.client, "thread-release-rollover"),
      ).resolves.toEqual(expect.objectContaining({ release: expect.any(Function) }));
      await expect(
        consumeCodexAppServerLiveThread(replacement.client, "thread-release-rollover"),
      ).resolves.toBeUndefined();
    } finally {
      releaseOld();
      await command;
      retainPreviousClient.mockRestore();
      previous.client.close();
      replacement.client.close();
    }
  });

  it("does not report a resumed thread as attached after a generation conflict", async () => {
    const mutate = vi.fn(async () => false);
    const codexControlRequest = createResumeControlRequest(
      createThreadResumeResponse({ threadId: "thread-123", model: "gpt-5.5" }),
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
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            "openai:work": {
              type: "oauth",
              provider: "openai",
              access: "scoped-access",
              refresh: "scoped-refresh",
              expires: Date.now() + 60_000,
            },
          },
          order: { openai: ["openai:work"] },
        },
      },
    ]);
    const codexControlRequest = createResumeControlRequest(
      createThreadResumeResponse({ threadId: "thread-123" }),
      { authProfileId: "openai:work" },
    );
    const storePath = path.join(tempDir, "worker-sessions.json");
    await upsertSessionEntry({
      agentId: "worker",
      storePath,
      sessionKey: "global",
      entry: { sessionId: "session-1", updatedAt: Date.now() },
    });

    await runCommand(
      "resume thread-123",
      { codexControlRequest },
      {
        agentId: "worker",
        sessionKey: "global",
        config: {
          agents: { list: [{ id: "main", default: true }, { id: "worker" }] },
          session: { store: storePath, scope: "global" },
        },
      },
    );

    expect(codexControlRequest).toHaveBeenCalledWith(
      undefined,
      CODEX_CONTROL_METHODS.resumeThread,
      expect.any(Object),
      expect.objectContaining({ agentDir, authProfileId: undefined }),
    );
    expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "worker",
        sessionId: "session-1",
        sessionKey: "global",
      }),
    ).toEqual({
      threadId: "thread-123",
      clientId: expect.any(String),
      cwd: "/repo",
      authProfileId: "openai:work",
      model: "gpt-5.4",
      historyCoveredThrough: expect.any(String),
      pendingResumeConfiguration: true,
    });
    expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "global",
      }),
    ).toBeUndefined();
  });

  it("rejects malformed resume commands before attaching a Codex thread", async () => {
    const codexControlRequest = vi.fn();
    const writeBinding = vi.fn();

    await expect(
      runCommand("resume thread-123 extra", {
        codexControlRequest,
        bindingStore: { ...testCodexAppServerBindingStore, mutate: writeBinding },
      }),
    ).resolves.toEqual({
      text: "Usage: /codex resume <thread-id>",
    });
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(writeBinding).not.toHaveBeenCalled();
  });

  it("blocks native binding in sandboxed sessions", async () => {
    const args = "bind";

    const codexControlRequest = vi.fn();
    const steerCodexConversationTurn = vi.fn();
    const setCodexConversationModel = vi.fn();
    const setCodexConversationFastMode = vi.fn();
    const setCodexConversationPermissions = vi.fn();
    const stopCodexConversationTurn = vi.fn();

    const result = await runCommand(
      args,
      {
        codexControlRequest,
        steerCodexConversationTurn,
        setCodexConversationModel,
        setCodexConversationFastMode,
        setCodexConversationPermissions,
        stopCodexConversationTurn,
      },
      sandboxContext(),
    );

    expect(result.text).toContain(
      "Codex-native /codex " +
        args.split(/\s+/u)[0] +
        " is unavailable because OpenClaw sandboxing is active for this session.",
    );
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(steerCodexConversationTurn).not.toHaveBeenCalled();
    expect(setCodexConversationModel).not.toHaveBeenCalled();
    expect(setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(setCodexConversationPermissions).not.toHaveBeenCalled();
    expect(stopCodexConversationTurn).not.toHaveBeenCalled();
  });

  it("blocks native binding when exec host=node is active", async () => {
    const args = "bind";

    const codexControlRequest = vi.fn();
    const steerCodexConversationTurn = vi.fn();
    const setCodexConversationModel = vi.fn();
    const setCodexConversationFastMode = vi.fn();
    const setCodexConversationPermissions = vi.fn();
    const stopCodexConversationTurn = vi.fn();

    const result = await runCommand(
      args,
      {
        codexControlRequest,
        steerCodexConversationTurn,
        setCodexConversationModel,
        setCodexConversationFastMode,
        setCodexConversationPermissions,
        stopCodexConversationTurn,
      },
      nodeExecContext(),
    );

    expect(result.text).toContain(
      "Codex-native /codex " +
        args.split(/\s+/u)[0] +
        " is unavailable because OpenClaw exec host=node is active for this session.",
    );
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(steerCodexConversationTurn).not.toHaveBeenCalled();
    expect(setCodexConversationModel).not.toHaveBeenCalled();
    expect(setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(setCodexConversationPermissions).not.toHaveBeenCalled();
    expect(stopCodexConversationTurn).not.toHaveBeenCalled();
  });

  it("blocks config-level exec host=node without a session key", async () => {
    const result = await runCommand(
      "bind",
      {},
      {
        config: { tools: { exec: { host: "node", node: "worker-1" } } },
      },
    );

    expect(result.text).toContain(
      "Codex-native /codex bind is unavailable because OpenClaw exec host=node is active for this session.",
    );
  });

  it("still returns pre-native usage for malformed sandboxed native Codex commands", async () => {
    const setCodexConversationModel = vi.fn();

    await expect(runCommand("bind --help", {}, sandboxContext())).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });

    await expect(
      runCommand("model gpt-5.5 --help", { setCodexConversationModel }, sandboxContext()),
    ).resolves.toEqual({
      text: "Usage: /codex model <model>",
    });
    expect(setCodexConversationModel).not.toHaveBeenCalled();

    await expect(runCommand("resume", {}, sandboxContext())).resolves.toEqual({
      text: "Usage: /codex resume <thread-id>",
    });

    const resolveCodexCliSessionForBindingOnNode = vi.fn();
    await expect(
      runCommand(
        "resume cli-1 --host node-1",
        { resolveCodexCliSessionForBindingOnNode },
        sandboxContext(),
      ),
    ).resolves.toEqual({
      text: "Usage: /codex resume <session-id> --host <node> --bind here",
    });
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();

    await expect(
      runCommand(
        "resume cli-1 --host node-1 --bind here extra",
        { resolveCodexCliSessionForBindingOnNode },
        sandboxContext(),
      ),
    ).resolves.toEqual({
      text: "Usage: /codex resume <thread-id>\nUsage: /codex resume <session-id> --host <node> --bind here",
    });
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();

    await expect(runCommand("steer", {}, sandboxContext())).resolves.toEqual({
      text: "Usage: /codex steer <message>",
    });

    await expect(
      runCommand("stop now", { stopCodexConversationTurn: vi.fn() }, sandboxContext()),
    ).resolves.toEqual({
      text: "Usage: /codex stop",
    });
  });

  it("allows local Codex binding status forms in sandboxed sessions", async () => {
    await upsertSessionEntry({
      storePath: resolveStorePath(undefined, { agentId: "main" }),
      sessionKey: "sandboxed-session",
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        model: "gpt-5.6-sol",
        permissionMode: "full",
      },
    });
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "sandboxed-session",
      },
      {
        threadId: "thread-status",
        cwd: tempDir,
        model: "codex-execution-model",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        serviceTier: "priority",
      },
    );

    await expect(runCommand("model", {}, sandboxContext())).resolves.toEqual({
      text: "Codex model: gpt-5.6-sol",
    });
    await expect(runCommand("fast status", {}, sandboxContext())).resolves.toEqual({
      text: "Codex fast mode: on.",
    });
    await expect(runCommand("permissions status", {}, sandboxContext())).resolves.toEqual({
      text: "Codex permissions: full access.",
    });
    await expect(
      runCommand(
        "goal",
        {
          codexControlRequest: vi.fn(async (): Promise<JsonValue> => ({
            goal: {
              threadId: "thread-status",
              objective: "Inspect status",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          })),
        },
        sandboxContext(),
      ),
    ).resolves.toEqual({
      text: "Codex goal: Inspect status\n- Status: active\n- Tokens: 0",
    });
  });

  it("lists Codex CLI sessions from a requested node", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        sessions: [
          {
            sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
            cwd: "/repo",
            updatedAt: "2026-05-13T06:30:00.000Z",
            lastMessage: "fix the bridge",
            messageCount: 2,
          },
        ],
      },
    }));

    const result = await runCommand("sessions --host mb-m5 bridge", { listCodexCliSessionsOnNode });

    expect(result.text).toContain("Codex CLI sessions on mb-m5 / mb-m5:");
    expect(result.text).toContain("019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd");
    expect(result.text).toContain(
      "Bind: /codex resume 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd --host mb-m5 --bind here",
    );
    expect(listCodexCliSessionsOnNode).toHaveBeenCalledWith({
      requestedNode: "mb-m5",
      filter: "bridge",
      limit: undefined,
    });
  });

  it("normalizes signed decimal Codex CLI session limits before node dispatch", async () => {
    const listCodexCliSessionsOnNode = vi.fn(async () => ({
      node: { nodeId: "mb-m5", displayName: "mb-m5" },
      result: {
        codexHome: "/Users/mariano/.codex",
        sessions: [],
      },
    }));

    await runCommand("sessions --host mb-m5 --limit +05 bridge", { listCodexCliSessionsOnNode });

    expect(listCodexCliSessionsOnNode).toHaveBeenCalledWith({
      requestedNode: "mb-m5",
      filter: "bridge",
      limit: 5,
    });
  });

  it("rejects partial Codex CLI session limits before node dispatch", async () => {
    const listCodexCliSessionsOnNode = vi.fn();

    const result = await runCommand("sessions --host mb-m5 --limit 5x", {
      listCodexCliSessionsOnNode,
    });

    expect(result.text).toBe("Usage: /codex sessions --host <node> [filter] [--limit <n>]");
    expect(listCodexCliSessionsOnNode).not.toHaveBeenCalled();
  });

  it("binds the current conversation to a Codex CLI node session", async () => {
    const requestConversationBinding = vi.fn(async () => ({
      status: "bound" as const,
      binding: publicConversationBinding(),
    }));
    const resolveCodexCliSessionForBindingOnNode = vi.fn(async () => ({
      node: { nodeId: "node-123", displayName: "mb-m5" },
      session: {
        sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
        cwd: "/repo",
        messageCount: 2,
      },
    }));

    await expect(
      runCommand(
        "resume 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd --host mb-m5 --bind here",
        { resolveCodexCliSessionForBindingOnNode },
        nodeExecContext({ requestConversationBinding }),
      ),
    ).resolves.toEqual({
      text: "Bound this conversation to Codex CLI session 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd on node-123.",
    });
    expect(resolveCodexCliSessionForBindingOnNode).toHaveBeenCalledWith({
      requestedNode: "mb-m5",
      sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
    });
    expect(requestConversationBinding).toHaveBeenCalledWith({
      summary: "Codex CLI session 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd on node-123",
      detachHint: "/codex detach",
      data: {
        kind: "codex-cli-node-session",
        version: 1,
        nodeId: "node-123",
        sessionId: "019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd",
        agentId: "main",
        cwd: "/repo",
      },
    });
  });

  it("refuses to bind a Codex CLI node session that the node did not list", async () => {
    const requestConversationBinding = vi.fn();
    const resolveCodexCliSessionForBindingOnNode = vi.fn(async () => ({
      node: { nodeId: "node-123", displayName: "mb-m5" },
      session: undefined,
    }));

    await expect(
      runCommand(
        "resume 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd --host mb-m5 --bind here",
        { resolveCodexCliSessionForBindingOnNode },
        { requestConversationBinding },
      ),
    ).resolves.toEqual({
      text: "No Codex CLI session 019e2007-1f7e-7eb1-a42b-8c01f4b9b5cd was found on mb-m5.",
    });
    expect(requestConversationBinding).not.toHaveBeenCalled();
  });

  it("escapes resumed Codex thread ids before chat display", async () => {
    const unsafe = "thread-123 <@U123> [trusted](https://evil)";
    const deps = createDeps({
      codexControlRequest: createResumeControlRequest(
        createThreadResumeResponse({ threadId: unsafe }),
      ),
    });

    const result = await runCommand(`resume "${unsafe}"`, deps);

    expect(result.text).toContain(
      "thread-123 &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });

  it("lists scoped models with escaped ids and a truncation notice", async () => {
    const config = { auth: { order: { openai: ["openai:work"] } } };
    const listCodexAppServerModels = vi.fn(async () => ({
      models: ["gpt-5.4", "unsafe_model <@U123> [trusted](https://evil)"].map((id) => ({
        id,
        model: id,
        inputModalities: ["text" as const],
        supportedReasoningEfforts: ["medium" as const],
      })),
      truncated: true,
    }));
    const result = await runCommand("models", { listCodexAppServerModels }, { config });
    expect(result.text).toBe(
      "Codex models:\n- gpt-5.4\n- unsafe\uff3fmodel &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09\n- More models available; output truncated.",
    );
    expect(listCodexAppServerModels).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ config, agentDir: resolveDefaultAgentDir(config), limit: 100 }),
    );
  });

  it("reports unavailable status with escaped errors when every probe fails", async () => {
    const config = { auth: { order: { openai: ["openai:work"] } } };
    const offline = { ok: false as const, error: "offline <@U123> [trusted](https://evil) @here" };
    const readCodexStatusProbes = vi.fn(async () => ({
      models: offline,
      account: offline,
      limits: offline,
      mcps: offline,
      skills: offline,
    }));
    const result = await runCommand("status", { readCodexStatusProbes }, { config });
    expect(result.text).toBe(
      [
        "Codex app-server: unavailable",
        ...["Models", "Account", "Rate limits", "MCP servers", "Skills"].map(
          (label) =>
            `${label}: offline &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here`,
        ),
      ].join("\n"),
    );
    expect(readCodexStatusProbes).toHaveBeenCalledExactlyOnceWith(
      undefined,
      config,
      resolveDefaultAgentDir(config),
    );
  });

  it("summarizes connected status with escaped fields and enabled nested skills", async () => {
    const skill = (name: string, enabled: boolean, cwd: string) => ({
      name,
      enabled,
      description: "",
      path: `${cwd}/.codex/skills/${name}/SKILL.md`,
      scope: "repo" as const,
    });
    const unsafe = "<@U123> [trusted](https://evil) @here";
    const limit = {
      limitId: "codex",
      limitName: "Codex",
      primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: null },
      secondary: null,
      credits: null,
      planType: null,
      rateLimitReachedType: null,
    };
    const result = await runCommand("status", {
      readCodexStatusProbes: vi.fn(async () => ({
        models: {
          ok: true as const,
          value: {
            models: [
              {
                id: unsafe,
                model: unsafe,
                inputModalities: ["text" as const],
                supportedReasoningEfforts: ["medium" as const],
              },
            ],
          },
        },
        account: {
          ok: true as const,
          value: {
            account: { type: "chatgpt" as const, email: unsafe, planType: "plus" as const },
            requiresOpenaiAuth: false,
          },
        },
        limits: {
          ok: true as const,
          value: { rateLimits: limit, rateLimitsByLimitId: { codex: limit } },
        },
        mcps: { ok: true as const, value: { data: [], nextCursor: null } },
        skills: {
          ok: true as const,
          value: {
            data: [
              {
                cwd: "/repo-a",
                skills: [
                  skill("enabled-one", true, "/repo-a"),
                  skill("disabled-one", false, "/repo-a"),
                ],
                errors: [],
              },
              {
                cwd: "/repo-b",
                skills: [skill("enabled-two", true, "/repo-b")],
                errors: [{ path: "/bad", message: "bad skill" }],
              },
            ],
          },
        },
      })),
    });
    expect(result.text).toBe(
      [
        "Codex app-server: connected",
        "Models: &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        "Account: &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
        "Rate limits: Codex: primary 58% left",
        "MCP servers: none returned",
        "Skills: 2",
      ].join("\n"),
    );
  });

  it("does not count empty Codex rate-limit buckets as returned limits", async () => {
    const limits = {
      ok: true as const,
      value: {
        rateLimits: [
          {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
        ],
        rateLimitsByLimitId: {
          premium: {
            limitId: "premium",
            limitName: "premium",
            primary: null,
            secondary: null,
            credits: null,
            planType: "pro",
            rateLimitReachedType: null,
          },
          codex: {
            limitId: "codex",
            limitName: "Codex",
            primary: null,
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
        },
      },
    };
    const deps = createDeps({
      readCodexStatusProbes: vi.fn(async () => ({
        models: { ok: false as const, error: "offline" },
        account: { ok: false as const, error: "offline" },
        limits,
        mcps: { ok: true as const, value: { data: [], nextCursor: null } },
        skills: { ok: true as const, value: { data: [] } },
      })),
      safeCodexControlRequest: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true as const,
          value: { account: { email: "codex@example.com" } },
        })
        .mockResolvedValueOnce(limits),
    });

    const statusResult = await runCommand("status", deps);
    expectResultTextContains(statusResult, "Rate limits: none returned");
    expect(statusResult.text).not.toContain("Rate limits: 1");
    expect(statusResult.text).not.toContain("premium");

    const accountResult = await runCommand("account", deps);
    expectResultTextContains(accountResult, "Rate limits: none returned");
    expect(accountResult.text).not.toContain("Rate limits: 1");
    expect(accountResult.text).not.toContain("premium");
  });

  it("rejects extra operands for read-only Codex commands", async () => {
    const readCodexStatusProbes = vi.fn();
    const listCodexAppServerModels = vi.fn();
    const safeCodexControlRequest = vi.fn();
    const codexControlRequest = vi.fn();
    const getCurrentConversationBinding = vi.fn();
    const deps = createDeps({
      codexControlRequest,
      listCodexAppServerModels,
      readCodexStatusProbes,
      safeCodexControlRequest,
    });

    await expect(runCommand("status now", deps)).resolves.toEqual({
      text: "Usage: /codex status",
    });
    await expect(runCommand("models all", deps)).resolves.toEqual({
      text: "Usage: /codex models",
    });
    await expect(runCommand("account refresh", deps)).resolves.toEqual({
      text: "Usage: /codex account",
    });
    await expect(runCommand("mcp list", deps)).resolves.toEqual({
      text: "Usage: /codex mcp",
    });
    await expect(runCommand("skills list", deps)).resolves.toEqual({
      text: "Usage: /codex skills",
    });
    await expect(
      runCommand("binding current", deps, {
        getCurrentConversationBinding,
      }),
    ).resolves.toEqual({
      text: "Usage: /codex binding",
    });

    expect(readCodexStatusProbes).not.toHaveBeenCalled();
    expect(listCodexAppServerModels).not.toHaveBeenCalled();
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(getCurrentConversationBinding).not.toHaveBeenCalled();
  });

  describe("account readouts", () => {
    const success = (value: JsonValue) => ({ ok: true as const, value });
    const failure = (error: string) => ({ ok: false as const, error });
    const apiKeyProfile = (name: string) => ({
      type: "api_key" as const,
      provider: "openai",
      key: `sk-test-${name}`,
    });
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

    it("formats generated account/read responses", async () => {
      const safeCodexControlRequest = accountRequests(
        success({
          account: { type: "chatgpt", email: "codex@example.com", planType: "pro" },
          requiresOpenaiAuth: false,
        }),
        success({
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            primary: {
              usedPercent: 50,
              windowDurationMins: 300,
              resetsAt: Math.ceil(Date.now() / 1000) + 120,
            },
            secondary: null,
            credits: null,
            planType: "plus",
            rateLimitReachedType: null,
          },
          rateLimitsByLimitId: null,
        }),
      );
      const result = await readAccount(safeCodexControlRequest);
      expect(result.text).toContain("Account: codex@example.com");
      expect(result.text).toContain("Codex is available.");
      expect(safeCodexControlRequest).toHaveBeenCalledWith(
        undefined,
        CODEX_CONTROL_METHODS.account,
        { refreshToken: false },
        expect.objectContaining({
          agentDir: path.join(tempDir, "agents", "main", "agent"),
          sessionId: "session-1",
        }),
      );
    });

    it("escapes Codex account probe errors before chat display", async () => {
      const unsafe = "<@U123> [trusted](https://evil) @here";
      const result = await readAccount(accountRequests(failure(unsafe), failure(unsafe)));
      expect(result.text).toContain(
        "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
      );
      for (const raw of ["<@U123>", "[trusted](https://evil)", "@here"]) {
        expect(result.text).not.toContain(raw);
      }
    });

    it("summarizes blocked account rate limits as a human takeaway", async () => {
      const quota = limits(0, 100, true);
      const result = await readAccount(
        accountRequests(
          success({
            account: { type: "chatgpt", email: "codex@example.com", planType: "pro" },
            requiresOpenaiAuth: false,
          }),
          success({
            rateLimitsByLimitId: {
              ...quota.rateLimitsByLimitId,
              "gpt-5.3-codex-spark": {
                ...limits(0, 0).rateLimitsByLimitId.codex,
                limitId: "gpt-5.3-codex-spark",
                limitName: "GPT 5.3 Codex Spark",
              },
            },
          }),
        ),
      );
      expect(result.text).toContain("Codex is paused until ");
      expect(result.text).toContain("Your weekly Codex usage limit is reached.");
      for (const omitted of [
        "GPT 5.3 Codex Spark",
        "Primary:",
        "Secondary:",
        "Bucket:",
        "Why:",
        "5-hour",
        "100%",
        "\uff08rate limit reached\uff09",
      ]) {
        expect(result.text).not.toContain(omitted);
      }
    });

    it("prefers the configured ChatGPT subscription over stale API-key lastGood state", async () => {
      const config = {
        auth: { order: { openai: ["openai:personal-email@gmail.com", "openai:api-key-backup"] } },
      };
      installAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:personal-email@gmail.com": oauthProfile("personal-email@gmail.com", Date.now()),
            "openai:api-key-backup": apiKeyProfile("backup"),
          },
          lastGood: { openai: "openai:api-key-backup" },
        },
        config,
      );
      const request = accountRequests(
        success({
          account: { type: "chatgpt", email: "personal-email@gmail.com", planType: "pro" },
          requiresOpenaiAuth: false,
        }),
        success(limits(12, 63)),
      );
      const result = await readAccount(request, { config });
      expect(result.text).toContain("Subscription  personal-email@gmail.com");
      expect(result.text).toContain("Weekly 63% · Short-term 12%");
      expect(result.text).toContain(
        "\n  1. personal-email@gmail.com   ChatGPT subscription   — active now",
      );
      expect(result.text).toContain("\n  2. api-key-backup   API key   — available if needed");
      expect(result.text).not.toContain("Now using: api-key-backup");
      expect(result.text).not.toContain("subscription unavailable");
      expect(result.text).not.toContain("openai:");
      expect(request).toHaveBeenCalledTimes(2);
    });

    it("explains when an API-key backup is active because the subscription is paused", async () => {
      const config = {};
      const agentDir = path.join(tempDir, "agents", "worker", "agent");
      const now = Date.now();
      installAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:personal-email@gmail.com": oauthProfile("personal-email@gmail.com", now),
            "openai:api-key-backup": apiKeyProfile("backup"),
            "openai:work-email@gmail.com": oauthProfile("work-email@gmail.com", now),
            "openai:work-api-key-backup": apiKeyProfile("work-backup"),
          },
          order: {
            openai: [
              "openai:personal-email@gmail.com",
              "openai:api-key-backup",
              "openai:work-email@gmail.com",
              "openai:work-api-key-backup",
            ],
          },
          lastGood: { openai: "openai:personal-email@gmail.com" },
          usageStats: {
            "openai:personal-email@gmail.com": { blockedUntil: now + 23 * 60 * 60 * 1000 },
          },
        },
        config,
        agentDir,
      );
      const request = accountRequests(
        success({ account: { type: "unknown" }, requiresOpenaiAuth: true }),
        failure("chatgpt authentication required to read rate limits"),
        success(limits(0, 100, true)),
      );
      const result = await readAccount(request, { config, sessionKey: "agent:worker:session-1" });
      for (const expected of [
        "Now using: api-key-backup",
        "subscription rate-limited · switches back in",
        "Subscription  personal-email@gmail.com",
        "\n  Weekly 100% · Short-term 0% · Resets in",
        "\n  1. personal-email@gmail.com   ChatGPT subscription   — rate-limited",
        "\n  2. api-key-backup   API key   — active now · billed per token",
        "\n  3. work-email@gmail.com   ChatGPT subscription   — available if needed",
        "\n  4. work-api-key-backup   API key   — available if needed",
      ]) {
        expect(result.text).toContain(expected);
      }
      for (const omitted of [
        "Reason:",
        "fallback active",
        "not tracked",
        "chatgpt authentication required",
        "openai:",
        "primary",
        "secondary",
        "personal-email@gmail.com   ChatGPT subscription   — active now",
      ]) {
        expect(result.text).not.toContain(omitted);
      }
      expect(request).toHaveBeenNthCalledWith(
        3,
        undefined,
        CODEX_CONTROL_METHODS.rateLimits,
        undefined,
        { config, agentDir, authProfileId: "openai:personal-email@gmail.com", isolated: true },
      );
    });

    it("respects openai-alias explicit order over stale lastGood for API key profiles", async () => {
      const config = {};
      installAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:fresh-key": apiKeyProfile("fresh"),
            "openai:stale-key": apiKeyProfile("stale"),
          },
          order: { openai: ["openai:fresh-key", "openai:stale-key"] },
          lastGood: { openai: "openai:stale-key" },
        },
        config,
      );
      const request = accountRequests(
        success({ account: { type: "unknown" }, requiresOpenaiAuth: false }),
        failure("usage data unavailable"),
      );
      const result = await readAccount(request, { config });
      expect(result.text).toContain("\n  1. fresh-key   API key   — active now");
      expect(result.text).not.toContain("stale-key   API key   — active now");
      expect(request).toHaveBeenCalledTimes(2);
    });

    it("shows temporary and permanent auth cooldowns as expired subscriptions", async () => {
      const config = {};
      const now = Date.now();
      installAuthProfileStore(
        {
          version: 1,
          profiles: {
            "openai:expired@example.com": oauthProfile("expired@example.com", now),
            "openai:dead@example.com": oauthProfile("dead@example.com", now),
            "openai:api-key": apiKeyProfile("fallback"),
          },
          order: {
            openai: ["openai:expired@example.com", "openai:dead@example.com", "openai:api-key"],
          },
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
        success({ account: { type: "unknown" }, requiresOpenaiAuth: false }),
        failure("rate limits unavailable"),
        failure("subscription limits unavailable"),
      );
      const result = await readAccount(request, { config });
      expect(result.text).toContain(
        "\n  1. expired@example.com   ChatGPT subscription   — sign-in expired",
      );
      expect(result.text).toContain(
        "\n  2. dead@example.com   ChatGPT subscription   — sign-in expired",
      );
      expect(result.text).toContain("\n  3. api-key   API key   — active now");
      expect(result.text).not.toContain("temporarily unavailable");
    });

    it("escapes successful Codex account fallback summaries before chat display", async () => {
      const unsafe = "<@U123> [trusted](https://evil) @here";
      const result = await readAccount(
        accountRequests(success({ account: { id: unsafe } }), success([])),
      );
      expect(result.text).toContain(
        "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
      );
      for (const raw of ["<@U123>", "[trusted](https://evil)", "@here"]) {
        expect(result.text).not.toContain(raw);
      }
    });

    it("formats generated Amazon Bedrock account responses", async () => {
      await expect(
        readAccount(
          accountRequests(
            success({ account: { type: "amazonBedrock" }, requiresOpenaiAuth: false }),
            success([]),
          ),
        ),
      ).resolves.toEqual({
        text: ["Account: Amazon Bedrock", "Rate limits: none returned"].join("\n\n"),
      });
    });
  });

  it("compacts a conversation binding after recovering its current session owner", async () => {
    const runtime = await createCodexRuntimeContextOverrides(
      tempDir,
      "agent:main:test:conversation-compact-recovery",
    );
    await upsertSessionEntry({
      storePath: runtime.sessionTarget.storePath,
      sessionKey: runtime.sessionKey,
      entry: {
        sessionId: "session-1",
        previousSessionId: "session-before-compact",
        updatedAt: Date.now(),
        agentHarnessId: "codex",
      },
    });
    const owner = {
      threadId: "thread-recovered-compact",
      clientId: "client-recovered-compact",
      cwd: "/repo",
      contextEngine: {
        schemaVersion: 1,
        engineId: "lossless-claw",
        policyFingerprint: "policy-1",
        projection: { schemaVersion: 1, mode: "thread_bootstrap", epoch: "epoch-1" },
      },
    } satisfies Parameters<typeof writeTestBinding>[1];
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-before-compact",
        sessionKey: runtime.sessionKey,
      },
      owner,
    );
    await writeTestBinding({ kind: "conversation", bindingId: "binding-data-1" }, owner);
    const compactCurrent = vi.fn(async () => ({
      compacted: true,
      tokensBefore: 900,
      tokensAfter: 123,
    }));
    const codexControlRequest = vi.fn();

    await expect(
      runCommand(
        "compact",
        { codexControlRequest },
        {
          ...runtime,
          runtimeContext: { compactCurrent },
          getCurrentConversationBinding: async () =>
            publicConversationBinding({
              kind: "codex-app-server-session",
              version: 2,
              bindingId: "binding-data-1",
              workspaceDir: "/repo",
            }),
        },
      ),
    ).resolves.toEqual({ text: "Compacted Codex session (123 tokens after)." });
    expect(compactCurrent).toHaveBeenCalledOnce();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(
      testCodexAppServerBindingStore.read({
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      }),
    ).toMatchObject(owner);
  });

  it("rejects a Codex binding on a non-Codex session runtime", async () => {
    const sessionKey = "agent:main:test:mixed-runtime";
    const storePath = path.join(tempDir, "mixed-runtime-sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        agentHarnessId: "openclaw",
      },
    });
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1", sessionKey },
      { threadId: "thread-codex", cwd: "/repo" },
    );
    const compactCurrent = vi.fn(async () => ({ compacted: true, tokensAfter: 321 }));

    const result = await runCommand(
      "compact",
      {},
      {
        config: { session: { store: storePath } },
        sessionKey,
        sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
        runtimeContext: { compactCurrent },
      },
    );

    expect(result.text).toContain("not using the Codex runtime");
    expect(compactCurrent).not.toHaveBeenCalled();
  });

  it("rejects a conversation-bound thread that differs from the current session", async () => {
    const runtime = await createCodexRuntimeContextOverrides(tempDir);
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      },
      { threadId: "thread-session", clientId: "client-session", cwd: "/repo" },
    );
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      { threadId: "thread-conversation", clientId: "client-conversation", cwd: "/repo" },
    );
    const compactCurrent = vi.fn(async () => ({ compacted: true, tokensAfter: 321 }));

    const result = await runCommand(
      "compact",
      {},
      {
        ...runtime,
        runtimeContext: { compactCurrent },
        getCurrentConversationBinding: async () =>
          publicConversationBinding({
            kind: "codex-app-server-session",
            version: 2,
            bindingId: "binding-data-1",
            workspaceDir: "/repo",
          }),
      },
    );

    expect(result.text).toContain("conversation-bound thread differs");
    expect(compactCurrent).not.toHaveBeenCalled();
  });

  it("starts supervised compact and review actions through the native user-home connection", async () => {
    const runtime = await createCodexRuntimeContextOverrides(tempDir);
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      },
      supervisedTestBinding(),
    );
    const codexControlRequest = vi.fn(async () => undefined);
    const pluginConfig = { supervision: { enabled: true } };
    const deps = createDeps({ codexControlRequest });

    await runCommand(
      "compact",
      deps,
      {
        ...runtime,
        runtimeContext: {
          compactCurrent: async () => ({ compacted: true, tokensAfter: 321 }),
        },
      },
      { pluginConfig },
    );
    const review = await runCommand("review", deps, runtime, { pluginConfig });
    expect(review.text).toBe("Started Codex review for thread thread-supervised.");
    expect(codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      CODEX_CONTROL_METHODS.review,
      { threadId: "thread-supervised", target: { type: "uncommittedChanges" } },
      expect.objectContaining({ config: runtime.config }),
    );

    expect(codexControlRequest).toHaveBeenCalledTimes(1);
    for (let callIndex = 0; callIndex < codexControlRequest.mock.calls.length; callIndex += 1) {
      expect(mockArg(codexControlRequest, callIndex, 3)).toMatchObject({
        authProfileId: null,
        startOptions: { homeScope: "user" },
      });
    }
  });

  it("rejects malformed compact and review commands before starting thread actions", async () => {
    const codexControlRequest = vi.fn();

    await expect(runCommand("compact now", { codexControlRequest })).resolves.toEqual({
      text: "Usage: /codex compact",
    });
    await expect(runCommand("review staged", { codexControlRequest })).resolves.toEqual({
      text: "Usage: /codex review",
    });
    expect(codexControlRequest).not.toHaveBeenCalled();
  });

  it("escapes compaction failure reasons before chat display", async () => {
    const runtime = await createCodexRuntimeContextOverrides(tempDir);
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      },
      { threadId: "thread-123", cwd: "/repo" },
    );
    const result = await runCommand(
      "compact",
      {},
      {
        ...runtime,
        runtimeContext: {
          compactCurrent: async () => ({
            compacted: false,
            reason: "thread-123 <@U123>",
          }),
        },
      },
    );

    expect(result.text).toContain("thread-123 &lt;\uff20U123&gt;");
    expect(result.text).not.toContain("<@U123>");
  });

  it("formats failed Codex Computer Use live probes as not ready", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      ready: false,
      reason: "live_test_failed" as const,
      liveTest: {
        status: "failed" as const,
        ok: false,
        attempted: true,
        attempts: 2,
        timeoutMs: 60_000,
        retried: true,
        repaired: false,
        message: "Computer Use live test failed after 2 attempts: list_apps timed out",
        error: "list_apps timed out",
      },
      warnings: [
        "Computer Use live test failed, but compatibility startup remains enabled; set computerUse.strictReadiness to true to fail closed.",
      ],
      message:
        "Computer Use live test failed after 2 attempts: list_apps timed out Startup is allowed because computerUse.strictReadiness is false.",
    }));

    const result = await runCommand("computer-use status", { readCodexComputerUseStatus });

    expectResultTextContains(result, "Computer Use: not ready");
    expectResultTextContains(result, "Live test: failed (2 attempts, 60000ms)");
    expectResultTextContains(result, "Warning: Computer Use live test failed");
  });

  it("escapes Codex Computer Use status fields before chat display", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      pluginName: "<@U123>",
      mcpServerName: "computer-use [server](https://evil)",
      marketplaceName: "desktop_tools",
      tools: ["list_apps", "[click](https://evil)"],
      message: "Computer Use is ready @here.",
    }));

    const result = await runCommand("computer-use status", { readCodexComputerUseStatus });

    expect(result.text).toContain("Plugin: &lt;\uff20U123&gt; (installed)");
    expect(result.text).toContain(
      "MCP server: computer-use \uff3bserver\uff3d\uff08https://evil\uff09 (2 tools)",
    );
    expect(result.text).toContain("Marketplace: desktop\uff3ftools");
    expect(result.text).toContain(
      "Tools: list\uff3fapps, \uff3bclick\uff3d\uff08https://evil\uff09",
    );
    expect(result.text).toContain("Computer Use is ready \uff20here.");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[click](https://evil)");
    expect(result.text).not.toContain("@here");
  });

  it("formats disabled installed Codex Computer Use plugins", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => ({
      ...computerUseReadyStatus(),
      ready: false,
      reason: "plugin_disabled" as const,
      pluginEnabled: false,
      mcpServerAvailable: false,
      tools: [],
      message:
        "Computer Use is installed, but the computer-use plugin is disabled. Run /codex computer-use install or enable computerUse.autoInstall to re-enable it.",
    }));

    const result = await runCommand("computer-use status", { readCodexComputerUseStatus });

    expectResultTextContains(result, "Plugin: computer-use (installed, disabled)");
  });

  it("installs Codex Computer Use from command overrides", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await runCommand(
      "computer-use install --source github:example/desktop-tools --marketplace desktop-tools",
      { installCodexComputerUse },
    );

    expectResultTextContains(result, "Computer Use: ready");
    expect(installCodexComputerUse).toHaveBeenCalledWith({
      pluginConfig: undefined,
      config: {},
      agentDir: path.join(tempDir, "agents", "main", "agent"),
      forceEnable: true,
      assertCurrent: expect.any(Function),
      overrides: {
        marketplaceSource: "github:example/desktop-tools",
        marketplaceName: "desktop-tools",
      },
    });
  });

  it.each([
    ["status --plugin custom_plugin@v2", 'computerUse.pluginName = "custom_plugin@v2"', "status"],
    ["install --server custom-server", 'computerUse.mcpServerName = "custom-server"', "install"],
    [
      "install --mcp-server custom-server",
      'computerUse.mcpServerName = "custom-server"',
      "install",
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

      expectResultTextContains(result, setting);
      expectResultTextContains(result, `rerun /codex computer-use ${action}`);
      expect(installCodexComputerUse).not.toHaveBeenCalled();
      expect(readCodexComputerUseStatus).not.toHaveBeenCalled();
    },
  );

  it("preserves marketplace flags in legacy Computer Use migration guidance", async () => {
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await runCommand(
      'computer-use install --plugin custom-plugin --source github:example/tools --marketplace tools --marketplace-path "/tmp/My Tools"',
      { installCodexComputerUse },
    );

    expectResultTextContains(result, 'computerUse.pluginName = "custom-plugin"');
    expectResultTextContains(
      result,
      'rerun /codex computer-use install --source "github:example/tools" --marketplace-path "/tmp/My Tools" --marketplace "tools"',
    );
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("rejects ambiguous Computer Use actions before setup checks", async () => {
    const readCodexComputerUseStatus = vi.fn(async () => computerUseReadyStatus());
    const installCodexComputerUse = vi.fn(async () => computerUseReadyStatus());

    const result = await runCommand("computer-use status install", {
      readCodexComputerUseStatus,
      installCodexComputerUse,
    });

    expectResultTextContains(result, "Usage: /codex computer-use");
    expect(readCodexComputerUseStatus).not.toHaveBeenCalled();
    expect(installCodexComputerUse).not.toHaveBeenCalled();
  });

  it("requires a Codex thread binding before host compaction", async () => {
    const runtime = await createCodexRuntimeContextOverrides(tempDir);
    const compactCurrent = vi.fn(async () => ({ compacted: true, tokensAfter: 321 }));

    await expect(
      runCommand(
        "compact",
        {},
        {
          ...runtime,
          runtimeContext: { compactCurrent },
        },
      ),
    ).resolves.toEqual({
      text: "No Codex thread is attached to this OpenClaw session yet.",
    });
    expect(compactCurrent).not.toHaveBeenCalled();
  });

  it("rejects host compaction without a complete captured session target", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-123", cwd: "/repo" });
    const compactCurrent = vi.fn(async () => ({ compacted: true, tokensAfter: 321 }));

    const result = await runCommand("compact", {}, { runtimeContext: { compactCurrent } });

    expect(result.text).toContain("not bound to a complete session identity");
    expect(compactCurrent).not.toHaveBeenCalled();
  });

  it("uses the host agent for diagnostics inventory sessions with unscoped keys", async () => {
    await writeTestBinding(
      {
        kind: "session",
        agentId: "first",
        sessionId: "session-global",
        sessionKey: "global",
      },
      { threadId: "thread-global", cwd: "/repo" },
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

    expect(request.text).toContain("Codex runtime thread detected.");
    expect(request.text).toContain("OpenClaw session key: `global`");
    expect(request.text).toContain("Codex thread id: `thread-global`");
  });

  it("requires an owner for Codex diagnostics feedback uploads", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-owner", cwd: "/repo" });
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-owner" },
    }));

    await expect(
      runCommand(
        "diagnostics",
        { safeCodexControlRequest },
        {
          senderIsOwner: false,
        },
      ),
    ).resolves.toEqual({
      text: "Only an owner can send Codex diagnostics.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("refuses diagnostics confirmations without a stable sender identity", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-sender-required", cwd: "/repo" });

    await expect(
      runCommand(
        "diagnostics",
        {},
        {
          senderId: undefined,
        },
      ),
    ).resolves.toEqual({
      text: "Cannot send Codex diagnostics because this command did not include a sender identity.",
    });
  });

  it("keeps diagnostics confirmation scoped to the requesting sender", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-sender", cwd: "/repo" });
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-sender" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await runCommand("diagnostics", deps, { senderId: "user-1" });
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      runCommand(`diagnostics confirm ${token}`, deps, { senderId: "user-2" }),
    ).resolves.toEqual({
      text: "Only the user who requested these Codex diagnostics can confirm the upload.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("consumes diagnostics confirmations before async upload work", async () => {
    let releaseFirstConfirmUpload: () => void = () => undefined;
    let firstConfirmUploadStarted: () => void = () => undefined;
    const firstConfirmUpload = new Promise<void>((resolve) => {
      releaseFirstConfirmUpload = resolve;
    });
    const firstConfirmUploadStartedPromise = new Promise<void>((resolve) => {
      firstConfirmUploadStarted = resolve;
    });
    const readBinding = vi.fn(() => ({
      threadId: "thread-race",
      cwd: "/repo",
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    }));
    const safeCodexControlRequest = vi.fn(async () => {
      firstConfirmUploadStarted();
      await firstConfirmUpload;
      return { ok: true as const, value: { threadId: "thread-race" } };
    });
    const deps = createDeps({
      bindingStore: { ...testCodexAppServerBindingStore, read: readBinding },
      safeCodexControlRequest,
    });

    const request = await runCommand("diagnostics", deps, { senderId: "user-1" });
    const token = readDiagnosticsConfirmationToken(request);
    const firstConfirm = runCommand(`diagnostics confirm ${token}`, deps, { senderId: "user-1" });
    try {
      expect(
        await Promise.race([
          firstConfirmUploadStartedPromise.then(() => "entered"),
          firstConfirm.then(() => "settled"),
        ]),
      ).toBe("entered");
      await expect(
        runCommand(`diagnostics confirm ${token}`, deps, { senderId: "user-1" }),
      ).resolves.toEqual({
        text: "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.",
      });
    } finally {
      releaseFirstConfirmUpload();
      await firstConfirm;
    }
    const firstConfirmResult = await firstConfirm;
    expectResultTextContains(firstConfirmResult, "Codex diagnostics sent to OpenAI servers:");
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics confirmation scoped to account and channel identity", async () => {
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "session-key-1",
      },
      { threadId: "thread-account", cwd: "/repo" },
    );
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-account" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await runCommand("diagnostics", deps, {
      accountId: "account-1",
      channelId: "channel-1",
      messageThreadId: "thread-1",
      threadParentId: "parent-1",
      sessionKey: "session-key-1",
    });
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      runCommand(`diagnostics confirm ${token}`, deps, {
        accountId: "account-2",
        channelId: "channel-1",
        messageThreadId: "thread-1",
        threadParentId: "parent-1",
        sessionKey: "session-key-1",
      }),
    ).resolves.toEqual({
      text: "This Codex diagnostics confirmation belongs to a different account.",
    });
    expect(safeCodexControlRequest).not.toHaveBeenCalled();
  });

  it("allows private-routed diagnostics confirmations from the owner DM", async () => {
    const identity = {
      kind: "session" as const,
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "group-session",
    };
    await writeTestBinding(identity, { threadId: "thread-private", cwd: "/repo" });
    const safeCodexControlRequest = vi.fn(
      async (_pluginConfig: unknown, _method: string, _requestParams: unknown) => ({
        ok: true as const,
        value: { threadId: "thread-private" },
      }),
    );
    const deps = createDeps({ safeCodexControlRequest });

    const request = await runCommand("diagnostics", deps, {
      accountId: "account-1",
      channelId: "group-channel",
      messageThreadId: "group-topic",
      sessionKey: "group-session",
      diagnosticsPrivateRouted: true,
    });
    const token = readDiagnosticsConfirmationToken(request);

    await expect(
      runCommand(`diagnostics confirm ${token}`, deps, {
        accountId: "account-1",
        channelId: "owner-dm",
        sessionKey: "owner-dm-session",
      }),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionKey: "group-session",
          sessionId: "session-1",
          threadId: "thread-private",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    expect(mockArg(safeCodexControlRequest, 0, 0)).toBeUndefined();
    expect(mockArg(safeCodexControlRequest, 0, 1)).toBe(CODEX_CONTROL_METHODS.feedback);
    const feedbackParams = requestParams(safeCodexControlRequest);
    expect(feedbackParams.classification).toBe("bug");
    expect(feedbackParams.threadId).toBe("thread-private");
    expect(feedbackParams.includeLogs).toBe(true);

    await writeTestBinding(identity, { threadId: "thread-private-next", cwd: "/repo" });
    const repeated = await runCommand("diagnostics", deps, {
      accountId: "account-1",
      channelId: "group-channel",
      messageThreadId: "group-topic",
      sessionKey: "group-session",
      diagnosticsPrivateRouted: true,
    });
    expect(repeated.text).toContain(
      "Codex diagnostics were already sent for this account or channel recently",
    );
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
  });

  it("keeps diagnostics confirmation eviction scoped to account identity", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-confirm-scope", cwd: "/repo" });

    const firstRequest = await runCommand(
      "diagnostics",
      {},
      {
        accountId: "account-kept",
        channelId: "channel-kept",
      },
    );
    const firstToken = readDiagnosticsConfirmationToken(firstRequest);

    for (let index = 0; index < 100; index += 1) {
      await runCommand(
        `diagnostics ${index}`,
        {},
        {
          accountId: "account-noisy",
          channelId: "channel-noisy",
        },
      );
    }

    await expect(
      runCommand(
        `diagnostics cancel ${firstToken}`,
        {},
        {
          accountId: "account-kept",
          channelId: "channel-kept",
        },
      ),
    ).resolves.toEqual({
      text: [
        "Codex diagnostics upload canceled.",
        "Codex sessions:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionId: "session-1",
          threadId: "thread-confirm-scope",
        }),
      ].join("\n"),
    });
  });

  it("escapes approval notes while preserving the UTF-16 upload boundary", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-note", cwd: "/repo" });
    const safeCodexControlRequest = vi.fn(async () => ({ ok: true as const, value: {} }));
    const deps = createDeps({ safeCodexControlRequest });
    const prefix = "<@U123> [trusted](https://evil) @here `tick`";
    const padding = "x".repeat(2047 - prefix.length);
    const reason = prefix + padding;
    const request = await runCommand(`diagnostics ${reason}😀tail`, deps);
    expect(requireResultText(request).split("\n")).toContain(
      "Note: &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here \uff40tick\uff40" +
        padding,
    );
    const token = readDiagnosticsConfirmationToken(request);
    await runCommand(`diagnostics confirm ${token}`, deps);
    expect(safeCodexControlRequest).toHaveBeenCalledExactlyOnceWith(
      undefined,
      CODEX_CONTROL_METHODS.feedback,
      {
        classification: "bug",
        reason,
        threadId: "thread-note",
        includeLogs: true,
        tags: { source: "openclaw-diagnostics", channel: "test" },
      },
      expect.any(Object),
    );
  });

  it("throttles repeated diagnostics uploads for the same thread", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-cooldown", cwd: "/repo" });
    const safeCodexControlRequest = vi.fn(async () => ({
      ok: true as const,
      value: { threadId: "thread-cooldown" },
    }));
    const deps = createDeps({ safeCodexControlRequest });

    const request = await runCommand("diagnostics first", deps);
    const token = readDiagnosticsConfirmationToken(request);
    await expect(runCommand(`diagnostics confirm ${token}`, deps)).resolves.toEqual({
      text: [
        "Codex diagnostics sent to OpenAI servers:",
        ...expectedDiagnosticsTargetBlock({
          channel: "test",
          sessionId: "session-1",
          threadId: "thread-cooldown",
        }),
        "Included Codex logs and spawned Codex subthreads when available.",
      ].join("\n"),
    });
    await expect(runCommand("diagnostics again", deps)).resolves.toEqual({
      text: "Codex diagnostics were already sent for thread thread-cooldown recently. Try again in 60s.",
    });
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(1);
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
    const safeCodexControlRequest = vi.fn(async () => ({ ok: true as const, value: {} }));
    for (const [index, scope] of scopes.entries()) {
      await writeTestBinding(sessionIdentity, { threadId: `thread-scope-${index}`, cwd: "/repo" });
      const request = await runCommand("diagnostics", { safeCodexControlRequest }, scope);
      const token = readDiagnosticsConfirmationToken(request);
      const result = await runCommand(
        `diagnostics confirm ${token}`,
        { safeCodexControlRequest },
        scope,
      );
      expect(result.text).toContain("Codex diagnostics sent to OpenAI servers:");
      expect(result.text).toContain(`Codex thread id: \`thread-scope-${index}\``);
    }
    expect(safeCodexControlRequest).toHaveBeenCalledTimes(2);
  });

  it("sanitizes a failed upload and permits a fresh diagnostics retry", async () => {
    const threadId = "thread-123'`\n\u009b\u202e; echo bad";
    await writeTestBinding(sessionIdentity, { threadId, cwd: "/repo" });
    const prefix = "bad\n\u009b\u202e <@U123> [trusted](https://evil) @here ";
    const padding = "x".repeat(499 - prefix.length);
    const safeCodexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: `${prefix}${padding}😀tail` })
      .mockResolvedValueOnce({ ok: true, value: { threadId } });
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
    await expect(runCommand("diagnostics")).resolves.toEqual({
      text: [
        "No Codex thread is attached to this OpenClaw session yet.",
        "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics.",
      ].join("\n"),
    });
  });

  it("escapes Codex MCP and skill list entries before chat display", async () => {
    const codexControlRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ name: "<@U123> [mcp](https://evil)" }] })
      .mockResolvedValueOnce({
        data: [
          {
            cwd: "/repo",
            skills: [
              {
                name: "skill_1 @here",
                description: "",
                path: "/repo/.codex/skills/skill_1/SKILL.md",
                scope: "repo",
                enabled: true,
              },
            ],
            errors: [],
          },
        ],
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
    const context = (args: string) =>
      createContext(args, undefined, {
        sessionKey: "agent:worker:session-1",
        sessionTarget: {
          agentId: "worker",
          sessionId: "session-1",
          sessionKey: "agent:worker:session-1",
          storePath,
        },
        getCurrentConversationBinding,
      });

    await handleCodexCommand(context("threads"), { deps });
    await handleCodexCommand(context("mcp"), { deps });
    await handleCodexCommand(context("skills"), { deps });
    await handleCodexCommand(context("account"), { deps });

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
      undefined,
      CODEX_CONTROL_METHODS.listThreads,
      { limit: 10 },
      expectedScope,
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      2,
      undefined,
      CODEX_CONTROL_METHODS.listMcpServers,
      { limit: 100 },
      expectedScope,
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      3,
      undefined,
      CODEX_CONTROL_METHODS.listSkills,
      {},
      expectedScope,
    );
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      1,
      undefined,
      CODEX_CONTROL_METHODS.account,
      { refreshToken: false },
      expectedScope,
    );
    expect(safeCodexControlRequest).toHaveBeenNthCalledWith(
      2,
      undefined,
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
    expect(codexControlRequest).toHaveBeenCalledWith(
      pluginConfig,
      CODEX_CONTROL_METHODS.listThreads,
      { limit: 10, searchTerm: "fix" },
      expect.objectContaining({
        authProfileId: null,
        startOptions: expect.objectContaining({ homeScope: "user" }),
      }),
    );
    expect(result.text).toContain(
      "- thread-123 - Fix the thing (gpt-5.4, /repo)\n  Resume: /codex resume thread-123",
    );
    expect(result.text).toContain("thread-123?\uff40bad\uff40");
    expect(result.text).toContain(
      "&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
    );
    expect(result.text).toContain("(gpt\uff3f5, /repo\uff3f\uff08x\uff09)");
    expect(result.text).toContain(
      "Resume: copy the thread id above and run /codex resume <thread-id>",
    );
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
    expect(result.text).not.toContain("Resume: /codex resume thread-123?");
  });

  it("reads, updates, and clears goals through the bound native Codex thread", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-goal", cwd: "/repo" });
    const goal = {
      threadId: "thread-goal",
      objective: "Ship native goals",
      status: "active",
      tokenBudget: null,
      tokensUsed: 120,
      timeUsedSeconds: 30,
      createdAt: 1,
      updatedAt: 2,
    };
    const codexControlRequest = vi.fn(
      async (_pluginConfig: unknown, method: string): Promise<JsonValue> => {
        if (method === CODEX_CONTROL_METHODS.clearThreadGoal) {
          return { cleared: true };
        }
        return { goal };
      },
    );
    const deps = createDeps({ codexControlRequest });

    await expect(runCommand("goal", deps)).resolves.toEqual({
      text: "Codex goal: Ship native goals\n- Status: active\n- Tokens: 120",
    });
    await expect(runCommand("goal set Ship native goals", deps)).resolves.toEqual({
      text: "Codex goal: Ship native goals\n- Status: active\n- Tokens: 120",
    });
    await expect(runCommand("goal set Refine native goals", deps)).resolves.toEqual({
      text: "Codex goal: Ship native goals\n- Status: active\n- Tokens: 120",
    });
    await expect(runCommand("goal clear", deps)).resolves.toEqual({
      text: "Cleared the Codex goal.",
    });

    expect(codexControlRequest).toHaveBeenNthCalledWith(
      1,
      undefined,
      CODEX_CONTROL_METHODS.getThreadGoal,
      { threadId: "thread-goal" },
      expect.any(Object),
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      2,
      undefined,
      CODEX_CONTROL_METHODS.setThreadGoal,
      { threadId: "thread-goal", objective: "Ship native goals" },
      expect.any(Object),
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      3,
      undefined,
      CODEX_CONTROL_METHODS.setThreadGoal,
      { threadId: "thread-goal", objective: "Refine native goals" },
      expect.any(Object),
    );
    expect(codexControlRequest).toHaveBeenNthCalledWith(
      4,
      undefined,
      CODEX_CONTROL_METHODS.clearThreadGoal,
      { threadId: "thread-goal" },
      expect.any(Object),
    );
  });

  it("recovers the predecessor binding before enabling fast mode", async () => {
    const sessionKey = "agent:main:test:first-fast";
    const storePath = path.join(tempDir, "explicit", `${sessionKey}.json`);
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "session-successor",
        previousSessionId: "session-predecessor",
        updatedAt: Date.now(),
        agentHarnessId: "codex",
      },
    });
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-predecessor", sessionKey },
      { threadId: "thread-first-control", cwd: "/repo", model: "gpt-5.4" },
    );

    await expect(
      runCommand(
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
      ),
    ).resolves.toEqual({ text: "Codex fast mode enabled." });
  });

  it("rejects a queued goal before any app-server write when the host rolls over", async () => {
    const runtime = await createCodexRuntimeContextOverrides(
      tempDir,
      "agent:main:test:queued-goal",
    );
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      },
      { threadId: "thread-queued-goal", cwd: "/repo" },
    );
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let appServerWrites = 0;
    const codexControlRequest = vi.fn(
      async (
        _pluginConfig: unknown,
        _method: string,
        _params: unknown,
        options?: CodexControlRequestOptions,
      ): Promise<JsonValue> => {
        entered.resolve();
        await release.promise;
        options?.assertCurrent?.();
        appServerWrites += 1;
        return { goal: null };
      },
    );

    const command = runCommand("goal", { codexControlRequest }, runtime);
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), command.then(() => "settled")]),
      ).toBe("entered");
      await upsertSessionEntry({
        storePath: runtime.sessionTarget.storePath,
        sessionKey: runtime.sessionKey,
        entry: {
          sessionId: "session-next",
          previousSessionId: "session-1",
          updatedAt: Date.now(),
          agentHarnessId: "codex",
        },
      });
      release.resolve();

      expect((await command).text).toContain("Codex session generation is no longer current");
      expect(appServerWrites).toBe(0);
    } finally {
      release.resolve();
      await command;
    }
  });

  it("rejects inherited object names as goal actions", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-goal", cwd: "/repo" });
    const codexControlRequest = vi.fn();

    await expect(runCommand("goal __proto__", { codexControlRequest })).resolves.toEqual({
      text: "Usage: /codex goal [status|set <objective>|pause|resume|block|complete|clear]",
    });
    expect(codexControlRequest).not.toHaveBeenCalled();
  });

  it("formats every Codex skill as a code-styled bullet and tolerates malformed entries", async () => {
    const malformedSkillEntries: JsonValue[] = [
      null,
      { description: "missing name" },
      {
        name: "final-skill",
        description: "Final skill",
        path: "/repo-b/.codex/skills/final-skill/SKILL.md",
        scope: "repo",
        enabled: true,
      },
    ];
    const codexControlRequest = vi.fn(async () => ({
      data: [
        {
          cwd: "/repo-a",
          skills: Array.from({ length: 26 }, (_, index) => ({
            name: `skill-${index + 1}`,
            description: `Skill ${index + 1}`,
            path: `/repo-a/.codex/skills/skill-${index + 1}/SKILL.md`,
            scope: "repo",
            enabled: true,
          })).concat({
            name: "disabled-skill",
            description: "Disabled skill",
            path: "/repo-a/.codex/skills/disabled-skill/SKILL.md",
            scope: "repo",
            enabled: false,
          }),
          errors: [{ path: "/repo-a/bad/SKILL.md", message: "bad skill" }],
        },
        {
          cwd: "/repo-b",
          skills: malformedSkillEntries,
          errors: [],
        },
        "malformed group",
      ],
    }));
    const deps = createDeps({ codexControlRequest });

    const result = await runCommand("skills", deps);

    expect(result.text).toContain("- `skill-1`");
    expect(result.text).toContain("- `skill-26`");
    expect(result.text).toContain("- `&lt;unknown&gt;`");
    expect(result.text).toContain("- `final-skill`");
    expect(result.text).not.toContain("Workspace:");
    expect(result.text).not.toContain("Error:");
    expect(result.text).not.toContain("More skills available");
    expect(result.text).not.toContain("Skill 1");
    expect(result.text).not.toContain("/repo-a/.codex/skills");
    expect(result.text).not.toContain("disabled-skill");
  });

  it("reports Codex skill load errors when no skills render", async () => {
    const codexControlRequest = vi.fn(async () => ({
      data: [
        {
          cwd: "/repo-a",
          skills: [
            {
              name: "disabled-skill",
              description: "Disabled skill",
              path: "/repo-a/.codex/skills/disabled-skill/SKILL.md",
              scope: "repo",
              enabled: false,
            },
          ],
          errors: [
            { path: "/repo-a/bad/SKILL.md", message: "bad skill <@U123>" },
            { path: "/repo-a/other/SKILL.md", message: "other bad skill @here" },
          ],
        },
      ],
    }));
    const deps = createDeps({ codexControlRequest });

    const result = await runCommand("skills", deps);

    expect(result.text).toBe("Codex skills: none returned (2 load errors).");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("@here");
  });

  it("returns sanitized command failures instead of leaking app-server errors", async () => {
    const runtime = await createCodexRuntimeContextOverrides(tempDir);
    await writeTestBinding(
      {
        kind: "session",
        agentId: "main",
        sessionId: "session-1",
        sessionKey: runtime.sessionKey,
      },
      { threadId: "thread-123", cwd: "/repo" },
    );
    const failure = () => {
      throw new Error("app-server failed <@U123> [trusted](https://evil) @here");
    };
    const expectSanitizedFailure = (result: PluginCommandResult) => {
      expect(result.text).toContain(
        "Codex command failed: app-server failed &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here",
      );
      expect(result.text).not.toContain("<@U123>");
      expect(result.text).not.toContain("[trusted](https://evil)");
      expect(result.text).not.toContain("@here");
    };

    for (const [args, deps] of [
      ["models", createDeps({ listCodexAppServerModels: vi.fn(failure) })],
      ["threads", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["mcp", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["skills", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["resume thread-123", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["review", createDeps({ codexControlRequest: vi.fn(failure) })],
      ["stop", createDeps({ stopCodexConversationTurn: vi.fn(failure) })],
      ["steer keep going", createDeps({ steerCodexConversationTurn: vi.fn(failure) })],
      ["model gpt-5.4", createDeps({ setCodexConversationModel: vi.fn(failure) })],
    ] as const) {
      expectSanitizedFailure(await runCommand(args, deps, runtime));
    }
    expectSanitizedFailure(
      await runCommand(
        "compact",
        {},
        {
          ...runtime,
          runtimeContext: { compactCurrent: vi.fn(failure) },
        },
      ),
    );
  });

  it("records an approved Codex bind intent without starting a thread", async () => {
    await writeTestBinding(sessionIdentity, {
      threadId: "thread-123",
      cwd: "/repo",
      authProfileId: "openai:work",
      modelProvider: "openai",
    });
    const requestConversationBinding = vi.fn(async (_request?: { summary?: string }) => ({
      status: "bound" as const,
      binding: publicConversationBinding(),
    }));

    await expect(
      runCommand(
        'bind "thread-123 <@U123>" --cwd "/repo [trusted](https://evil)" --model gpt-5.4 --provider openai',
        {
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        },
        {
          requestConversationBinding,
        },
      ),
    ).resolves.toEqual({
      text: "Bound this conversation to thread-123 &lt;\uff20U123&gt; in /repo \uff3btrusted\uff3d\uff08https://evil\uff09. The next message will initialize it.",
    });
    expect(requestConversationBinding).toHaveBeenCalledWith({
      summary:
        "Codex app-server thread thread-123 &lt;\uff20U123&gt; in /repo \uff3btrusted\uff3d\uff08https://evil\uff09",
      detachHint: "/codex detach",
      data: {
        kind: "codex-app-server-session",
        version: 2,
        bindingId: expect.any(String),
        workspaceDir: "/repo [trusted](https://evil)",
        agentId: "main",
        agentDir: path.join(tempDir, "agents", "main", "agent"),
        source: {
          agentId: "main",
          sessionId: "session-1",
          threadId: "thread-123",
        },
        start: {
          id: expect.any(String),
          threadId: "thread-123 <@U123>",
          model: "gpt-5.4",
          modelProvider: "openai",
          authProfileId: "openai:work",
        },
      },
    });
    expect(testCodexAppServerBindingStore.read(sessionIdentity)).toMatchObject({
      threadId: "thread-123",
    });
  });

  it("does not transfer a replacement session thread while recording bind intent", async () => {
    const identity = { kind: "session" as const, agentId: "main", sessionId: "session-1" };
    await writeTestBinding(identity, { threadId: "thread-old", cwd: "/repo" });
    let requestedData: Record<string, unknown> | undefined;
    const requestConversationBinding = vi.fn(
      async (request?: { data?: Record<string, unknown> }) => {
        requestedData = request?.data;
        await writeTestBinding(identity, { threadId: "thread-new", cwd: "/repo" });
        return {
          status: "bound" as const,
          binding: publicConversationBinding(),
        };
      },
    );

    await runCommand(
      "bind thread-target --cwd /repo",
      {},
      {
        requestConversationBinding,
      },
    );

    expect(requestedData).toMatchObject({
      source: {
        agentId: "main",
        sessionId: "session-1",
        threadId: "thread-old",
      },
    });
    expect(testCodexAppServerBindingStore.read(identity)).toMatchObject({
      threadId: "thread-new",
    });
  });

  it("reuses the existing owner for a lazy Codex rebind", async () => {
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      { threadId: "thread-old", cwd: "/old-repo", authProfileId: "openai:work" },
    );
    const requestConversationBinding = vi.fn(async () => ({
      status: "bound" as const,
      binding: publicConversationBinding(),
    }));
    const getCurrentConversationBinding = vi.fn(async () =>
      publicConversationBinding({
        kind: "codex-app-server-session",
        version: 2,
        bindingId: "binding-data-1",
        workspaceDir: "/old-repo",
      }),
    );

    await runCommand(
      "bind thread-456 --cwd /repo",
      { resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default") },
      {
        getCurrentConversationBinding,
        requestConversationBinding,
      },
    );

    expect(
      testCodexAppServerBindingStore.read({
        kind: "conversation",
        bindingId: "binding-data-1",
      }),
    ).toMatchObject({ threadId: "thread-old" });
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

  it("rejects bind options with missing, blank, or repeated values before starting Codex", async () => {
    const requestConversationBinding = vi.fn();

    await expect(
      runCommand(
        "bind thread-123 --cwd --model gpt-5.4",
        {
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        },
        {
          requestConversationBinding,
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    await expect(
      runCommand(
        'bind thread-123 --cwd ""',
        {
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        },
        {
          requestConversationBinding,
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    await expect(
      runCommand(
        "bind thread-123 --cwd /repo --cwd /other",
        {
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        },
        {
          requestConversationBinding,
        },
      ),
    ).resolves.toEqual({
      text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
    });
    expect(requestConversationBinding).not.toHaveBeenCalled();
  });

  it("returns the binding approval reply when conversation bind needs approval", async () => {
    await writeTestBinding(sessionIdentity, { threadId: "thread-before-approval", cwd: "/repo" });
    const reply = { text: "Approve this?" };
    const requestConversationBinding = vi.fn(async () => ({
      status: "pending" as const,
      approvalId: "approval-1",
      reply,
    }));
    await expect(
      runCommand(
        "bind",
        {
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        },
        {
          requestConversationBinding,
        },
      ),
    ).resolves.toEqual(reply);
    const request = mockArg(requestConversationBinding, 0, 0) as {
      data?: { bindingId?: string };
    };
    expect(
      testCodexAppServerBindingStore.read({
        kind: "conversation",
        bindingId: request.data?.bindingId ?? "missing",
      }),
    ).toBeUndefined();
    expect(testCodexAppServerBindingStore.read(sessionIdentity)).toMatchObject({
      threadId: "thread-before-approval",
    });
  });

  it("does not start Codex when conversation binding is rejected", async () => {
    const clearBinding = vi.fn(async () => true);

    await expect(
      runCommand(
        "bind",
        {
          bindingStore: { ...testCodexAppServerBindingStore, mutate: clearBinding },
          resolveCodexDefaultWorkspaceDir: vi.fn(() => "/default"),
        },
        {
          requestConversationBinding: async () => ({
            status: "error",
            message: "binding unsupported <@U123> [trusted](https://evil)",
          }),
        },
      ),
    ).resolves.toEqual({
      text: "binding unsupported &lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09",
    });
    expect(clearBinding).not.toHaveBeenCalled();
  });

  it("stops the active bound Codex turn in sandboxed sessions", async () => {
    const stopCodexConversationTurn = vi.fn(async () => ({
      stopped: true,
      message: "Codex stop requested.",
    }));

    await expect(
      runCommand("stop", { stopCodexConversationTurn }, sandboxContext()),
    ).resolves.toEqual({ text: "Codex stop requested." });
    expect(stopCodexConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          kind: "session",
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "sandboxed-session",
        },
      }),
    );
  });

  it("uses the admitted explicit store for model and permission reads and writes", async () => {
    const sessionKey = "agent:main:test:explicit-control-store";
    const storePath = path.join(tempDir, "explicit", "sessions.json");
    const configuredStorePath = path.join(tempDir, "configured", "sessions.json");
    for (const [targetStore, model, permissionMode] of [
      [storePath, "gpt-5.4", "full"],
      [configuredStorePath, "configured-model", "guarded"],
    ] as const) {
      await upsertSessionEntry({
        storePath: targetStore,
        sessionKey,
        entry: {
          sessionId: "session-1",
          updatedAt: Date.now(),
          model,
          permissionMode,
          agentHarnessId: "codex",
        },
      });
    }
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1", sessionKey },
      { threadId: "thread-explicit-store", cwd: "/repo", model: "native-model" },
    );
    const context = {
      config: { session: { store: configuredStorePath } },
      sessionKey,
      sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
    };

    const modelStatus = await runCommand("model", {}, context);
    const permissionStatus = await runCommand("permissions status", {}, context);
    await runCommand("model gpt-5.5", {}, context);
    await runCommand("permissions default", {}, context);

    expect(modelStatus.text).toBe("Codex model: gpt-5.4");
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

  it("rejects a permission write after host rollover without requiring a native binding", async () => {
    const runtime = await createCodexRuntimeContextOverrides(
      tempDir,
      "agent:main:test:permission-no-binding",
    );
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    let writes = 0;
    const setCodexConversationPermissions = vi.fn(
      async (params: { assertCurrent?: () => void }) => {
        entered.resolve();
        await release.promise;
        params.assertCurrent?.();
        writes += 1;
        return "Codex permissions set to guarded.";
      },
    );

    const command = runCommand("permissions default", { setCodexConversationPermissions }, runtime);
    try {
      expect(
        await Promise.race([entered.promise.then(() => "entered"), command.then(() => "settled")]),
      ).toBe("entered");
      await upsertSessionEntry({
        storePath: runtime.sessionTarget.storePath,
        sessionKey: runtime.sessionKey,
        entry: {
          sessionId: "session-next",
          previousSessionId: "session-1",
          updatedAt: Date.now(),
          agentHarnessId: "codex",
        },
      });
      release.resolve();

      expect((await command).text).toContain("Codex session generation is no longer current");
      expect(writes).toBe(0);
    } finally {
      release.resolve();
      await command;
    }
  });

  it("updates a bound conversation without changing its ambient outer session", async () => {
    const sessionKey = "agent:main:session-1";
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        agentRuntimeOverride: "claude-cli",
        authProfileOverride: "anthropic:personal",
        authProfileOverrideSource: "user",
      },
    });
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      { threadId: "thread-conversation", cwd: "/repo", model: "gpt-5.4", modelProvider: "openai" },
    );
    const getCurrentConversationBinding = async () =>
      publicConversationBinding({
        kind: "codex-app-server-session" as const,
        version: 2 as const,
        bindingId: "binding-data-1",
        workspaceDir: "/repo",
      });

    await expect(
      runCommand(
        "model gpt-5.5",
        {},
        {
          sessionKey,
          getCurrentConversationBinding,
        },
      ),
    ).resolves.toEqual({ text: "Codex model set to gpt-5.5." });

    expect(
      testCodexAppServerBindingStore.read({ kind: "conversation", bindingId: "binding-data-1" }),
    ).toMatchObject({
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

  it.each([
    {
      name: "rejects owner yolo without admin scope",
      mode: "yolo",
      senderIsOwner: true,
      gatewayClientScopes: ["operator.write"],
      initialPermissionMode: undefined,
      expectedText:
        "Full Codex permissions require operator.admin. Choose Admin in the Control UI permission picker, or use an admin-authenticated CLI.",
      expectedPermissionMode: undefined,
    },
    {
      name: "persists yolo with admin scope",
      mode: "yolo",
      senderIsOwner: false,
      gatewayClientScopes: ["operator.admin"],
      initialPermissionMode: undefined,
      expectedText: "Codex permissions set to full access.",
      expectedPermissionMode: "full",
    },
    {
      name: "persists explicit guarded default for an owner without admin scope",
      mode: "default",
      senderIsOwner: true,
      gatewayClientScopes: ["operator.write"],
      initialPermissionMode: "full",
      expectedText: "Codex permissions set to guarded.",
      expectedPermissionMode: "guarded",
    },
  ] as const)("$name", async (testCase) => {
    const sessionKey = `agent:main:test:permissions-${testCase.mode}`;
    const storePath = path.join(tempDir, "permission-sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        sessionRoot: tempDir,
        ...(testCase.initialPermissionMode
          ? { permissionMode: testCase.initialPermissionMode }
          : {}),
      },
    });

    const before = getSessionEntry({ sessionKey, storePath, readConsistency: "latest" });
    await expect(
      runCommand(
        `permissions ${testCase.mode}`,
        {},
        {
          config: { session: { store: storePath } },
          sessionKey,
          senderIsOwner: testCase.senderIsOwner,
          gatewayClientScopes: [...testCase.gatewayClientScopes],
        },
      ),
    ).resolves.toEqual({ text: testCase.expectedText });
    const after = getSessionEntry({ sessionKey, storePath, readConsistency: "latest" });
    expect(after?.permissionMode).toBe(testCase.expectedPermissionMode);
    expect(after?.sessionRoot).toBe(tempDir);
    if (!testCase.expectedPermissionMode) {
      expect(after).toEqual(before);
    }
  });

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
      await expect(
        runCommand(args, deps, {
          ...locked,
          sessionTarget,
          detachConversationBinding,
          getCurrentConversationBinding,
          requestConversationBinding,
        }),
      ).resolves.toEqual({ text: MODEL_SELECTION_LOCKED_MESSAGE });
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
      expectResultTextContains(result, "Refusing to replace supervised Codex thread");
    }

    expect(requestConversationBinding).not.toHaveBeenCalled();
    expect(codexControlRequest).not.toHaveBeenCalled();
    expect(resolveCodexCliSessionForBindingOnNode).not.toHaveBeenCalled();
  });

  it("reports the desired direct-session model before its stale native binding reloads", async () => {
    const sessionKey = "agent:main:diverged-model";
    const storePath = resolveStorePath(undefined, { agentId: "main" });
    await upsertSessionEntry({
      agentId: "main",
      storePath,
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        modelOverride: "model_<@U123>_[trusted](https://evil)",
      },
    });
    await writeTestBinding(
      { kind: "session", agentId: "main", sessionId: "session-1", sessionKey },
      { threadId: "thread-diverged", cwd: "/repo", model: "bound-model" },
    );

    await expect(runCommand("model", {}, { sessionId: "session-1", sessionKey })).resolves.toEqual({
      text: "Codex model: model\uff3f&lt;\uff20U123&gt;\uff3f\uff3btrusted\uff3d\uff08https://evil\uff09",
    });
  });

  it.each([
    { boundModel: "bound-model", expected: "Codex model: bound-model" },
    { boundModel: undefined, expected: "Usage: /codex model <model>" },
  ])("keeps conversation model status independent from its ambient session", async (testCase) => {
    const sessionKey = "agent:main:conversation-model";
    await upsertSessionEntry({
      agentId: "main",
      storePath: resolveStorePath(undefined, { agentId: "main" }),
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        modelOverride: "outer-override-model",
      },
    });
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      {
        threadId: "thread-conversation",
        cwd: "/repo",
        ...(testCase.boundModel ? { model: testCase.boundModel } : {}),
      },
    );

    const result = await runCommand(
      "model",
      {},
      {
        sessionKey,
        getCurrentConversationBinding: async () =>
          publicConversationBinding({
            kind: "codex-app-server-session",
            version: 2,
            bindingId: "binding-data-1",
            workspaceDir: tempDir,
          }),
      },
    );

    expect(result).toEqual({ text: testCase.expected });
  });

  it("reports a conversation-bound model without an OpenClaw session identity", async () => {
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      { threadId: "thread-conversation", cwd: "/repo", model: "bound-model" },
    );

    const result = await runCommand(
      "model",
      {},
      {
        sessionId: undefined,
        sessionKey: undefined,
        getCurrentConversationBinding: async () =>
          publicConversationBinding({
            kind: "codex-app-server-session",
            version: 2,
            bindingId: "binding-data-1",
            workspaceDir: tempDir,
          }),
      },
    );

    expect(result).toEqual({ text: "Codex model: bound-model" });
  });

  it("rejects malformed control arguments before requiring a session file", async () => {
    const deps = createDeps({
      setCodexConversationModel: vi.fn(),
      setCodexConversationFastMode: vi.fn(),
      setCodexConversationPermissions: vi.fn(),
    });

    await expect(runCommand("model gpt-5.4 extra", deps)).resolves.toEqual({
      text: "Usage: /codex model <model>",
    });
    await expect(runCommand("fast on now", deps)).resolves.toEqual({
      text: "Usage: /codex fast [on|off|status]",
    });
    await expect(runCommand("permissions yolo now", deps)).resolves.toEqual({
      text: "Usage: /codex permissions [default|yolo|status]",
    });
    expect(deps.setCodexConversationModel).not.toHaveBeenCalled();
    expect(deps.setCodexConversationFastMode).not.toHaveBeenCalled();
    expect(deps.setCodexConversationPermissions).not.toHaveBeenCalled();
  });

  it("describes active binding preferences from the admitted store", async () => {
    const sessionKey = "agent:main:binding-preferences";
    const storePath = path.join(tempDir, "explicit", "sessions.json");
    const configuredStorePath = path.join(tempDir, "configured", "sessions.json");
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "session-1", updatedAt: Date.now(), permissionMode: "full" },
    });
    await upsertSessionEntry({
      storePath: configuredStorePath,
      sessionKey,
      entry: { sessionId: "session-1", updatedAt: Date.now(), permissionMode: "guarded" },
    });
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      {
        threadId: "thread-123",
        cwd: "/repo",
        model: "gpt-5.4",
        serviceTier: "fast",
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      },
    );

    await expect(
      runCommand(
        "binding",
        {
          readCodexConversationActiveTurn: vi.fn(() => ({
            identity: { kind: "conversation" as const, bindingId: "binding-data-1" },
            client: { request: vi.fn() } as never,
            requestTimeoutMs: 60_000,
            threadId: "thread-123",
            turnId: "turn-1",
            interrupt: vi.fn(),
            steer: vi.fn(),
          })),
        },
        {
          sessionKey,
          config: { session: { store: configuredStorePath } },
          sessionTarget: { agentId: "main", sessionId: "session-1", sessionKey, storePath },
          getCurrentConversationBinding: async () =>
            publicConversationBinding({
              kind: "codex-app-server-session",
              version: 2,
              bindingId: "binding-data-1",
              workspaceDir: "/repo",
            }),
        },
      ),
    ).resolves.toEqual({
      text: [
        "Codex conversation binding:",
        "- Thread: thread-123",
        "- Workspace: /repo",
        "- Model: gpt-5.4",
        "- Fast: on",
        "- Permissions: full access",
        "- Active run: turn-1",
        "- Binding: binding-data-1",
      ].join("\n"),
    });
  });

  it("escapes active binding fields before chat display", async () => {
    await writeTestBinding(
      { kind: "conversation", bindingId: "binding-data-1" },
      {
        threadId: "thread-123 <@U123>",
        cwd: "/repo",
        model: "gpt [trusted](https://evil)",
      },
    );

    const result = await runCommand(
      "binding",
      {},
      {
        getCurrentConversationBinding: async () =>
          publicConversationBinding({
            kind: "codex-app-server-session",
            version: 2,
            bindingId: "binding-data-1",
            workspaceDir: "/repo <@U123>",
          }),
      },
    );

    expect(result.text).toContain("Thread: thread-123 &lt;\uff20U123&gt;");
    expect(result.text).toContain("Workspace: /repo &lt;\uff20U123&gt;");
    expect(result.text).toContain("Model: gpt \uff3btrusted\uff3d\uff08https://evil\uff09");
    expect(result.text).not.toContain("<@U123>");
    expect(result.text).not.toContain("[trusted](https://evil)");
  });
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
    installation: {
      status: "installed",
      ok: true,
      message: "Computer Use plugin is installed and enabled.",
    },
    exposure: {
      status: "available",
      ok: true,
      message: "Computer Use MCP server computer-use exposes 1 tools.",
    },
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
