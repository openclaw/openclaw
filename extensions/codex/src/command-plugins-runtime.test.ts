import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearSessionStoreCacheForTest,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import { applyCodexAppServerAuthProfile } from "./app-server/auth-bridge.js";
import { refreshCodexAppRuntimeState } from "./app-server/plugin-activation.js";
import { createCodexTestBindingStore } from "./app-server/session-binding.test-helpers.js";
import * as sharedClients from "./app-server/shared-client.js";
import { createClientHarness } from "./app-server/test-support.js";
import { resolveCodexCommandDeps } from "./command-handler-deps.js";
import { withCodexPluginCommandContext } from "./command-plugins-runtime.js";
import * as commandRpc from "./command-rpc.js";

let root: string;
let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;
const clients: ReturnType<typeof createClientHarness>[] = [];

beforeEach(async () => {
  previousPluginRegistry = getActivePluginRegistry();
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "openai",
    provider: { id: "openai", label: "OpenAI", auth: [] },
    source: "test",
  });
  setActivePluginRegistry(registry);
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-plugin-status-")));
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENAI_API_KEY", undefined);
  vi.stubEnv("CODEX_API_KEY", undefined);
});

afterEach(async () => {
  if (previousPluginRegistry) {
    setActivePluginRegistry(previousPluginRegistry);
  } else {
    resetPluginRuntimeStateForTest();
  }
  for (const harness of clients.splice(0)) {
    harness.client.close();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearRuntimeAuthProfileStoreSnapshots();
  clearSessionStoreCacheForTest();
  await fs.rm(root, { recursive: true, force: true });
});

async function fixture(stableAccount = true) {
  const agentDir = path.join(root, "agents", "second", "agent");
  const workspaceDir = path.join(root, "second-workspace");
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store: {
        version: 1,
        profiles: {
          "openai:second": {
            type: "oauth",
            provider: "openai",
            access: stableAccount
              ? "test-access-token"
              : `e30.${Buffer.from(
                  JSON.stringify({
                    "https://api.openai.com/auth": { chatgpt_account_id: "test-second-account" },
                  }),
                ).toString("base64url")}.test-signature`,
            refresh: "test-refresh-token",
            expires: Date.now() + 24 * 60 * 60_000,
            ...(stableAccount ? { accountId: "test-second-account" } : {}),
          },
        },
        order: { openai: ["openai:second"] },
      },
    },
  ]);
  const current = {
    enabled: true,
    plugins: { notes: { marketplaceName: "company-tools", pluginName: "notes", enabled: true } },
  };
  const bindingStore = createCodexTestBindingStore();
  const deps = resolveCodexCommandDeps({
    bindingStore,
    codexPluginsManagementIo: {
      readConfig: async () => structuredClone(current),
      mutate: vi.fn(),
    },
  });
  const ctx: PluginCommandContext = {
    config: {
      agents: {
        defaults: { model: { primary: "openai/gpt-5.5" } },
        list: [{ id: "second", agentDir, workspace: workspaceDir }],
      },
    },
    agentId: "second",
    sessionId: "session-original",
    sessionKey: "agent:second:chat",
    channel: "test",
    isAuthorizedSender: true,
    senderIsOwner: true,
    commandBody: "/codex plugins status notes@company-tools",
    getCurrentConversationBinding: async () => null,
    requestConversationBinding: async () => ({ status: "error", message: "unused" }),
    detachConversationBinding: async () => ({ removed: false }),
  };
  await upsertSessionEntry({
    agentId: "second",
    sessionKey: ctx.sessionKey!,
    entry: { sessionId: ctx.sessionId!, updatedAt: Date.now() },
  });
  const harness = createClientHarness();
  clients.push(harness);
  const acquire = vi
    .spyOn(sharedClients, "getLeasedSharedCodexAppServerClient")
    .mockResolvedValue(harness.client);
  const release = vi
    .spyOn(sharedClients, "releaseLeasedSharedCodexAppServerClient")
    .mockReturnValue(true);
  const request = vi.spyOn(harness.client, "request").mockResolvedValue({ apps: [] });
  return { deps, ctx, harness, acquire, release, request, current, agentDir, workspaceDir };
}

