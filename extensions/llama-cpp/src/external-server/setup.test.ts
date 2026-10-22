import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";
import { modelConfig, successfulDiscovery } from "./external-server.test-support.js";
import {
  configureLlamaServerNonInteractive,
  detectLlamaServerSetup,
  prepareLlamaServerSetup,
  runLlamaServerSetup,
  validateLlamaServerNonInteractive,
} from "./setup.js";

const LOCAL_ORIGIN = "http://localhost:8080";
const LOCAL_BASE_URL = "http://localhost:8080/v1";
const MODEL_ID = "qwen/model:Q4_K_M";
const MODEL_REF = "llama-cpp/qwen/model:Q4_K_M";

const removeProfilesMock = vi.hoisted(() => vi.fn());
const upsertProfileMock = vi.hoisted(() => vi.fn());
const discoverMock = vi.hoisted(() => vi.fn());
const runtimeApiKeyMock = vi.hoisted(() => vi.fn());
vi.mock("./discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./discovery.js")>()),
  discoverLlamaServer: discoverMock,
}));
vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  resolveLlamaServerRuntimeApiKey: runtimeApiKeyMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-api-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-api-key")>()),
  upsertAuthProfileWithLockOrThrow: upsertProfileMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>()),
  removeProviderAuthProfilesWithLock: removeProfilesMock,
}));

function runtime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never };
}

function prompterFor(url = LOCAL_ORIGIN, usesApiKey = false, key?: string) {
  const text = vi.fn<ProviderAuthContext["prompter"]["text"]>().mockResolvedValueOnce(url);
  if (key !== undefined) {
    text.mockResolvedValueOnce(key);
  }
  return { text, confirm: vi.fn(async () => usesApiKey) };
}

function expectDiscovery(params: Record<string, unknown>) {
  expect(discoverMock).toHaveBeenCalledWith(expect.objectContaining(params));
}

function expectProfileRemoved(agentDir?: string) {
  expect(removeProfilesMock).toHaveBeenCalledWith({
    cfg: expect.any(Object),
    agentDir,
    provider: "llama-cpp",
    profileIds: ["llama-cpp:default"],
  });
}

function expectAuthUnchanged() {
  expect(removeProfilesMock).not.toHaveBeenCalled();
  expect(upsertProfileMock).not.toHaveBeenCalled();
}

function configuredProvider(result: Awaited<ReturnType<typeof runLlamaServerSetup>>) {
  return result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
}

function expectKeyProfile(profiles: unknown, key: string) {
  expect(profiles).toEqual([
    {
      profileId: "llama-cpp:default",
      credential: { type: "api_key", provider: "llama-cpp", key },
    },
  ]);
}

function authProfileConfig(): NonNullable<ProviderAuthContext["config"]["auth"]> {
  return {
    profiles: { "llama-cpp:default": { provider: "llama-cpp", mode: "api_key" } },
    order: { "llama-cpp": ["llama-cpp:default"] },
  };
}

function configWithProvider(
  provider: Partial<ModelProviderConfig>,
  withProfile = false,
): ProviderAuthContext["config"] {
  const configured = { baseUrl: LOCAL_BASE_URL, models: [], ...provider };
  return {
    ...(withProfile ? { auth: authProfileConfig() } : {}),
    models: { providers: { "llama-cpp": configured } },
  };
}

function runSetup(
  params: Partial<Pick<ProviderAuthContext, "config" | "env" | "secretInputMode">> & {
    prompter: Pick<ProviderAuthContext["prompter"], "text" | "confirm">;
  },
) {
  const unexpectedInteraction = (): never => {
    throw new Error("Unexpected setup interaction");
  };
  const ctx: ProviderAuthContext = {
    config: {},
    ...params,
    prompter: {
      intro: unexpectedInteraction,
      outro: unexpectedInteraction,
      note: unexpectedInteraction,
      select: unexpectedInteraction,
      multiselect: unexpectedInteraction,
      progress: unexpectedInteraction,
      ...params.prompter,
    },
    runtime: runtime(),
    isRemote: false,
    openUrl: unexpectedInteraction,
    oauth: { createVpsAwareHandlers: unexpectedInteraction },
  };
  return runLlamaServerSetup(ctx);
}

