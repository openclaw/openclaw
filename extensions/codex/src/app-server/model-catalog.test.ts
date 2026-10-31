import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { listAllCodexAppServerModels } from "./models.js";
import { probeCodexNativeAuth } from "./native-auth.js";
import { withCodexAppServerJsonClient } from "./request.js";
import { CodexAppServerLocalRequestCancellationError } from "./rpc-error.js";

vi.mock("./models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models.js")>()),
  listAllCodexAppServerModels: vi.fn(),
}));
vi.mock("./native-auth.js", () => ({ probeCodexNativeAuth: vi.fn() }));

const profiles = vi.hoisted((): { store: AuthProfileStore } => ({
  store: { version: 1, profiles: {} },
}));
// mock-isolation: Exercise real profile selection against the catalog fixture, without host credential storage.
vi.mock("./auth-profile.js", async () => {
  const { resolveAuthProfileOrder } = await import("openclaw/plugin-sdk/provider-auth");
  const { createCodexAuthProfileSelection } = await import("./auth-profile-selection.js");
  return createCodexAuthProfileSelection({
    ensureAuthProfileStoreAsync: async () => profiles.store,
    resolveAuthProfileOrder,
  });
});

const rpc = vi.hoisted(() => ({ request: vi.fn(), retire: vi.fn(), epoch: 0, client: {} }));
vi.mock("./request.js", () => ({
  withCodexAppServerJsonClient: vi.fn(
    (_options: unknown, run: (request: unknown, client: unknown) => unknown) =>
      run(rpc.request, rpc.client),
  ),
}));
// mock-isolation: Keep physical clients and shared lease state outside catalog projection tests.
vi.mock("./shared-client.js", () => ({
  retireSharedCodexAppServerClientIfCurrent: rpc.retire,
  captureSharedCodexAppServerCatalogLifetime: () => {
    const epoch = rpc.epoch;
    return () => rpc.epoch === epoch;
  },
}));
let owner: ReturnType<typeof createCodexAppServerModelCatalog>;
const loadCodexAppServerModelCatalog = async (...args: Parameters<typeof owner.load>) =>
  (await owner.load(...args)).entries;
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
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    profiles.store = { version: 1, profiles: {} };
    vi.mocked(probeCodexNativeAuth).mockReset().mockResolvedValue({
      apiKey: "native-presence",
      source: "native login",
      mode: "api-key",
    });
    listModelsMock.mockReset();
    vi.mocked(withCodexAppServerJsonClient).mockClear();
    rpc.epoch += 1;
    rpc.retire.mockClear();
    rpc.request
      .mockReset()
      .mockResolvedValue({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    owner = createCodexAppServerModelCatalog("codex");
  });

  it.each(["chatgpt", "apiKey"])(
    "publishes only explicit caller program metadata for %s discovery",
    async (type) => {
      rpc.request.mockResolvedValue({ account: { type }, requiresOpenaiAuth: true });
      listModelsMock.mockResolvedValue({
        models: [
          {
            ...opaqueCatalog().models[0]!,
            availableAccessPrograms: { cyber: ["standard", "daybreak_blue"] },
          },
        ],
      });
      const result = await owner.load(catalogParams, undefined);
      expect(result.outcomes?.[0]?.modelAccessPrograms).toEqual([
        {
          modelId: "synthetic-opaque",
          runtimeId: "codex",
          cyber: ["standard", "daybreak_blue"],
        },
      ]);
      expect(read()).toBeDefined();
      rpc.epoch += 1;
      expect(read()).toBeUndefined();
    },
  );

  it.each([
    {
      name: "unanswered account read",
      error: new CodexAppServerLocalRequestCancellationError("account/read", "aborted", true),
      retires: true,
    },
  ])("preserves discovery ownership after $name", async ({ error, retires }) => {
    listModelsMock.mockResolvedValue(opaqueCatalog());
    rpc.request.mockRejectedValueOnce(error);
    await expect(owner.load(catalogParams, undefined)).rejects.toBe(error);
    expect(rpc.retire).toHaveBeenCalledTimes(retires ? 1 : 0);
    if (retires) {
      expect(rpc.retire).toHaveBeenCalledWith(rpc.client);
    }
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
    expect(probeCodexNativeAuth).not.toHaveBeenCalled();
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
  ])(
    "uses the $name server account without probing a local login",
    async ({ appServer, envArgs }) => {
      vi.stubEnv("OPENCLAW_CODEX_APP_SERVER_ARGS", envArgs);
      vi.mocked(probeCodexNativeAuth).mockResolvedValue(undefined);
      listModelsMock.mockResolvedValue(opaqueCatalog());
      const pluginConfig = { appServer };
      expect((await owner.load(catalogParams, pluginConfig)).entries).toContainEqual(
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

    expect((await owner.load(params, undefined)).entries).toContainEqual(
      expect.objectContaining({ id: "synthetic-native-only", nativeRuntime: "codex" }),
    );
    expect(
      owner.read({ ...params, provider: "openai", modelId: "synthetic-native-only" }, undefined),
    ).toEqual({ accountType: "apiKey", authMode: "api_key" });

    authOrder.reverse();
    expect(await owner.load(params, undefined)).toEqual({ entries: [] });
    expect(listModelsMock).toHaveBeenCalledOnce();
    expect(withCodexAppServerJsonClient).toHaveBeenCalledOnce();
    expect(
      owner.read({ ...params, provider: "openai", modelId: "synthetic-native-only" }, undefined),
    ).toBeUndefined();
  });

  it.each(["token"] as const)(
    "retains the observed native %s mode through discovery",
    async (mode) => {
      vi.mocked(probeCodexNativeAuth).mockResolvedValue({
        apiKey: "native-presence",
        source: "native login",
        mode,
      });
      rpc.request.mockResolvedValue({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
      listModelsMock.mockResolvedValue(opaqueCatalog());
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
    const { entries: catalog } = await owner.load(params, undefined);
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
      const result = await owner.load(catalogParams, nativePluginConfig);
      expect(result.entries).toContainEqual(expect.objectContaining({ id: "synthetic-opaque" }));
      expect(result.outcomes).toEqual([
        {
          provider: "openai",
          status: account ? "ready" : "unavailable",
          ...(account ? { modelAccessPrograms: [] } : {}),
        },
      ]);
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

  it("revokes prior readiness on failed or disabled refresh", async () => {
    listModelsMock.mockResolvedValue(opaqueCatalog());
    await owner.load(catalogParams, undefined);
    expect(read()).toEqual({ accountType: "apiKey", authMode: "api_key" });
    rpc.request.mockRejectedValueOnce(new Error("synthetic account failure"));
    await expect(owner.load(catalogParams, undefined)).rejects.toThrow("synthetic account failure");
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    await owner.load(catalogParams, { discovery: { enabled: false } });
    expect(read()).toBeUndefined();
  });

  it("cannot publish superseded or disposed asynchronous observations", async () => {
    listModelsMock.mockResolvedValue(opaqueCatalog());
    const pending = createDeferred<unknown>();
    const pendingStarted = createDeferred<void>();
    rpc.request.mockImplementationOnce(() => {
      pendingStarted.resolve();
      return pending.promise;
    });
    const older = owner.load(catalogParams, undefined);
    await pendingStarted.promise;
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    pending.resolve({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
    expect(await older).toEqual({ entries: [] });
    expect(read()).toEqual({ accountType: "apiKey", authMode: "api_key" });
    const disposed = createDeferred<unknown>();
    const disposedStarted = createDeferred<void>();
    rpc.request.mockImplementationOnce(() => {
      disposedStarted.resolve();
      return disposed.promise;
    });
    const late = owner.load(catalogParams, undefined);
    await disposedStarted.promise;
    owner.dispose();
    disposed.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(await late).toEqual({ entries: [] });
    expect(read()).toBeUndefined();
  });
});
