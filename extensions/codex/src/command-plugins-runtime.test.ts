import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { upsertAuthProfileAsync } from "openclaw/plugin-sdk/provider-auth";
import { setRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveStorePath, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import { applyCodexAppServerAuthProfile } from "./app-server/auth-bridge.js";
import { refreshCodexAppRuntimeState } from "./app-server/plugin-activation.js";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import * as sharedClients from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { createCodexCommandHost } from "./command-host.test-support.js";
import { withCodexPluginCommandContext } from "./command-plugins-runtime.js";
import * as commandRpc from "./command-rpc.js";
import { createContext, useCodexControlTestState } from "./commands.test-support.js";

let root: string;
const clients: ReturnType<typeof createClientHarness>[] = [];
useCodexControlTestState({
  prefix: "codex-plugin-status-",
  realpath: true,
  restoreMocks: true,
  setup: (dir) => {
    root = dir;
  },
  cleanup: () => {
    for (const harness of clients.splice(0)) {
      harness.client.close();
    }
    vi.useRealTimers();
  },
});

function accountToken(accountId: string) {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.test-signature`;
}

async function fixture(stableAccount = true) {
  const agentDir = path.join(root, "agents", "second", "agent");
  const workspaceDir = path.join(root, "second-workspace");
  await upsertAuthProfileAsync({
    agentDir,
    profileId: "openai:second",
    credential: {
      type: "oauth",
      provider: "openai",
      access: stableAccount ? "test-access-token" : accountToken("test-second-account"),
      refresh: "test-refresh-token",
      expires: Date.now() + 24 * 60 * 60_000,
      ...(stableAccount ? { accountId: "test-second-account" } : {}),
    },
  });
  const deps = createCodexCommandHost({
    bindingStore: createCodexTestBindingStore(),
    codexPluginsManagementIo: {
      readConfig: async () => ({}),
      mutate: vi.fn(),
    },
  });
  const ctx = createContext("plugins status notes@company-tools", undefined, {
    config: {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        entries: { second: { agentDir, workspace: workspaceDir } },
      },
    },
    agentId: "second",
    sessionId: "session-original",
    sessionKey: "agent:second:chat",
  });
  setRuntimeConfigSnapshot(ctx.config);
  const writeSession = (sessionId = ctx.sessionId!, storePath?: string) =>
    upsertSessionEntry({
      agentId: "second",
      sessionKey: ctx.sessionKey!,
      storePath,
      entry: { sessionId, updatedAt: Date.now() },
    });
  await writeSession();
  const harness = createClientHarness();
  clients.push(harness);
  const run = <T>(
    callback: Parameters<typeof withCodexPluginCommandContext<T>>[1],
    pluginConfig: Parameters<typeof withCodexPluginCommandContext>[0]["pluginConfig"] = {},
  ) => withCodexPluginCommandContext({ deps, ctx, pluginConfig }, callback);
  return {
    deps,
    ctx,
    harness,
    acquire: vi
      .spyOn(sharedClients, "getLeasedSharedCodexAppServerClient")
      .mockResolvedValue(harness.client),
    release: vi
      .spyOn(sharedClients, "releaseLeasedSharedCodexAppServerClient")
      .mockReturnValue(true),
    request: vi.spyOn(harness.client, "request").mockResolvedValue({ apps: [] }),
    agentDir,
    workspaceDir,
    run,
    writeSession,
    installed: (forceRefresh = false, pluginConfig = {}) =>
      run(async (context) => context.request("app/installed", { forceRefresh }), pluginConfig),
    accountUpdated: () =>
      harness.send({
        method: "account/updated",
        params: { authMode: "chatgptAuthTokens", planType: "team" },
      }),
    readWrite: async (index: number) => JSON.parse(await harness.waitForWrite(index)),
  };
}

async function inspectPending(
  test: Awaited<ReturnType<typeof fixture>>,
  operation: Promise<unknown>,
  inspect: (failure: () => unknown, pending: Promise<unknown>) => Promise<void>,
  cleanup?: () => void,
) {
  let failure: unknown;
  const pending = operation.catch((error: unknown) => {
    failure = error;
  });
  try {
    await inspect(() => failure, pending);
  } finally {
    cleanup?.();
    test.harness.client.close();
    await pending;
  }
}

describe("Codex plugin command context", () => {
  it("rejects a token-derived account replaced during preparation", async () => {
    const test = await fixture(false);
    const prepare = commandRpc.prepareCodexControlSessionAuth;
    vi.spyOn(commandRpc, "prepareCodexControlSessionAuth").mockImplementation(async (...args) => {
      const auth = await prepare(...args);
      const profile =
        "authProfileStore" in auth.clientOptions
          ? auth.clientOptions.authProfileStore?.profiles["openai:second"]
          : undefined;
      if (profile?.type !== "oauth") {
        throw new Error("Expected the prepared fixture profile");
      }
      await upsertAuthProfileAsync({
        agentDir: test.agentDir,
        profileId: "openai:second",
        credential: { ...profile, access: accountToken("test-replacement-account") },
      });
      return auth;
    });
    await expect(test.run(async () => "stale result")).rejects.toThrow(
      "Codex account, conversation, or plugin policy changed",
    );
    expect(test.acquire).not.toHaveBeenCalled();
  });

  it("accepts delayed startup notifications for the same account", async () => {
    const test = await fixture();
    let pendingStartupNotification = true;
    test.acquire.mockImplementation(async () => {
      await applyCodexAppServerAuthProfile({
        client: test.harness.client,
        agentDir: test.agentDir,
        authProfileId: "openai:second",
        config: test.ctx.config,
      });
      return test.harness.client;
    });
    test.request.mockImplementation(async (method) => {
      if (method === "account/login/start") {
        return { type: "chatgptAuthTokens" };
      }
      if (pendingStartupNotification) {
        // Codex 0.150.1 replies to login before refreshing caches and notifying.
        pendingStartupNotification = false;
        test.harness.send({
          method: "account/login/completed",
          params: { loginId: null, success: true, error: null },
        });
        test.accountUpdated();
      }
      return { apps: [] };
    });
    await expect(test.installed()).resolves.toEqual({ apps: [] });
    expect(test.release).toHaveBeenCalledOnce();
  });

  it.each([
    ["account/read", {}, 60_000],
    ["app/installed", { appServer: { requestTimeoutMs: 30_000 } }, 30_000],
  ] as const)(
    "bounds unanswered %s by its operation deadline and releases its lease",
    async (unansweredMethod, pluginConfig, timeoutMs) => {
      const test = await fixture();
      test.request.mockRestore();
      // Install the clock before acquisition can create a deadline; leave filesystem work real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await inspectPending(test, test.installed(false, pluginConfig), async (failure) => {
        const startup = await test.readWrite(0);
        expect(startup.method).toBe("account/read");
        const startupDelayMs = unansweredMethod === "app/installed" ? 20_000 : 0;
        if (startupDelayMs) {
          await vi.advanceTimersByTimeAsync(startupDelayMs);
          test.harness.send({ id: startup.id, result: {} });
          expect((await test.readWrite(1)).method).toBe("app/installed");
        }
        await vi.advanceTimersByTimeAsync(timeoutMs - startupDelayMs + 1);
        expect(failure()).toBeInstanceOf(Error);
        expect(String(failure())).toMatch(/timed out|startup could not be confirmed/);
        expect(test.release).toHaveBeenCalledOnce();
      });
    },
  );

  it("releases a lease acquired after the deadline without sending a startup RPC", async () => {
    const test = await fixture();
    test.request.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const acquired = createDeferred<typeof test.harness.client>();
    const acquiring = createDeferred<void>();
    test.acquire.mockImplementation(() => {
      acquiring.resolve();
      return acquired.promise;
    });
    const run = vi.fn(async () => "unused");
    await inspectPending(
      test,
      test.run(run),
      async (failure) => {
        await acquiring.promise;
        await vi.advanceTimersByTimeAsync(600_001);
        acquired.resolve(test.harness.client);
        await vi.advanceTimersByTimeAsync(0);
        expect(failure()).toBeInstanceOf(Error);
        expect(failure()).toMatchObject({ name: "AgentHarnessPreflightError" });
        expect(test.harness.writes).toHaveLength(0);
        expect(run).not.toHaveBeenCalled();
        expect(test.release).toHaveBeenCalledOnce();
      },
      () => acquired.resolve(test.harness.client),
    );
  });

  it.each([
    { change: "account", response: "overload" },
    { change: "session", response: "overload" },
    { change: "account", response: "unanswered" },
  ])(
    "cancels a refresh with $response response after the $change changes without further writes",
    async ({ change, response }) => {
      const test = await fixture();
      test.request.mockRestore();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      await inspectPending(test, test.installed(true), async (failure, pending) => {
        const startup = await test.readWrite(0);
        test.harness.send({ id: startup.id, result: {} });
        const refresh = await test.readWrite(1);
        expect(refresh).toMatchObject({ method: "app/installed", params: { forceRefresh: true } });
        if (response === "overload") {
          test.harness.send({
            id: refresh.id,
            error: { code: -32001, message: "Server overloaded" },
          });
          await vi.advanceTimersByTimeAsync(0);
        }
        if (change === "account") {
          test.accountUpdated();
        } else {
          await test.writeSession(
            "session-after-reset",
            resolveStorePath(test.ctx.config.session?.store, { agentId: "second" }),
          );
        }
        await vi.advanceTimersByTimeAsync(response === "overload" ? 1_000 : 0);
        await pending;
        expect(test.harness.writes).toHaveLength(2);
        expect(String(failure())).toContain(
          change === "session"
            ? "Codex session generation is no longer current"
            : "Codex account, conversation, or plugin policy changed",
        );
        expect(test.release).toHaveBeenCalledOnce();
      });
    },
  );

  it.each([true, false])("exposes only this physical client's thread (%s)", async (sameClient) => {
    const test = await fixture();
    await test.deps.bindingStore.mutate(
      {
        kind: "session",
        agentId: "second",
        sessionId: "session-original",
        sessionKey: test.ctx.sessionKey,
      },
      {
        kind: "set",
        binding: {
          threadId: "owned-thread",
          clientId: sameClient ? test.harness.client.getInstanceId() : "retired-client",
          cwd: test.workspaceDir,
          authProfileId: "openai:second",
        },
      },
    );
    const threadId = await test.run(async (context) => context.threadId);
    expect(threadId).toBe(sameClient ? "owned-thread" : undefined);
  });

  it("rejects stale conversation refreshes without publishing and releases the client", async () => {
    const test = await fixture();
    const appCache = new CodexAppInventoryCache();
    let appCacheKey = "";
    const storePath = path.join(root, "explicit", "sessions.json");
    await test.writeSession(test.ctx.sessionId, storePath);
    test.ctx.sessionTarget = {
      agentId: "second",
      sessionId: test.ctx.sessionId!,
      sessionKey: test.ctx.sessionKey!,
      storePath,
    };
    test.ctx.getCurrentConversationBinding = async () => ({
      bindingId: "conversation-binding",
      pluginId: "codex",
      pluginRoot: root,
      channel: "test",
      accountId: "test-account",
      conversationId: "conversation",
      boundAt: 1,
      data: {
        kind: "codex-app-server-session",
        version: 2,
        bindingId: "conversation-binding",
        workspaceDir: test.workspaceDir,
        agentId: "second",
      },
    });
    test.request.mockImplementation(async (method) => {
      if (method !== "app/installed") {
        return {};
      }
      await test.writeSession("session-after-reset", storePath);
      return { apps: [] };
    });
    await expect(
      test.run(async (context) => {
        appCacheKey = context.appCacheKey;
        await refreshCodexAppRuntimeState({ ...context, appCache });
      }),
    ).rejects.toThrow("Codex session generation is no longer current");
    expect(
      appCache.read({
        key: appCacheKey,
        request: (method, params) => test.harness.client.request(method, params),
        suppressRefresh: true,
      }).snapshot,
    ).toBeUndefined();
    expect(test.release).toHaveBeenCalledOnce();
  });
});