function nonInteractiveContext(
  opts: Record<string, unknown> = {},
): ProviderAuthMethodNonInteractiveContext {
  return {
    authChoice: "llama-cpp-existing-server",
    config: {},
    baseConfig: {},
    opts,
    runtime: runtime(),
    resolveApiKey: vi.fn(async () => null),
    toApiKeyCredential: vi.fn(() => null),
  };
}

type ResolvedApiKey = {
  key: string;
  source: "flag" | "env" | "profile";
  envVarName?: string;
};

const keyRef = { source: "env", provider: "default", id: "LLAMA_SERVER_API_KEY" } as const;

type AuthInput = {
  replacement?: boolean;
  authorization?: boolean;
  option?: "llamaServerApiKey" | "customApiKey";
  authoredKey?: string;
  resolved: ResolvedApiKey | null;
  secretRef?: boolean;
};
type AuthExpectation = [
  string | undefined,
  Record<string, string> | undefined,
  "upsert" | "preserve" | "remove",
];
const authPolicyCases: [string, AuthInput, AuthExpectation][] = [
  [
    "authored plaintext replaces configured Authorization",
    {
      authorization: true,
      option: "llamaServerApiKey",
      authoredKey: "authored-key",
      resolved: { key: "resolved-authored-key", source: "flag" },
    },
    ["resolved-authored-key", { "X-Tenant": "one" }, "upsert"],
  ],
  [
    "authored SecretRef survives resolver source changes on a replacement endpoint",
    {
      replacement: true,
      option: "customApiKey",
      authoredKey: "${LLAMA_SERVER_API_KEY}",
      secretRef: true,
      resolved: { key: "resolved-ref-key", source: "env", envVarName: "LLAMA_SERVER_API_KEY" },
    },
    ["resolved-ref-key", undefined, "upsert"],
  ],
  [
    "unchanged profile is used without a persistence write",
    { resolved: { key: "stored-profile-key", source: "profile" } },
    ["stored-profile-key", { "X-Tenant": "one" }, "preserve"],
  ],
  [
    "configured Authorization wins over an implicit profile",
    { authorization: true, resolved: { key: "stored-profile-key", source: "profile" } },
    [undefined, { Authorization: "Bearer configured-header", "X-Tenant": "one" }, "remove"],
  ],
  [
    "ambient environment auth is persisted for the unchanged endpoint",
    { resolved: { key: "ambient-env-key", source: "env" } },
    ["ambient-env-key", { "X-Tenant": "one" }, "upsert"],
  ],
  [
    "replacement endpoint ignores implicit endpoint auth",
    { replacement: true, authorization: true, resolved: { key: "ambient-env-key", source: "env" } },
    [undefined, undefined, "remove"],
  ],
];

