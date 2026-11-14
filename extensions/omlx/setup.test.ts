import type { ProviderAppGuidedSetupContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createQueuedWizardPrompter,
  createNonExitingRuntimeEnv,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  applyProviderAuthConfigPatch,
  buildApiKeyCredential,
  ensureAuthProfileStoreAsync,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
  ProviderCatalogContext,
} from "openclaw/plugin-sdk/provider-setup";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  configureOmlxInteractive,
  configureOmlxNonInteractive,
  detectOmlx,
  detectOmlxAvailability,
  discoverOmlxProvider,
  prepareOmlx,
  validateOmlxNonInteractive,
} from "./setup.js";

const modelId = "mlx-community/Qwen3-4B-Instruct-4bit";
const localUrl = "http://127.0.0.1:8000/v1";
function configWithProvider(overrides: Partial<ModelProviderConfig>): OpenClawConfig {
  return { models: { providers: { omlx: { baseUrl: localUrl, models: [], ...overrides } } } };
}

const rows = [
  { id: "text-embedding-mini", max_model_len: 512 },
  { id: modelId, max_model_len: 32_768 },
  { id: "custom-chat", max_model_len: 8_192 },
];

function fixture(data: unknown = rows, status = 200) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({ data }, { status }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function authorization(fetchMock: ReturnType<typeof fixture>) {
  return new Headers(fetchMock.mock.lastCall?.[1]?.headers).get("authorization");
}

function guidedContext(): ProviderAppGuidedSetupContext {
  return { config: {}, env: {} };
}

function catalogContext(): ProviderCatalogContext {
  return {
    ...guidedContext(),
    providerIds: ["omlx"],
    resolveProviderApiKey: () => ({ apiKey: undefined }),
    resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
  };
}

function interactiveContext(key = "", baseUrl = `${localUrl}/`): ProviderAuthContext {
  const { prompter } = createQueuedWizardPrompter({
    textValues: [baseUrl, key],
    selectValues: [modelId],
  });
  return {
    ...guidedContext(),
    prompter,
    runtime: createNonExitingRuntimeEnv(),
    secretInputMode: "plaintext",
    allowSecretRefPrompt: false,
    isRemote: false,
    openUrl: async () => {},
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("unused");
      },
    },
  };
}

