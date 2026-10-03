import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { listAllCodexAppServerModels } from "./models.js";
import { probeCodexNativeAuth } from "./native-auth.js";
import { withCodexAppServerJsonClient } from "./request.js";

vi.mock("./models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models.js")>()),
  listAllCodexAppServerModels: vi.fn(),
}));
vi.mock("./native-auth.js", () => ({ probeCodexNativeAuth: vi.fn() }));

const profiles = vi.hoisted((): { store: AuthProfileStore } => ({
  store: { version: 1, profiles: {} },
}));
vi.mock("./auth-profile.js", async () => {
  const { resolveAuthProfileOrder } = await import("openclaw/plugin-sdk/provider-auth");
  const { createCodexAuthProfileSelection } = await import("./auth-profile-selection.js");
  return createCodexAuthProfileSelection({
    ensureAuthProfileStore: () => profiles.store,
    resolveAuthProfileOrder,
  });
});

const rpc = vi.hoisted(() => ({
  request: vi.fn(),
  epoch: 0,
  client: { getServerVersion: (): string => "99.1.0" },
}));
vi.mock("./request.js", () => ({
  withCodexAppServerJsonClient: vi.fn(
    (_options: unknown, run: (request: unknown, client: unknown) => unknown) =>
      run(rpc.request, rpc.client),
  ),
}));
vi.mock("./shared-client.js", () => ({
  captureSharedCodexAppServerCatalogLifetime: () => {
    const epoch = rpc.epoch;
    return () => rpc.epoch === epoch;
  },
}));
let owner: ReturnType<typeof createCodexAppServerModelCatalog>;
let scheduler: ReturnType<typeof createTestPluginServiceScheduler>;
const loadCodexAppServerModelCatalog = (...args: Parameters<typeof owner.load>) =>
  owner.load(...args);
const nativePluginConfig = { appServer: { homeScope: "user" } };
const read = (overrides = {}, pluginConfig?: unknown) =>
  owner.read(
    { ...catalogParams, provider: "openai", modelId: "synthetic-opaque", ...overrides },
    pluginConfig,
  );
const listModelsMock = vi.mocked(listAllCodexAppServerModels);

const catalogParams = {
  config: {},
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
};

function opaqueCatalog() {
  return {
    models: [
      {
        id: "synthetic-opaque",
        model: "synthetic-opaque",
        inputModalities: ["text"],
        supportedReasoningEfforts: [],
      },
    ],
  };
}