describe("Codex plugin command context", () => {
  it("can inspect a runtime without plugin management configuration", async () => {
    const test = await fixture();
    test.deps.codexPluginsManagementIo = undefined;
    const current = await withCodexPluginCommandContext(
      { ...test, pluginConfig: {} },
      async (context) => {
        await context.validateCurrent();
        return context.current;
      },
    );
    expect(current).toEqual({});
    expect(test.release).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    "rejects an account replaced during preparation (stored account %s)",
    async (stableAccount) => {
      const test = await fixture(stableAccount);
      const prepare = commandRpc.prepareCodexControlSessionAuth;
      vi.spyOn(commandRpc, "prepareCodexControlSessionAuth").mockImplementation(async (...args) => {
        const auth = await prepare(...args);
        const store =
          "authProfileStore" in auth.clientOptions
            ? structuredClone(auth.clientOptions.authProfileStore)
            : undefined;
        const profile = store?.profiles["openai:second"];
        if (!store || profile?.type !== "oauth") {
          throw new Error("Expected the prepared fixture profile");
        }
        if (stableAccount) {
          profile.accountId = "test-replacement-account";
        } else {
          profile.access = `e30.${Buffer.from(
            JSON.stringify({
              "https://api.openai.com/auth": { chatgpt_account_id: "test-replacement-account" },
            }),
          ).toString("base64url")}.test-signature`;
        }
        replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: test.agentDir, store }]);
        return auth;
      });
      await expect(
        withCodexPluginCommandContext({ ...test, pluginConfig: {} }, async () => "stale result"),
      ).rejects.toThrow("Codex account, conversation, or plugin policy changed");
      expect(test.acquire).not.toHaveBeenCalled();
    },
  );

  it("accepts delayed startup notifications for the unchanged managed account", async () => {
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
        test.harness.send({
          method: "account/updated",
          params: { authMode: "chatgptAuthTokens", planType: "team" },
        });
      }
      return { apps: [] };
    });
    await expect(
      withCodexPluginCommandContext({ ...test, pluginConfig: {} }, async (context) =>
        context.request("app/installed", { forceRefresh: false }),
      ),
    ).resolves.toEqual({ apps: [] });
    expect(test.request).toHaveBeenCalledWith(
      "account/login/start",
      expect.objectContaining({ type: "chatgptAuthTokens" }),
      { assertCurrent: undefined },
    );
    expect(test.release).toHaveBeenCalledOnce();
  });

  it("releases the lease when the startup account barrier fails", async () => {
    const test = await fixture();
    test.request.mockRejectedValue(new Error("private provider failure"));
    await expect(
      withCodexPluginCommandContext({ ...test, pluginConfig: {} }, async () => "unused"),
    ).rejects.toThrow("Codex account startup could not be confirmed");
    expect(test.release).toHaveBeenCalledOnce();
  });

  it.each([
    { unansweredMethod: "account/read", pluginConfig: {}, timeoutMs: 60_000 },
    {
      unansweredMethod: "app/installed",
      pluginConfig: { appServer: { requestTimeoutMs: 30_000 } },
      timeoutMs: 30_000,
    },
  ])(
    "bounds an unanswered $unansweredMethod RPC by the $timeoutMs ms operation deadline and releases its lease",
    async ({ unansweredMethod, pluginConfig, timeoutMs }) => {
      const test = await fixture();
      test.request.mockRestore();
      // Install the clock before acquisition can create a deadline; leave filesystem work real.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let failure: unknown;
      const pending = withCodexPluginCommandContext({ ...test, pluginConfig }, async (context) =>
        context.request("app/installed", { forceRefresh: false }),
      ).catch((error: unknown) => {
        failure = error;
      });
      try {
        const startup = JSON.parse(await test.harness.waitForWrite(0));
        expect(startup.method).toBe("account/read");
        const startupDelayMs = unansweredMethod === "app/installed" ? 20_000 : 0;
        if (startupDelayMs) {
          await vi.advanceTimersByTimeAsync(startupDelayMs);
          test.harness.send({ id: startup.id, result: {} });
          expect(JSON.parse(await test.harness.waitForWrite(1)).method).toBe("app/installed");
        }
        await vi.advanceTimersByTimeAsync(timeoutMs - startupDelayMs + 1);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toMatch(/timed out|startup could not be confirmed/);
        expect(test.release).toHaveBeenCalledOnce();
      } finally {
        test.harness.client.close();
        await pending;
      }
    },
  );

  it("releases a lease acquired after the deadline without sending a startup RPC", async () => {
    const test = await fixture();
    test.request.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let finishAcquisition!: (client: typeof test.harness.client) => void;
    const acquired = new Promise<typeof test.harness.client>((resolve) => {
      finishAcquisition = resolve;
    });
    let signalAcquiring!: () => void;
    const acquiring = new Promise<void>((resolve) => {
      signalAcquiring = resolve;
    });
    test.acquire.mockImplementation(() => {
      signalAcquiring();
      return acquired;
    });
    let failure: unknown;
    const run = vi.fn(async () => "unused");
    const pending = withCodexPluginCommandContext({ ...test, pluginConfig: {} }, run).catch(
      (error: unknown) => {
        failure = error;
      },
    );
    try {
      await acquiring;
      await vi.advanceTimersByTimeAsync(60_001);
      finishAcquisition(test.harness.client);
      await vi.advanceTimersByTimeAsync(0);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("timed out");
      expect(test.harness.writes).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
      expect(test.release).toHaveBeenCalledOnce();
    } finally {
      finishAcquisition(test.harness.client);
      test.harness.client.close();
      await pending;
    }
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
      let failure: unknown;
      const pending = withCodexPluginCommandContext(
        { ...test, pluginConfig: {} },
        async (context) => context.request("app/installed", { forceRefresh: true }),
      ).catch((error: unknown) => {
        failure = error;
      });
      try {
        const startup = JSON.parse(await test.harness.waitForWrite(0));
        test.harness.send({ id: startup.id, result: {} });
        const refresh = JSON.parse(await test.harness.waitForWrite(1));
        expect(refresh).toMatchObject({ method: "app/installed", params: { forceRefresh: true } });
        if (response === "overload") {
          test.harness.send({
            id: refresh.id,
            error: { code: -32001, message: "Server overloaded" },
          });
          await vi.advanceTimersByTimeAsync(0);
        }
        if (change === "account") {
          test.harness.send({
            method: "account/updated",
            params: { authMode: "chatgptAuthTokens", planType: "team" },
          });
        } else {
          await upsertSessionEntry({
            storePath: resolveStorePath(test.ctx.config.session?.store, { agentId: "second" }),
            sessionKey: test.ctx.sessionKey!,
            entry: { sessionId: "session-after-reset", updatedAt: 1 },
          });
        }
        await vi.advanceTimersByTimeAsync(response === "overload" ? 1_000 : 0);
        expect(test.harness.writes).toHaveLength(2);
        expect(String(failure)).toContain(
          change === "session"
            ? "Codex session generation is no longer current"
            : "Codex account, conversation, or plugin policy changed",
        );
        expect(test.release).toHaveBeenCalledOnce();
      } finally {
        test.harness.client.close();
        await pending;
      }
    },
  );

  it.each([true, false])(
    "uses the selected profile partition with stable account %s",
    async (stableAccount) => {
      const test = await fixture(stableAccount);
      await withCodexPluginCommandContext({ ...test, pluginConfig: {} }, async (context) => {
        expect(context.agentId).toBe("second");
        expect(context.profileId).toBe("openai:second");
        expect(context.workspaceDir).toBe(test.workspaceDir);
        expect(context.threadId).toBeUndefined();
        const prepared = test.acquire.mock.calls[0]?.[0]?.preparedAuth;
        expect(prepared?.kind).toBe("profile");
        expect(JSON.parse(context.appCacheKey)).toMatchObject({
          authProfileId: "openai:second",
          accountId: prepared?.kind === "profile" ? prepared.snapshot?.secretFreeCacheKey : null,
        });
        await context.request("app/installed", { forceRefresh: false });
      });
      expect(test.acquire).toHaveBeenCalledOnce();
      expect(test.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          agentDir: test.agentDir,
          preparedAuth: expect.objectContaining({ kind: "profile", profileId: "openai:second" }),
          authRequirement: "subscription",
          authBindingFingerprint: expect.any(String),
        }),
      );
      expect(test.release).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "only exposes a thread owned by this physical client (%s)",
    async (sameClient) => {
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
      const threadId = await withCodexPluginCommandContext(
        { ...test, pluginConfig: {} },
        async (context) => context.threadId,
      );
      expect(threadId).toBe(sameClient ? "owned-thread" : undefined);
    },
  );

  it.each(["policy", "account", "session", "conversation session"] as const)(
    "does not publish a refresh response after %s changes and releases the client",
    async (change) => {
      const test = await fixture();
      const appCache = new CodexAppInventoryCache();
      let appCacheKey = "";
      const storePath =
        change === "conversation session"
          ? path.join(root, "explicit", "sessions.json")
          : resolveStorePath(test.ctx.config.session?.store, { agentId: "second" });
      if (change === "conversation session") {
        await upsertSessionEntry({
          agentId: "second",
          storePath,
          sessionKey: test.ctx.sessionKey!,
          entry: { sessionId: test.ctx.sessionId!, updatedAt: Date.now() },
        });
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
      }
      test.request.mockImplementation(async (method) => {
        if (method !== "app/installed") {
          return {};
        }
        if (change === "policy") {
          test.current.plugins.notes.enabled = false;
        }
        if (change === "account") {
          test.harness.send({
            method: "account/updated",
            params: { authMode: "chatgptAuthTokens", planType: "team" },
          });
        }
        if (change === "session" || change === "conversation session") {
          await upsertSessionEntry({
            agentId: "second",
            storePath,
            sessionKey: test.ctx.sessionKey!,
            entry: { sessionId: "session-after-reset", updatedAt: 1 },
          });
        }
        return { apps: [] };
      });
      await expect(
        withCodexPluginCommandContext({ ...test, pluginConfig: {} }, async (context) => {
          appCacheKey = context.appCacheKey;
          await refreshCodexAppRuntimeState({
            request: context.request,
            appCache,
            appCacheKey,
          });
        }),
      ).rejects.toThrow(
        change === "session" || change === "conversation session"
          ? "Codex session generation is no longer current"
          : "Codex account, conversation, or plugin policy changed",
      );
      expect(
        appCache.read({
          key: appCacheKey,
          request: (method, params) => test.harness.client.request(method, params),
          suppressRefresh: true,
        }).snapshot,
      ).toBeUndefined();
      expect(test.release).toHaveBeenCalledOnce();
    },
  );
});