function nonInteractiveContext(
  config: OpenClawConfig = {},
): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "omlx",
    config,
    baseConfig: config,
    opts: { customModelId: modelId },
    runtime: createNonExitingRuntimeEnv(),
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => {
      throw new Error("keyless setup must not store credentials");
    }),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("oMLX setup through the inference catalog", () => {
  it.each([
    { name: "keyless sentinel", apiKey: "omlx-local", envKey: "old-endpoint-key", key: null },
    {
      name: "selected profile",
      apiKey: "omlx:selected",
      envKey: "old-endpoint-key",
      key: "selected-key",
    },
    { name: "literal key", apiKey: "literal-key", envKey: undefined, key: "literal-key" },
  ])("keeps the $name for setup and catalog discovery", async ({ apiKey, envKey, key }) => {
    const fetchMock = fixture();
    vi.stubEnv("OMLX_API_KEY", envKey);
    vi.stubEnv("OMLX_MISSING_KEY", undefined);
    await withOpenClawTestState({ label: "omlx-setup-profile" }, async (state) => {
      await state.writeAuthProfiles({
        version: 1,
        profiles: {
          "omlx:unavailable": {
            type: "api_key",
            provider: "omlx",
            keyRef: { source: "env", provider: "default", id: "OMLX_MISSING_KEY" },
          },
          "omlx:selected": { type: "api_key", provider: "omlx", key: "selected-key" },
        },
      });
      const ctx = { env: { OMLX_API_KEY: envKey }, config: configWithProvider({ apiKey }) };
      await expect(detectOmlxAvailability(ctx)).resolves.toBe(true);
      await expect(
        discoverOmlxProvider({
          ...ctx,
          resolveProviderApiKey: () => ({
            apiKey: "OMLX_API_KEY",
            discoveryApiKey: "old-endpoint-key",
          }),
          resolveProviderAuth: () => {
            throw new Error("Unselected profile is unavailable");
          },
        }),
      ).resolves.toMatchObject({ provider: { apiKey } });
      expect(authorization(fetchMock)).toBe(key === null ? null : `Bearer ${key}`);
    });
  });

  it("discovers chat models and prepares a keyless model with server context", async () => {
    const fetchMock = fixture();
    const ctx = guidedContext();
    await expect(detectOmlxAvailability(ctx)).resolves.toBe(true);
    await expect(detectOmlx(ctx)).resolves.toEqual({
      modelRef: `omlx/${modelId}`,
      detail: modelId,
    });
    const prepared = await prepareOmlx({ ...ctx, modelRef: `omlx/${modelId}` });
    expect(prepared).toMatchObject({
      profiles: [],
      defaultModel: `omlx/${modelId}`,
    });
    expect(prepared?.configPatch?.models?.providers?.omlx).toMatchObject({
      api: "openai-completions",
      apiKey: "omlx-local",
      baseUrl: localUrl,
      models: [
        { id: "custom-chat", contextWindow: 8_192 },
        { id: modelId, contextWindow: 32_768 },
      ],
    });
    expect(fetchMock.mock.lastCall?.[0]).toBe(`${localUrl}/models`);
    expect(authorization(fetchMock)).toBeNull();
    await expect(prepareOmlx({ ...ctx, modelRef: "omlx/custom-chat" })).resolves.toBeNull();
    await expect(prepareOmlx({ ...ctx, modelRef: "omlx/missing" })).resolves.toBeNull();
  });

  it.each([
    { data: [{ id: "unknown-context" }] },
    { data: [{ id: "text-embedding-mini", max_model_len: 32_768 }] },
  ])("does not auto-select unqualified model rows $data", async ({ data }) => {
    fixture(data);
    await expect(detectOmlxAvailability(guidedContext())).resolves.toBe(true);
    await expect(detectOmlx(guidedContext())).resolves.toBeNull();
  });

  it.each([401, 503])("does not produce configuration after HTTP %s", async (status) => {
    fixture(rows, status);
    await expect(detectOmlxAvailability(guidedContext())).resolves.toBe(false);
    await expect(
      prepareOmlx({ ...guidedContext(), modelRef: `omlx/${modelId}` }),
    ).resolves.toBeNull();
    await expect(configureOmlxInteractive(interactiveContext())).rejects.toThrow("Start oMLX");
    await expect(discoverOmlxProvider(catalogContext())).resolves.toMatchObject({
      providers: {},
      outcomes: [{ provider: "omlx", status: status === 401 ? "auth-rejected" : "unavailable" }],
    });
  });

  it("handles an unreachable server and propagates cancellation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(detectOmlxAvailability(guidedContext())).resolves.toBe(false);
    await expect(detectOmlx({ ...guidedContext(), signal: AbortSignal.abort() })).rejects.toThrow();
  });

  it("honors a configured private-network denial during detection", async () => {
    const fetchMock = fixture();
    const ctx = guidedContext();
    ctx.config = configWithProvider({
      request: { allowPrivateNetwork: false },
    });
    await expect(detectOmlxAvailability(ctx)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes catalog discovery opt-in", async () => {
    const fetchMock = fixture();
    const ctx = catalogContext();
    await expect(discoverOmlxProvider({ ...ctx, providerIds: undefined })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "interactive", credentialMode: "plaintext" },
    { mode: "noninteractive", credentialMode: "plaintext" },
    { mode: "interactive", credentialMode: "ref" },
    { mode: "noninteractive", credentialMode: "ref" },
  ] as const)(
    "retains the selected $credentialMode credential after initial $mode setup",
    async ({ mode, credentialMode }) => {
      const ambientKey = "ambient-setup-key";
      const selectedKey = "explicit-setup-key";
      const selectedRef = {
        source: "env",
        provider: "default",
        id: "OMLX_SELECTED_SETUP_KEY",
      } as const;
      vi.stubEnv("OMLX_API_KEY", ambientKey);
      vi.stubEnv(selectedRef.id, selectedKey);
      await withOpenClawTestState({ label: "omlx-initial-credential" }, async (state) => {
        const expectedCredential = {
          type: "api_key",
          provider: "omlx",
          ...(credentialMode === "ref" ? { keyRef: selectedRef } : { key: selectedKey }),
        } as const;
        const fetchMock = fixture();
        const agentId = "secondary";
        const agentDir = state.agentDir(agentId);
        const consumerAgentDir = credentialMode === "ref" ? state.agentDir("cold") : agentDir;
        await state.writeAuthProfiles({
          version: 1,
          profiles: {
            "omlx:default": { type: "api_key", provider: "omlx", key: "other-agent-key" },
          },
        });
        let config: OpenClawConfig;
        if (mode === "interactive") {
          const ctx = interactiveContext(selectedKey);
          ctx.agentDir = agentDir;
          ctx.env = { OMLX_API_KEY: ambientKey, [selectedRef.id]: selectedKey };
          if (credentialMode === "ref") {
            ctx.secretInputMode = "ref";
            ctx.prompter = createQueuedWizardPrompter({
              textValues: [localUrl, selectedRef.id],
              selectValues: ["env", modelId],
            }).prompter;
          }
          ctx.prompter.confirm = vi.fn(async () => false);
          const result = await configureOmlxInteractive(ctx);
          await state.writeAuthProfiles(
            {
              version: 1,
              profiles: Object.fromEntries(
                result.profiles.map(({ profileId, credential }) => [profileId, credential]),
              ),
            },
            agentId,
          );
          config = applyProviderAuthConfigPatch({}, result.configPatch, result);
        } else {
          const ctx = nonInteractiveContext();
          ctx.agentDir = agentDir;
          ctx.opts.customApiKey = selectedKey;
          ctx.resolveApiKey = vi.fn(async () => ({ key: selectedKey, source: "flag" as const }));
          ctx.toApiKeyCredential = vi.fn<
            ProviderAuthMethodNonInteractiveContext["toApiKeyCredential"]
          >(({ provider, resolved }) =>
            buildApiKeyCredential(provider, credentialMode === "ref" ? selectedRef : resolved.key),
          );
          const configured = await configureOmlxNonInteractive(ctx);
          assert(configured, "Missing initial oMLX setup configuration");
          config = configured;
        }
        expect(authorization(fetchMock)).toBe(`Bearer ${selectedKey}`);
        const store = await ensureAuthProfileStoreAsync(agentDir);
        fetchMock.mockClear();
        await expect(
          discoverOmlxProvider({
            ...catalogContext(),
            config,
            agentDir: consumerAgentDir,
            env: { OMLX_API_KEY: ambientKey, [selectedRef.id]: selectedKey },
          }),
        ).resolves.toBeTruthy();
        expect(store.profiles["omlx:default"]).toEqual(expectedCredential);
        expect(config.models?.providers?.omlx?.apiKey).toEqual(
          credentialMode === "ref" ? selectedRef : "omlx:default",
        );
        expect(authorization(fetchMock)).toBe(`Bearer ${selectedKey}`);
        if (mode === "noninteractive" && credentialMode === "plaintext") {
          const repeated = nonInteractiveContext(config);
          repeated.agentDir = agentDir;
          await expect(validateOmlxNonInteractive(repeated)).resolves.toBe(true);
          const validationAuthorization = authorization(fetchMock);
          const next = await configureOmlxNonInteractive(repeated);
          expect(validationAuthorization).toBe(`Bearer ${selectedKey}`);
          expect(authorization(fetchMock)).toBe(`Bearer ${selectedKey}`);
          expect(next?.models?.providers?.omlx?.apiKey).toBe("omlx:default");
          expect(repeated.toApiKeyCredential).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each([
    { interactive: true, key: "replacement-key", custom: true, unavailable: false },
    { interactive: true, key: "", custom: false, unavailable: false },
    { interactive: false, key: "replacement-key", custom: true, unavailable: true },
    { interactive: false, key: "", custom: true, unavailable: false },
  ])("replaces saved authentication on same-endpoint setup %j", async (scenario) => {
    const fetchMock = fixture();
    const stale = scenario.unavailable
      ? { source: "env" as const, provider: "default", id: "OMLX_STALE_SETUP_KEY" }
      : "old-key";
    vi.stubEnv("OMLX_STALE_SETUP_KEY", undefined);
    const config = configWithProvider({
      apiKey: "old-key",
      headers: { Authorization: "Bearer old-key", "X-Deployment": "fixture" },
      request: {
        allowPrivateNetwork: true,
        headers: {
          ...(scenario.custom ? { "X-oMLX-Key": "old-key" } : {}),
          "X-Request": "fixture",
        },
        auth: scenario.custom
          ? { mode: "header" as const, headerName: "X-oMLX-Key", value: stale }
          : { mode: "authorization-bearer" as const, token: stale },
      },
    });
    const ctx = nonInteractiveContext(config);
    ctx.opts.customApiKey = scenario.key;
    ctx.resolveApiKey = vi.fn(async () => ({
      key: scenario.key || "old-key",
      source: "flag" as const,
    }));
    if (scenario.interactive) {
      const result = await configureOmlxInteractive({
        ...interactiveContext(scenario.key),
        config,
      });
      const provider = result.configPatch?.models?.providers?.omlx;
      expect(provider?.headers?.Authorization).toBeUndefined();
      expect(provider?.headers?.["X-Deployment"]).toBe("fixture");
      expect(provider?.request?.headers?.["X-oMLX-Key"]).toBeUndefined();
      expect(provider?.request?.headers?.["X-Request"]).toBe("fixture");
      expect(provider?.request?.auth).toBeUndefined();
      expect(provider?.request?.allowPrivateNetwork).toBe(true);
    } else {
      await expect(validateOmlxNonInteractive(ctx)).resolves.toBe(true);
      expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
    }
    const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
    expect(headers.get("authorization")).toBe(scenario.key ? `Bearer ${scenario.key}` : null);
    expect(headers.has("x-omlx-key")).toBe(false);
    expect(headers.get("x-deployment")).toBe("fixture");
    expect(headers.get("x-request")).toBe("fixture");
  });

  it.each([undefined, true])(
    "clears saved credentials on an endpoint switch with private-network policy %s",
    async (allowPrivateNetwork) => {
      const fetchMock = fixture();
      const baseUrl = allowPrivateNetwork ? localUrl : "https://omlx.example.test/v1";
      const ctx = interactiveContext("", baseUrl);
      ctx.config = {
        auth: { profiles: { "omlx:default": { provider: "omlx", mode: "api_key" } } },
        ...configWithProvider({
          baseUrl: "http://127.0.0.1:9000/v1",
          apiKey: "old-endpoint-key",
          auth: "api-key",
          authHeader: false,
          headers: { Authorization: "Bearer old-header-key" },
          request: {
            allowPrivateNetwork,
            auth: { mode: "header", headerName: "X-Old-Auth", value: "old-auth-key" },
            headers: { "X-Api-Key": "old-custom-key" },
            tls: { cert: "old-client-cert", key: "old-client-key" },
            proxy: {
              mode: "explicit-proxy",
              url: "http://proxy.example.test",
              tls: { passphrase: "old-proxy-passphrase" },
            },
          },
        }),
      };
      const result = await configureOmlxInteractive(ctx);
      expect(result).toMatchObject({ defaultModel: `omlx/${modelId}`, profiles: [] });
      expect(fetchMock.mock.lastCall?.[0]).toBe(`${baseUrl}/models`);
      const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("x-api-key")).toBe(false);
      expect(headers.has("x-old-auth")).toBe(false);
      const provider = result.configPatch?.models?.providers?.omlx;
      expect(provider).toHaveProperty("auth", undefined);
      expect(provider).toHaveProperty("authHeader", undefined);
      expect(provider).toHaveProperty("headers", undefined);
      expect(provider).toHaveProperty("request");
      const clearedTransport = {
        auth: undefined,
        headers: undefined,
        proxy: undefined,
        tls: undefined,
      };
      expect(provider?.request).toStrictEqual(
        allowPrivateNetwork === undefined
          ? undefined
          : { allowPrivateNetwork, ...clearedTransport },
      );
      expect(provider?.apiKey).toBe("omlx-local");
    },
  );

  it.each(["missing", { unexpected: "value" }])(
    "rejects invalid model %j before persistence",
    async (model) => {
      const fetchMock = fixture();
      const ctx = nonInteractiveContext();
      ctx.opts.customModelId = model;
      const error = vi.spyOn(ctx.runtime, "error");
      await expect(validateOmlxNonInteractive(ctx)).resolves.toBe(false);
      await expect(configureOmlxNonInteractive(ctx)).resolves.toBeNull();
      expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
      if (typeof model !== "string") {
        expect(error).toHaveBeenCalledWith(expect.stringContaining("requires --custom-model-id"));
        expect(fetchMock).not.toHaveBeenCalled();
        expect(ctx.resolveApiKey).not.toHaveBeenCalled();
      }
    },
  );

  it.each<[string | undefined, string]>([
    [undefined, localUrl],
    ["https://omlx.example.test/v1/", "https://omlx.example.test/v1"],
  ])("normalizes blank input with saved URL %s", async (saved, baseUrl) => {
    const fetchMock = fixture();
    const ctx = interactiveContext("", "");
    ctx.config = saved ? configWithProvider({ baseUrl: saved }) : {};
    const result = await configureOmlxInteractive(ctx);
    expect(vi.mocked(ctx.prompter.text).mock.calls[0]?.[0]).toMatchObject({
      initialValue: saved,
      placeholder: localUrl,
    });
    expect(fetchMock.mock.lastCall?.[0]).toBe(`${baseUrl}/models`);
    expect(result.configPatch?.models?.providers?.omlx?.baseUrl).toBe(baseUrl);
  });

  it("retains a private-network denial when setup changes the endpoint", async () => {
    const fetchMock = fixture();
    const ctx = interactiveContext();
    ctx.config = configWithProvider({
      baseUrl: "https://models.example.test/v1",
      request: { allowPrivateNetwork: false },
    });
    await expect(configureOmlxInteractive(ctx)).rejects.toThrow("Start oMLX");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("configures keyless noninteractive setup without creating a credential", async () => {
    fixture();
    const ctx = nonInteractiveContext();
    const config = await configureOmlxNonInteractive(ctx);
    expect(config?.models?.providers?.omlx?.apiKey).toBe("omlx-local");
    expect(config?.agents?.defaults?.model).toMatchObject({ primary: `omlx/${modelId}` });
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
  });

  it.each([
    { apiKey: "existing-fixture-key", custom: false, authorization: "Bearer existing-fixture-key" },
    { apiKey: "omlx-local", custom: false, authorization: null },
    { apiKey: undefined, custom: true, authorization: null },
  ])("keeps saved auth when the noninteractive key flag is omitted %j", async (scenario) => {
    const fetchMock = fixture();
    vi.stubEnv("OMLX_API_KEY", "ambient-key");
    const ctx = nonInteractiveContext();
    ctx.resolveApiKey = vi.fn(async () => ({ key: "ambient-key", source: "env" as const }));
    ctx.config = configWithProvider({
      apiKey: scenario.apiKey,
      request: scenario.custom
        ? { auth: { mode: "header", headerName: "X-oMLX-Key", value: "saved-header-key" } }
        : undefined,
    });
    await expect(validateOmlxNonInteractive(ctx)).resolves.toBe(true);
    const headers = new Headers(fetchMock.mock.lastCall?.[1]?.headers);
    expect(headers.get("authorization")).toBe(scenario.authorization);
    expect(headers.get("x-omlx-key")).toBe(scenario.custom ? "saved-header-key" : null);
    const result = await configureOmlxNonInteractive(ctx);
    if (scenario.apiKey !== undefined) {
      expect(result?.models?.providers?.omlx?.apiKey).toBe(scenario.apiKey);
    }
    expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
  });
});