describe("Codex app-server model catalog", () => {
  afterEach(async () => {
    await owner.dispose();
    await scheduler.stop();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = createTestPluginServiceScheduler();
    profiles.store = { version: 1, profiles: {} };
    vi.mocked(probeCodexNativeAuth).mockReset().mockResolvedValue({
      apiKey: "native-presence",
      source: "native login",
      mode: "api-key",
    });
    listModelsMock.mockReset();
    vi.mocked(withCodexAppServerJsonClient).mockClear();
    rpc.epoch += 1;
    rpc.request
      .mockReset()
      .mockResolvedValue({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    owner = createCodexAppServerModelCatalog("codex", () => scheduler);
  });

  it("keeps native picker models independent of a host transport", async () => {
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-reasoning-model",
          model: "codex-execution-model",
          displayName: "Synthetic reasoning model",
          inputModalities: ["text", "image", "unknown"],
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        {
          id: "synthetic-basic-model",
          model: "synthetic-basic-model",
          displayName: "Synthetic basic model",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });
    const catalog = await loadCodexAppServerModelCatalog(catalogParams, undefined);
    expect(catalog).toEqual([
      {
        provider: "openai",
        nativeRuntime: "codex",
        id: "synthetic-reasoning-model",
        name: "Synthetic reasoning model",
        providerOrder: 0,
        reasoning: true,
        input: ["text", "image"],
        params: { codexAppServerRuntimeModel: "codex-execution-model" },
        compat: {
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      },
      {
        provider: "openai",
        nativeRuntime: "codex",
        id: "synthetic-basic-model",
        name: "Synthetic basic model",
        providerOrder: 1,
        reasoning: false,
        input: ["text"],
        compat: {
          supportsReasoningEffort: false,
          supportedReasoningEfforts: [],
        },
      },
    ]);
    expect(listModelsMock).toHaveBeenCalledExactlyOnceWith({
      request: rpc.request,
      limit: 100,
      includeHidden: true,
    });
    expect(vi.mocked(withCodexAppServerJsonClient).mock.calls[0]?.[0].startOptions?.homeScope).toBe(
      "agent",
    );
    expect(probeCodexNativeAuth).not.toHaveBeenCalled();
    expect(owner.readRuntimeVersion(catalogParams, undefined)).toBe("99.1.0");
    rpc.epoch++;
    expect(owner.readRuntimeVersion(catalogParams, undefined)).toBeUndefined();
  });

  it("returns no rows without a live call when discovery is disabled", async () => {
    expect(
      await loadCodexAppServerModelCatalog(catalogParams, { discovery: { enabled: false } }),
    ).toEqual([]);
    expect(listModelsMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "logged-out native account",
      nativeMode: undefined,
      homeScope: undefined,
      expectedHome: "agent",
      expectedProfile: "openai:work",
      accountType: "apiKey",
    },
    {
      name: "different native account",
      nativeMode: "oauth",
      homeScope: undefined,
      expectedHome: "agent",
      expectedProfile: "openai:work",
      accountType: "apiKey",
    },
    {
      name: "explicit native home",
      nativeMode: "oauth",
      homeScope: "user",
      expectedHome: "user",
      expectedProfile: undefined,
      accountType: "chatgpt",
    },
  ] as const)("keeps the selected account with a $name", async (scenario) => {
    profiles.store = {
      version: 1,
      profiles: {
        "openai:personal": { type: "api_key", provider: "openai", key: "synthetic-personal-key" },
        "openai:work": { type: "api_key", provider: "openai", key: "synthetic-work-key" },
      },
    };
    const params = {
      ...catalogParams,
      config: { auth: { order: { openai: ["openai:work", "openai:personal"] } } },
    };
    const pluginConfig = { appServer: { homeScope: scenario.homeScope } };
    vi.mocked(probeCodexNativeAuth).mockResolvedValue(
      scenario.nativeMode
        ? { apiKey: "native-presence", source: "native login", mode: scenario.nativeMode }
        : undefined,
    );
    rpc.request.mockResolvedValue({
      account: { type: scenario.accountType },
      requiresOpenaiAuth: true,
    });
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-account-model",
          model: "synthetic-account-model",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(await owner.load(params, pluginConfig)).toContainEqual(
      expect.objectContaining({ id: "synthetic-account-model" }),
    );
    const clientOptions = vi.mocked(withCodexAppServerJsonClient).mock.calls[0]?.[0];
    expect(clientOptions?.startOptions?.homeScope).toBe(scenario.expectedHome);
    expect(clientOptions?.authProfileId).toBe(scenario.expectedProfile);
    if (scenario.expectedProfile) {
      expect(clientOptions?.authProfileStore).toBe(profiles.store);
      expect(probeCodexNativeAuth).not.toHaveBeenCalled();
    } else {
      expect(probeCodexNativeAuth).toHaveBeenCalledOnce();
    }
  });

  it.each([
    {
      name: "Unix",
      appServer: { transport: "unix", url: "unix:///tmp/native-catalog.sock", homeScope: "user" },
      envArgs: undefined,
    },
    {
      name: "WebSocket",
      appServer: { transport: "websocket", url: "ws://127.0.0.1:12345", homeScope: "agent" },
      envArgs: undefined,
    },
    {
      name: "configured stdio proxy",
      appServer: {
        transport: "stdio",
        args: ["app-server", "proxy", "--sock", "/fixture/server.sock"],
      },
      envArgs: undefined,
    },
    {
      name: "environment-selected stdio proxy",
      appServer: { transport: "stdio" },
      envArgs: "app-server proxy --sock /fixture/server.sock",
    },
  ])(
    "uses the $name server account without probing a local login",
    async ({ appServer, envArgs }) => {
      vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_ARGS", envArgs);
      vi.mocked(probeCodexNativeAuth).mockResolvedValue(undefined);
      listModelsMock.mockResolvedValue({
        models: [
          {
            id: "synthetic-opaque",
            model: "synthetic-opaque",
            inputModalities: ["text"],
            supportedReasoningEfforts: [],
          },
        ],
      });
      const pluginConfig = { appServer };
      expect(await owner.load(catalogParams, pluginConfig)).toContainEqual(
        expect.objectContaining({ id: "synthetic-opaque", nativeRuntime: "codex" }),
      );
      expect(
        owner.read(
          { ...catalogParams, provider: "openai", modelId: "synthetic-opaque" },
          pluginConfig,
        ),
      ).toEqual({ accountType: "apiKey", authMode: "api_key" });
      expect(probeCodexNativeAuth).not.toHaveBeenCalled();
    },
  );

  it("uses the SIWC provider catalog after switching from a native API-key profile", async () => {
    const authOrder = ["openai:work", "openai:sharing"];
    profiles.store = {
      version: 1,
      profiles: {
        "openai:work": { type: "api_key", provider: "openai", key: "synthetic-work-key" },
        "openai:sharing": {
          type: "oauth",
          provider: "openai",
          authFlow: "chatgpt-token-sharing",
          access: "synthetic-scoped-access",
          refresh: "synthetic-refresh",
          expires: Date.now() + 60_000,
        },
      },
    };
    const params = {
      ...catalogParams,
      config: { auth: { order: { openai: authOrder } } },
    };
    listModelsMock.mockResolvedValue({
      models: [
        {
          id: "synthetic-native-only",
          model: "synthetic-native-only",
          inputModalities: ["text"],
          supportedReasoningEfforts: [],
        },
      ],
    });

    expect(await owner.load(params, undefined)).toContainEqual(
      expect.objectContaining({ id: "synthetic-native-only", nativeRuntime: "codex" }),
    );
    expect(
      owner.read({ ...params, provider: "openai", modelId: "synthetic-native-only" }, undefined),
    ).toEqual({ accountType: "apiKey", authMode: "api_key" });

    authOrder.reverse();
    expect(await owner.load(params, undefined)).toEqual([]);
    expect(listModelsMock).toHaveBeenCalledOnce();
    expect(withCodexAppServerJsonClient).toHaveBeenCalledOnce();
    expect(
      owner.read({ ...params, provider: "openai", modelId: "synthetic-native-only" }, undefined),
    ).toBeUndefined();
  });

  it.each(["oauth", "token"] as const)(
    "retains the observed native %s mode through discovery",
    async (mode) => {
      vi.mocked(probeCodexNativeAuth).mockResolvedValue({
        apiKey: "native-presence",
        source: "native login",
        mode,
      });
      rpc.request.mockResolvedValue({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      listModelsMock.mockResolvedValue({
        models: [
          {
            id: "synthetic-opaque",
            model: "synthetic-opaque",
            inputModalities: ["text"],
            supportedReasoningEfforts: [],
          },
        ],
      });
      await owner.load(catalogParams, nativePluginConfig);
      expect(read({}, nativePluginConfig)).toEqual({ accountType: "chatgpt", authMode: mode });
      rpc.epoch += 1;
      expect(read({}, nativePluginConfig)).toBeUndefined();
    },
  );

  it("discovers configured hidden models without exposing other hidden models or readiness", async () => {
    const models = ["visible", "configured", "other-agent", "unconfigured", "other-provider"].map(
      (name) => ({
        id: `synthetic-${name}`,
        model: `synthetic-${name}`,
        hidden: name !== "visible",
        inputModalities: ["text"],
        supportedReasoningEfforts: ["high", "ultra"],
      }),
    );
    listModelsMock.mockImplementation(async (options) => ({
      models: models.filter((model) => options?.includeHidden || !model.hidden),
    }));
    const params = {
      ...catalogParams,
      configuredModelRefs: [
        { provider: "openai", model: "synthetic-configured" },
        { provider: "another", model: "synthetic-other-provider" },
      ],
    };
    const catalog = await owner.load(params, undefined);
    expect(catalog.map((model) => model.id)).toEqual(["synthetic-visible", "synthetic-configured"]);
    expect(catalog[1]).toMatchObject({
      nativeRuntime: "codex",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "ultra"] },
    });
    expect(catalog[1]?.api).toBeUndefined();
    for (const model of models) {
      expect(read({ modelId: model.id })).toEqual(
        model.id === "synthetic-visible" || model.id === "synthetic-configured"
          ? { accountType: "apiKey", authMode: "api_key" }
          : undefined,
      );
    }
    await owner.load({ ...params, configuredModelRefs: [] }, undefined);
    expect(read({ modelId: "synthetic-configured" })).toBeUndefined();
  });

  it("bounds the live call with the configured discovery timeout", async () => {
    listModelsMock.mockResolvedValue({ models: [] });
    await loadCodexAppServerModelCatalog(catalogParams, { discovery: { timeoutMs: 750 } });
    expect(withCodexAppServerJsonClient).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 750 }),
      expect.any(Function),
    );
  });
  it.each([
    {
      account: { type: "apiKey" },
      mode: "apiKey",
      readiness: { accountType: "apiKey", authMode: "api_key" },
    },
    {
      account: { type: "chatgpt", email: "synthetic@example.test", planType: "plus" },
      mode: "chatgpt",
      readiness: { accountType: "chatgpt", authMode: "oauth" },
    },
    { account: null, mode: undefined, readiness: undefined },
  ])(
    "preserves account mode $mode without importing credentials",
    async ({ account, mode, readiness }) => {
      vi.mocked(probeCodexNativeAuth).mockResolvedValue({
        apiKey: "native-presence",
        source: "native login",
        mode: mode === "chatgpt" ? "oauth" : "api-key",
      });
      listModelsMock.mockResolvedValue(opaqueCatalog());
      rpc.request.mockResolvedValue({ account, requiresOpenaiAuth: true });
      await owner.load(catalogParams, nativePluginConfig);
      expect(read({}, nativePluginConfig)).toEqual(readiness);
      expect(read({ agentId: "another" }, nativePluginConfig)).toBeUndefined();
      expect(read({ agentDir: "/tmp/another-agent" }, nativePluginConfig)).toBeUndefined();
      expect(read({ workspaceDir: "/tmp/another-workspace" }, nativePluginConfig)).toBeUndefined();
      expect(read({ config: { ...catalogParams.config } }, nativePluginConfig)).toBeUndefined();
      expect(read({ modelId: "unlisted" }, nativePluginConfig)).toBeUndefined();
      expect(read({ provider: "another" }, nativePluginConfig)).toBeUndefined();
      expect(
        owner.read({ ...catalogParams, provider: "openai", modelId: "synthetic-opaque" }, {}),
      ).toBeUndefined();
      rpc.epoch += 1;
      expect(read({}, nativePluginConfig)).toBeUndefined();
    },
  );

  it("binds catalog and runtime metadata to an explicitly selected account without rotating to the default", async () => {
    profiles.store = {
      version: 1,
      profiles: {
        "openai:first": { type: "api_key", provider: "openai", key: "synthetic-first" },
        "openai:second": { type: "api_key", provider: "openai", key: "synthetic-second" },
      },
    };
    listModelsMock.mockResolvedValue(opaqueCatalog());
    const first = { ...catalogParams, authProfileId: "openai:first" };
    const second = { ...catalogParams, authProfileId: "openai:second" };
    await owner.load(first, undefined);
    expect(owner.readRuntimeVersion(second, undefined)).toBeUndefined();
    await owner.load(second, undefined);
    expect(withCodexAppServerJsonClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ authProfileId: "openai:second" }),
      expect.any(Function),
    );
    expect(owner.readRuntimeVersion(second, undefined)).toBe("99.1.0");
    await owner.load(second, undefined);
    expect(listModelsMock).toHaveBeenCalledTimes(2);
    expect(owner.readRuntimeVersion(second, { discovery: { enabled: false } })).toBeUndefined();
  });

  it.each(["accounts across configs", "scopes within one config"] as const)(
    "evicts stale observations when bounding %s without discovery on reads",
    async (kind) => {
      listModelsMock.mockResolvedValue(opaqueCatalog());
      await owner.load(catalogParams, undefined);
      let last = catalogParams;
      for (let i = 0; i < 128; i++) {
        last =
          kind === "accounts across configs"
            ? { ...catalogParams, config: {}, agentDir: `/tmp/catalog-account-${i}` }
            : { ...catalogParams, workspaceDir: `/tmp/catalog-workspace-${i}` };
        await owner.load(last, undefined);
      }
      const acquisitions = kind === "accounts across configs" ? 129 : 1;
      expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(acquisitions);
      expect(owner.readRuntimeVersion(catalogParams, undefined)).toBeUndefined();
      expect(read()).toBeUndefined();
      expect(owner.readRuntimeVersion(last, undefined)).toBe("99.1.0");
      expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(acquisitions);
      await owner.load(catalogParams, undefined);
      expect(owner.readRuntimeVersion(catalogParams, undefined)).toBe("99.1.0");
      expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(
        acquisitions + (kind === "accounts across configs" ? 1 : 0),
      );
    },
  );

  it("coalesces cold discovery per account and does not rerun login status on cached native reads", async () => {
    listModelsMock.mockResolvedValue(opaqueCatalog());
    const pending = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(pending.promise);
    const first = owner.load(catalogParams, nativePluginConfig);
    const peer = { ...catalogParams, agentId: "peer", agentDir: "/tmp/peer-agent" };
    const second = owner.load(peer, nativePluginConfig);
    try {
      await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
      pending.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
      expect(await first).toEqual(await second);
      expect(owner.readRuntimeVersion(peer, nativePluginConfig)).toBe("99.1.0");
      for (let i = 0; i < 20; i++) {
        await owner.load(catalogParams, nativePluginConfig);
      }
      expect(listModelsMock).toHaveBeenCalledOnce();
      expect(withCodexAppServerJsonClient).toHaveBeenCalledOnce();
      expect(probeCodexNativeAuth).toHaveBeenCalledOnce();
    } finally {
      pending.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
      await Promise.allSettled([first, second]);
    }
  });

  it.each(["older first", "newer first"])(
    "keeps the successor catalog after materialized SecretRef rotation (%s)",
    async (order) => {
      const credential = {
        type: "api_key" as const,
        provider: "openai",
        key: "synthetic-first",
        keyRef: { source: "env" as const, provider: "default", id: "SYNTHETIC_CATALOG_KEY" },
      };
      profiles.store.profiles["openai:work"] = credential;
      listModelsMock.mockResolvedValue(opaqueCatalog());
      const oldAccount = createDeferred<unknown>();
      const newAccount = createDeferred<unknown>();
      const account = { account: { type: "apiKey" }, requiresOpenaiAuth: true };
      rpc.request.mockReturnValueOnce(oldAccount.promise).mockReturnValueOnce(newAccount.promise);
      const older = owner.load(catalogParams, undefined);
      let newer: ReturnType<typeof owner.load> | undefined;
      try {
        await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
        profiles.store.profiles["openai:work"] = { ...credential, key: "synthetic-second" };
        newer = owner.load(catalogParams, undefined);
        await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledTimes(2));
        if (order === "older first") {
          oldAccount.resolve(account);
          expect(await older).toEqual([]);
          expect(read()).toBeUndefined();
        }
        newAccount.resolve(account);
        expect(await newer).toContainEqual(expect.objectContaining({ id: "synthetic-opaque" }));
        oldAccount.resolve(account);
        expect(await older).toEqual([]);
        expect(read()).toEqual({ accountType: "apiKey", authMode: "api_key" });
        expect(owner.readRuntimeVersion(catalogParams, undefined)).toBe("99.1.0");
        await owner.load(catalogParams, undefined);
        expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(2);
      } finally {
        oldAccount.resolve(account);
        newAccount.resolve(account);
        await Promise.allSettled([older, newer]);
      }
    },
  );

  it.each([false, true])(
    "binds discovery across OAuth refresh only to the same account (changed=%s)",
    async (changed) => {
      const credential = {
        type: "oauth" as const,
        provider: "openai",
        accountId: "synthetic-workspace",
        access: "synthetic-expired",
        refresh: "synthetic-refresh",
        expires: Date.now() - 1,
      };
      profiles.store.profiles["openai:work"] = credential;
      rpc.request.mockResolvedValue({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      listModelsMock.mockImplementation(async () => {
        profiles.store.profiles["openai:work"] = {
          ...credential,
          access: "synthetic-renewed",
          refresh: "synthetic-rotated",
          expires: Date.now() + 60_000,
          accountId: changed ? "synthetic-other-workspace" : credential.accountId,
        };
        return opaqueCatalog();
      });
      const result = await owner.load(catalogParams, undefined);
      if (changed) {
        expect(result).toEqual([]);
        expect(read()).toBeUndefined();
        expect(owner.readRuntimeVersion(catalogParams, undefined)).toBeUndefined();
      } else {
        expect(result).toContainEqual(expect.objectContaining({ id: "synthetic-opaque" }));
        expect(read()).toEqual({ accountType: "chatgpt" });
        expect(owner.readRuntimeVersion(catalogParams, undefined)).toBe("99.1.0");
        expect(await owner.load(catalogParams, undefined)).toEqual(result);
      }
      expect(withCodexAppServerJsonClient).toHaveBeenCalledOnce();
    },
  );

  it("partitions one account by native agent home and preserves each selected runtime version", async () => {
    profiles.store.profiles["openai:work"] = {
      type: "api_key",
      provider: "openai",
      key: "synthetic-shared-account",
    };
    listModelsMock.mockResolvedValue(opaqueCatalog());
    const second = { ...catalogParams, agentId: "other", agentDir: "/tmp/other-agent" };
    const version = vi.spyOn(rpc.client, "getServerVersion");
    await owner.load(catalogParams, undefined);
    version.mockReturnValue("99.2.0");
    await owner.load(second, undefined);
    expect(owner.readRuntimeVersion(catalogParams, undefined)).toBe("99.1.0");
    expect(owner.readRuntimeVersion(second, undefined)).toBe("99.2.0");
    expect(withCodexAppServerJsonClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ agentDir: second.agentDir }),
      expect.any(Function),
    );
    await owner.load(catalogParams, undefined);
    await owner.load(second, undefined);
    expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(2);
  });

  it.each(["background", "peer"] as const)(
    "revokes removed-model readiness in existing scopes after a successful %s refresh",
    async (refresh) => {
      const removed = opaqueCatalog().models[0]!;
      const retained = { ...removed, id: "synthetic-retained", model: "synthetic-retained" };
      listModelsMock.mockResolvedValue({ models: [removed, retained] });
      const peer = { ...catalogParams, agentId: "peer", agentDir: "/tmp/peer-agent" };
      await owner.load(catalogParams, nativePluginConfig);
      await owner.load(peer, nativePluginConfig);
      expect(read({}, nativePluginConfig)).toBeDefined();
      listModelsMock.mockResolvedValue({ models: [retained] });
      if (refresh === "background") {
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(await owner.load(catalogParams, nativePluginConfig)).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(0);
      } else {
        await owner.load({ ...peer, refresh: true }, nativePluginConfig);
      }
      for (const scope of [catalogParams, peer]) {
        expect(
          owner.read({ ...scope, provider: "openai", modelId: removed.id }, nativePluginConfig),
        ).toBeUndefined();
        expect(
          owner.read({ ...scope, provider: "openai", modelId: retained.id }, nativePluginConfig),
        ).toEqual({ accountType: "apiKey", authMode: "api_key" });
      }
      expect((await owner.load(catalogParams, nativePluginConfig)).map(({ id }) => id)).toEqual([
        retained.id,
      ]);
      expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(2);
      expect(listModelsMock).toHaveBeenCalledTimes(2);
    },
  );

  it("returns cached models immediately during one stale refresh and backs off failed refreshes", async () => {
    vi.useFakeTimers();
    listModelsMock.mockResolvedValue(opaqueCatalog());
    const original = await owner.load(catalogParams, undefined);
    const pending = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(pending.promise);
    try {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(await owner.load(catalogParams, undefined)).toEqual(original);
      expect(await owner.load(catalogParams, undefined)).toEqual(original);
      await vi.advanceTimersByTimeAsync(0);
      expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(2);
      pending.reject(new Error("synthetic account failure"));
      await vi.advanceTimersByTimeAsync(0);
      expect(read()).toBeUndefined();
      expect(await owner.load(catalogParams, undefined)).toEqual(original);
      expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      await owner.load(catalogParams, undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(3);
      expect(read()).toEqual({ accountType: "apiKey", authMode: "api_key" });
      await owner.load(catalogParams, { discovery: { enabled: false } });
      expect(read()).toBeUndefined();
    } finally {
      pending.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
      await vi.advanceTimersByTimeAsync(0);
    }
  });

  it("does not reuse another account or retired runtime and joins disposal without publishing late data", async () => {
    listModelsMock.mockResolvedValue(opaqueCatalog());
    profiles.store = {
      version: 1,
      profiles: {
        "openai:work": { type: "api_key", provider: "openai", key: "first-synthetic-key" },
      },
    };
    await owner.load(catalogParams, undefined);
    profiles.store.profiles["openai:work"] = {
      type: "api_key",
      provider: "openai",
      key: "second-synthetic-key",
    };
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    expect(withCodexAppServerJsonClient).toHaveBeenCalledTimes(2);
    rpc.epoch++;
    expect(read()).toBeUndefined();
    const delayed = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(delayed.promise);
    const late = owner.load(catalogParams, undefined);
    let stopping: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledTimes(3));
      const retired = vi.fn();
      stopping = owner.dispose().then(retired);
      await Promise.resolve();
      expect(retired).not.toHaveBeenCalled();
      delayed.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
      expect(await late).toEqual([]);
      await stopping;
      expect(read()).toBeUndefined();
    } finally {
      delayed.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
      await Promise.allSettled([late, stopping]);
    }
  });

  it("cannot republish an in-flight observation after discovery is disabled", async () => {
    listModelsMock.mockResolvedValue(opaqueCatalog());
    const pending = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(pending.promise);
    const older = owner.load(catalogParams, undefined);
    try {
      await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
      await owner.load(catalogParams, { discovery: { enabled: false } });
      pending.resolve({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      expect(await older).toEqual([]);
      expect(read()).toBeUndefined();
    } finally {
      pending.resolve({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      await Promise.allSettled([older]);
    }
  });
});