describe("llama-server setup", () => {
  beforeEach(() => {
    discoverMock.mockReset().mockResolvedValue(successfulDiscovery());
    runtimeApiKeyMock.mockReset().mockResolvedValue(undefined);
    removeProfilesMock.mockReset().mockResolvedValue({ version: 1, profiles: {} });
    upsertProfileMock.mockReset().mockResolvedValue(undefined);
  });

  it("does not present a managed localService as an existing-server candidate", async () => {
    const config = configWithProvider({
      baseUrl: "http://127.0.0.1:19432/v1",
      localService: { command: "/runtime/llama-server" },
    });

    await expect(detectLlamaServerSetup({ config, env: {} })).resolves.toBeNull();
    await expect(
      prepareLlamaServerSetup({ config, env: {}, modelRef: "llama-cpp/model" }),
    ).resolves.toBeNull();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "prefers a loaded model over an unloaded higher-ranked family",
      models: [
        { id: "meta-llama/Llama-3.3-8B", status: "loaded" },
        { id: "google/gemma-4-27b", status: "unloaded" },
      ],
      expected: "llama-cpp/meta-llama/Llama-3.3-8B",
    },
    {
      name: "preserves family preference when no model is loaded",
      models: [
        { id: "meta-llama/Llama-3.3-8B", status: "unloaded" },
        { id: "google/gemma-4-27b", status: "unloaded" },
      ],
      expected: "llama-cpp/google/gemma-4-27b",
    },
    {
      name: "does not recommend a server when every model has failed",
      models: [{ id: "google/gemma-4-27b", status: "unloaded", failed: true }],
      expected: null,
    },
  ] as const)("$name", async ({ models, expected }) => {
    const discovery = successfulDiscovery();
    discovery.models = models.map((model) => ({
      config: modelConfig({ contextTokens: 32768, id: model.id, name: model.id }),
      status: model.status,
      failed: "failed" in model && model.failed,
    }));
    discoverMock.mockResolvedValue(discovery);

    const result = await detectLlamaServerSetup({ config: {}, env: {} });
    expect(result?.modelRef ?? null).toBe(expected);
  });

  it("prefers configured Authorization over ambient auth during guided detection", async () => {
    runtimeApiKeyMock.mockResolvedValue("ambient-key");

    await detectLlamaServerSetup({
      config: configWithProvider({ headers: { Authorization: "Bearer proxy-key" } }),
      env: {},
    });

    expect(runtimeApiKeyMock).not.toHaveBeenCalled();
    expectDiscovery({
      apiKey: undefined,
      headers: { Authorization: "Bearer proxy-key" },
    });
  });

  it("skips guided detection when configured auth cannot be resolved", async () => {
    runtimeApiKeyMock.mockRejectedValue(new Error("unresolved SecretRef"));

    await expect(detectLlamaServerSetup({ config: {}, env: {} })).resolves.toBeNull();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it("prepares only the exact discovered model", async () => {
    const result = await prepareLlamaServerSetup({
      config: {},
      env: {},
      modelRef: MODEL_REF,
    });
    expect(result).toMatchObject({ profiles: [], defaultModel: MODEL_REF });
    expect(result?.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID]).toMatchObject({
      baseUrl: LOCAL_BASE_URL,
      api: "openai-completions",
    });
    await expect(
      prepareLlamaServerSetup({ config: {}, env: {}, modelRef: "llama-cpp/missing" }),
    ).resolves.toBeNull();
  });

  it("validates the server URL before discovery and accepts a corrected host shorthand", async () => {
    const text: ProviderAuthContext["prompter"]["text"] = vi.fn(async (prompt) => {
      for (const invalid of [
        "not a valid URL",
        "ftp://localhost:8080",
        "http://operator@localhost:8080",
      ]) {
        expect(prompt.validate?.(invalid)).toMatch(/HTTP.*URL/i);
      }
      expect(discoverMock).not.toHaveBeenCalled();
      expect(prompt.validate?.("localhost:8080/v1/")).toBeUndefined();
      return "localhost:8080/v1/";
    });

    const result = await runSetup({
      env: {},
      prompter: { text, confirm: vi.fn(async () => false) },
    });

    expect(configuredProvider(result)?.baseUrl).toBe(LOCAL_BASE_URL);
    expect(result.defaultModel).toBe(MODEL_REF);
  });

  it.each([
    { name: "saved false", saved: false },
    { name: "saved true", saved: true },
    { name: "unset", saved: undefined },
  ])(
    "forwards the $name private-network setting to interactive and non-interactive discovery",
    async ({ saved }) => {
      const config = configWithProvider({
        request: saved === undefined ? {} : { allowPrivateNetwork: saved },
      });

      await runSetup({ config, env: {}, prompter: prompterFor(LOCAL_BASE_URL) });
      const nonInteractive = nonInteractiveContext({ customBaseUrl: LOCAL_BASE_URL });
      nonInteractive.config = config;
      await validateLlamaServerNonInteractive(nonInteractive);

      expect(discoverMock).toHaveBeenCalledTimes(2);
      for (const [call] of discoverMock.mock.calls) {
        expect(call.allowPrivateNetwork).toBe(saved);
      }
    },
  );

  it.each([false, true])(
    "isolates credentials when replacing a managed=%s endpoint",
    async (managed) => {
      runtimeApiKeyMock.mockResolvedValue("stored-profile-key");
      const baseUrl = "http://replacement.example:8080/v1";
      const provider = {
        apiKey: "stored-provider-key",
        headers: { Authorization: "Bearer stored-header-key", "X-Tenant": "one" },
        ...(managed
          ? {
              baseUrl: "http://127.0.0.1:19432/v1",
              timeoutSeconds: 600,
              params: { modelCacheDir: "/managed/cache" },
              localService: {
                command: "/runtime/llama-server",
                healthUrl: "http://127.0.0.1:19432/health",
              },
              models: [
                modelConfig({
                  id: "managed-model",
                  params: { modelPath: "/managed/model.gguf" },
                }),
              ],
            }
          : {}),
      };
      const result = await runSetup({
        config: configWithProvider(provider, managed),
        env: { LLAMA_SERVER_API_KEY: "ambient-key" },
        prompter: prompterFor(baseUrl),
      });
      expect(runtimeApiKeyMock).not.toHaveBeenCalled();
      expectDiscovery({ baseUrl, apiKey: undefined, headers: undefined });
      const configured = configuredProvider(result);
      expect([configured?.apiKey, configured?.headers]).toEqual([undefined, undefined]);
      if (managed) {
        for (const field of ["localService", "timeoutSeconds", "headers"]) {
          expect(configured).not.toHaveProperty(field);
        }
        expect(configured?.params).toBeUndefined();
        expect(configured?.models).toEqual([expect.objectContaining({ id: MODEL_ID })]);
        expect(result.defaultModel).toBe(MODEL_REF);
        expect(result.configPatch?.auth).toEqual({
          profiles: { "llama-cpp:default": undefined },
          order: { "llama-cpp": undefined },
        });
        expectProfileRemoved();
      }
    },
  );

  it("uses an unchanged endpoint profile without rewriting or removing it", async () => {
    runtimeApiKeyMock.mockResolvedValue("stored-profile-key");
    const prompter = prompterFor(LOCAL_ORIGIN, true);

    const result = await runSetup({
      config: configWithProvider({ headers: { "X-Tenant": "one" } }, true),
      prompter,
    });

    expect(runtimeApiKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: "llama-cpp:default" }),
    );
    expect(prompter.text).toHaveBeenCalledOnce();
    expectDiscovery({ apiKey: "stored-profile-key", headers: { "X-Tenant": "one" } });
    expect(result.profiles).toEqual([]);
    expectAuthUnchanged();
  });

  it("preserves explicit Authorization instead of selecting an ambient API key", async () => {
    const prompter = prompterFor(LOCAL_ORIGIN, false);

    const result = await runSetup({
      config: configWithProvider({
        headers: { Authorization: "Bearer proxy-key", "X-Tenant": "one" },
      }),
      env: { LLAMA_SERVER_API_KEY: "ambient-key" },
      prompter,
    });

    expect(prompter.confirm).toHaveBeenCalledOnce();
    expectDiscovery({
      apiKey: undefined,
      headers: { Authorization: "Bearer proxy-key", "X-Tenant": "one" },
    });
    const provider = configuredProvider(result);
    expect(provider?.headers).toEqual({ Authorization: "Bearer proxy-key", "X-Tenant": "one" });
    expect(result.profiles).toEqual([]);
    expect(runtimeApiKeyMock).not.toHaveBeenCalled();
    expectProfileRemoved();
  });

  it.each([
    {
      name: "replacement endpoint",
      url: "http://replacement.example:8080",
      key: "replacement-key",
      config: configWithProvider(
        { apiKey: "old-config-key", headers: { Authorization: "Bearer old-header-key" } },
        true,
      ),
      env: { LLAMA_SERVER_API_KEY: "old-endpoint-key" },
    },
    {
      name: "unchanged endpoint with stale inline auth",
      url: LOCAL_ORIGIN,
      key: "secret-key",
      config: configWithProvider({
        auth: "api-key",
        apiKey: "stale-inline-key",
        headers: { authorization: "Bearer stale-key", "X-Tenant": "one" },
      }),
      env: {},
    },
  ])("prompts for and persists a new API key for $name", async ({ url, key, config, env }) => {
    const prompter = prompterFor(url, true, key);
    const result = await runSetup({ config, env, prompter, secretInputMode: "plaintext" });
    expect(prompter.text).toHaveBeenCalledTimes(2);
    expectDiscovery({ baseUrl: url + "/v1", apiKey: key });
    expectKeyProfile(result.profiles, key);
    if (url === LOCAL_ORIGIN) {
      const provider = configuredProvider(result);
      expect([provider?.auth, provider?.apiKey, provider?.headers]).toEqual([
        undefined,
        undefined,
        { "X-Tenant": "one" },
      ]);
    }
  });

  it.each(authPolicyCases)(
    "%s",
    async (_name, testCase, [expectedApiKey, expectedHeaders, action]) => {
      const origin = testCase.replacement ? "http://replacement.example:8080" : LOCAL_ORIGIN;
      discoverMock.mockResolvedValue(successfulDiscovery(origin));
      const ctx = nonInteractiveContext({
        customBaseUrl: `${origin}/v1`,
        ...(testCase.option && testCase.authoredKey
          ? { [testCase.option]: testCase.authoredKey }
          : {}),
      });
      ctx.agentDir = "/test/agent";
      ctx.config = configWithProvider(
        {
          ...(action === "preserve"
            ? {}
            : { auth: "api-key" as const, apiKey: "stale-inline-key" }),
          headers: {
            ...(testCase.authorization ? { Authorization: "Bearer configured-header" } : {}),
            "X-Tenant": "one",
          },
        },
        true,
      );
      ctx.resolveApiKey = vi.fn(async () => testCase.resolved);
      ctx.toApiKeyCredential = vi.fn(({ resolved }) => ({
        type: "api_key" as const,
        provider: LLAMA_CPP_PROVIDER_ID,
        ...(testCase.secretRef ? { keyRef } : { key: resolved.key }),
      }));

      const configured = await configureLlamaServerNonInteractive(ctx);
      const provider = configured?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];

      expectDiscovery({
        apiKey: expectedApiKey,
        headers: expectedHeaders,
      });
      expect(provider?.headers).toEqual(expectedHeaders);
      if (action !== "preserve") {
        expect(provider).toMatchObject({ auth: undefined, apiKey: undefined });
      }

      if (action === "upsert") {
        expect(ctx.toApiKeyCredential).toHaveBeenCalledOnce();
        expect(upsertProfileMock).toHaveBeenCalledWith(
          expect.objectContaining({
            profileId: "llama-cpp:default",
            agentDir: "/test/agent",
            credential: testCase.secretRef
              ? expect.objectContaining({
                  keyRef: { source: "env", provider: "default", id: "LLAMA_SERVER_API_KEY" },
                })
              : expect.objectContaining({ key: testCase.resolved?.key }),
          }),
        );
        expect(removeProfilesMock).not.toHaveBeenCalled();
      } else if (action === "preserve") {
        expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
        expectAuthUnchanged();
        expect(configured?.auth).toEqual(ctx.config.auth);
      } else {
        expect(ctx.toApiKeyCredential).not.toHaveBeenCalled();
        expect(upsertProfileMock).not.toHaveBeenCalled();
        expectProfileRemoved("/test/agent");
        expect(configured?.auth).toEqual({ profiles: {} });
      }
    },
  );

  it("propagates unreachable discovery during setup without changing auth", async () => {
    discoverMock.mockResolvedValue({
      kind: "unreachable",
      endpoint: successfulDiscovery().endpoint,
      error: new Error("connect ECONNREFUSED"),
    });
    const ctx = nonInteractiveContext();

    await expect(configureLlamaServerNonInteractive(ctx)).rejects.toThrow(
      "llama-server could not be reached at http://localhost:8080.",
    );
    expect(ctx.runtime.error).not.toHaveBeenCalled();
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
    expectAuthUnchanged();
  });

  it("rejects a requested model absent from discovery", async () => {
    const ctx = nonInteractiveContext({ customModelId: "missing" });

    await expect(validateLlamaServerNonInteractive(ctx)).rejects.toThrow(
      "llama-server model missing was not found. Available models: qwen/model:Q4_K_M",
    );
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects failed-only implicit setup while preserving an explicitly selected model", async () => {
    const discovery = successfulDiscovery();
    discovery.models = discovery.models.map((model) => ({ ...model, failed: true }));
    discoverMock.mockResolvedValue(discovery);

    const implicit = nonInteractiveContext();
    await expect(validateLlamaServerNonInteractive(implicit)).rejects.toThrow(
      "No llama-server text models were found at http://localhost:8080.",
    );
    expectAuthUnchanged();

    const explicit = nonInteractiveContext({ customModelId: MODEL_ID });
    await expect(validateLlamaServerNonInteractive(explicit)).resolves.toBe(true);
  });
});
