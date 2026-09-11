import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { AuthProfileStore } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import { listAllCodexAppServerModels } from "./models.js";
import { probeCodexNativeAuth } from "./native-auth.js";
import { withCodexAppServerJsonClient } from "./request.js";

vi.mock("./models.js", () => ({
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

const rpc = vi.hoisted(() => ({ request: vi.fn(), epoch: 0, client: {} }));
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
const loadCodexAppServerModelCatalog = (...args: Parameters<typeof owner.load>) =>
  owner.load(...args);
const read = (overrides = {}) =>
  owner.read(
    { ...catalogParams, provider: "openai", modelId: "synthetic-opaque", ...overrides },
    undefined,
  );
const listModelsMock = vi.mocked(listAllCodexAppServerModels);

const catalogParams = {
  config: {},
  agentId: "main",
  agentDir: "/tmp/main-agent",
  workspaceDir: "/tmp/workspace",
};

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
    rpc.request
      .mockReset()
      .mockResolvedValue({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    owner = createCodexAppServerModelCatalog("codex");
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
      "user",
    );
    expect(probeCodexNativeAuth).toHaveBeenCalledOnce();
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
      await owner.load(catalogParams, undefined);
      expect(read()).toEqual({ accountType: "chatgpt", authMode: mode });
      rpc.epoch += 1;
      expect(read()).toBeUndefined();
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
      rpc.request.mockResolvedValue({ account, requiresOpenaiAuth: true });
      await owner.load(catalogParams, undefined);
      expect(read()).toEqual(readiness);
      expect(read({ agentId: "another" })).toBeUndefined();
      expect(read({ agentDir: "/tmp/another-agent" })).toBeUndefined();
      expect(read({ workspaceDir: "/tmp/another-workspace" })).toBeUndefined();
      expect(read({ config: { ...catalogParams.config } })).toBeUndefined();
      expect(read({ modelId: "unlisted" })).toBeUndefined();
      expect(read({ provider: "another" })).toBeUndefined();
      expect(
        owner.read({ ...catalogParams, provider: "openai", modelId: "synthetic-opaque" }, {}),
      ).toBeUndefined();
      rpc.epoch += 1;
      expect(read()).toBeUndefined();
    },
  );

  it("revokes prior readiness on failed or disabled refresh", async () => {
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
    const pending = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(pending.promise);
    const older = owner.load(catalogParams, undefined);
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledOnce());
    expect(read()).toBeUndefined();
    await owner.load(catalogParams, undefined);
    pending.resolve({ account: { type: "chatgpt" }, requiresOpenaiAuth: true });
    expect(await older).toEqual([]);
    expect(read()).toEqual({ accountType: "apiKey", authMode: "api_key" });
    const disposed = createDeferred<unknown>();
    rpc.request.mockReturnValueOnce(disposed.promise);
    const late = owner.load(catalogParams, undefined);
    await vi.waitFor(() => expect(rpc.request).toHaveBeenCalledTimes(3));
    owner.dispose();
    disposed.resolve({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(await late).toEqual([]);
    expect(read()).toBeUndefined();
  });
});
