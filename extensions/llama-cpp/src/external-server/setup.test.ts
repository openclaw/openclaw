import type {
  ProviderAuthContext,
  ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { LLAMA_CPP_PROVIDER_ID } from "../defaults.js";
import { modelConfig, successfulDiscovery } from "./external-server.test-support.js";
import {
  configureLlamaServerNonInteractive as configure,
  detectLlamaServerSetup as detect,
  prepareLlamaServerSetup as prepare,
  runLlamaServerSetup as run,
  validateLlamaServerNonInteractive as validate,
} from "./setup.js";

const LOCAL_ORIGIN = "http://localhost:8080";
const LOCAL_BASE_URL = "http://localhost:8080/v1";
const MODEL_ID = "qwen/model:Q4_K_M";
const MODEL_REF = "llama-cpp/qwen/model:Q4_K_M";
const PROFILE_ID = "llama-cpp:default";
const TENANT = { "X-Tenant": "one" };
const AUTH_HEADERS = { Authorization: "Bearer configured-header", ...TENANT };
const STALE_AUTH = { auth: "api-key", apiKey: "stale-inline-key" } as const;

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
  expect(removeProfilesMock.mock.lastCall?.[0]).toMatchObject({
    agentDir,
    provider: LLAMA_CPP_PROVIDER_ID,
    profileIds: [PROFILE_ID],
  });
}

function expectAuthUnchanged() {
  expect(removeProfilesMock).not.toHaveBeenCalled();
  expect(upsertProfileMock).not.toHaveBeenCalled();
}

function configuredProvider(result: Awaited<ReturnType<typeof run>>) {
  return result.configPatch?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
}

function credential(secret: { key: string } | { keyRef: typeof keyRef }) {
  return { type: "api_key" as const, provider: "llama-cpp", ...secret };
}

function authProfileConfig(): NonNullable<ProviderAuthContext["config"]["auth"]> {
  return {
    profiles: { [PROFILE_ID]: { provider: LLAMA_CPP_PROVIDER_ID, mode: "api_key" } },
    order: { [LLAMA_CPP_PROVIDER_ID]: [PROFILE_ID] },
  };
}

function configWithProvider(
  provider: Partial<ModelProviderConfig>,
  withProfile = false,
): ProviderAuthContext["config"] {
  return {
    ...(withProfile ? { auth: authProfileConfig() } : {}),
    models: { providers: { "llama-cpp": { baseUrl: LOCAL_BASE_URL, models: [], ...provider } } },
  };
}

function runSetup(
  prompter: Pick<ProviderAuthContext["prompter"], "text" | "confirm">,
  config: ProviderAuthContext["config"] = {},
  env: ProviderAuthContext["env"] = {},
  secretInputMode?: ProviderAuthContext["secretInputMode"],
) {
  const unexpectedInteraction = (): never => {
    throw new Error("Unexpected setup interaction");
  };
  return run({
    config,
    env,
    secretInputMode,
    prompter: {
      intro: unexpectedInteraction,
      outro: unexpectedInteraction,
      note: unexpectedInteraction,
      select: unexpectedInteraction,
      multiselect: unexpectedInteraction,
      progress: unexpectedInteraction,
      ...prompter,
    },
    runtime: runtime(),
    isRemote: false,
    openUrl: unexpectedInteraction,
    oauth: { createVpsAwareHandlers: unexpectedInteraction },
  });
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

const keyRef = { source: "env", provider: "default", id: "LLAMA_SERVER_API_KEY" } as const;
type AuthInput = {
  replacement?: boolean;
  authorization?: boolean;
  opts?: Partial<Record<"llamaServerApiKey" | "customApiKey", string>>;
  secretRef?: boolean;
};
type AuthExpectation = [
  string | undefined,
  Record<string, string> | undefined,
  "upsert" | "preserve" | "remove",
];
const RESOLVED_KEY = "resolved-key";
const authPolicyCases: [string, AuthInput, "flag" | "env" | "profile", AuthExpectation][] = [
  [
    "authored key replaces Authorization",
    {
      authorization: true,
      opts: { llamaServerApiKey: "authored-key" },
    },
    "flag",
    [RESOLVED_KEY, TENANT, "upsert"],
  ],
  [
    "authored SecretRef survives replacement and resolver source change",
    {
      replacement: true,
      opts: { customApiKey: "${LLAMA_SERVER_API_KEY}" },
      secretRef: true,
    },
    "env",
    [RESOLVED_KEY, undefined, "upsert"],
  ],
  ["profile is preserved", {}, "profile", [RESOLVED_KEY, TENANT, "preserve"]],
  [
    "Authorization beats implicit profile",
    { authorization: true },
    "profile",
    [undefined, AUTH_HEADERS, "remove"],
  ],
  ["ambient key is persisted", {}, "env", [RESOLVED_KEY, TENANT, "upsert"]],
  [
    "replacement ignores implicit auth",
    { replacement: true, authorization: true },
    "env",
    [undefined, undefined, "remove"],
  ],
];

beforeEach(() => {
  discoverMock.mockReset().mockResolvedValue(successfulDiscovery());
  runtimeApiKeyMock.mockReset().mockResolvedValue(undefined);
  removeProfilesMock.mockReset().mockResolvedValue({ version: 1, profiles: {} });
  upsertProfileMock.mockReset().mockResolvedValue(undefined);
});

it("does not present a managed localService as an existing-server candidate", async () => {
  const config = configWithProvider({ localService: { command: "/runtime/llama-server" } });
  await expect(detect({ config, env: {} })).resolves.toBeNull();
  await expect(prepare({ config, env: {}, modelRef: "llama-cpp/model" })).resolves.toBeNull();
  expect(discoverMock).not.toHaveBeenCalled();
});

it("prefers a loaded model over an unloaded higher-ranked family", async () => {
  const discovery = successfulDiscovery();
  discovery.models = [
    { id: "meta-llama/Llama-3.3-8B", status: "loaded" as const },
    { id: "google/gemma-4-27b", status: "unloaded" as const },
  ].map(({ id, status }) => ({
    config: modelConfig({ contextTokens: 32768, id, name: id }),
    status,
    failed: false,
  }));
  discoverMock.mockResolvedValue(discovery);
  const result = await detect({ config: {}, env: {} });
  expect(result?.modelRef).toBe("llama-cpp/meta-llama/Llama-3.3-8B");
});

it.each([
  [false, ["meta-llama/Llama-3.3-8B", "google/gemma-4-27b"], "llama-cpp/google/gemma-4-27b"],
  [true, ["google/gemma-4-27b"], null],
] as const)("selects preferred unloaded models unless failed=%s", async (failed, ids, expected) => {
  const discovery = successfulDiscovery();
  discovery.models = ids.map((id) => ({
    config: modelConfig({ contextTokens: 32768, id, name: id }),
    status: "unloaded",
    failed,
  }));
  discoverMock.mockResolvedValue(discovery);
  const result = await detect({ config: {}, env: {} });
  expect(result?.modelRef ?? null).toBe(expected);
  if (failed) {
    await expect(validate(nonInteractiveContext())).rejects.toThrow(
      "No llama-server text models were found at http://localhost:8080.",
    );
    expectAuthUnchanged();
    await expect(validate(nonInteractiveContext({ customModelId: ids[0] }))).resolves.toBe(true);
  }
});

it("prefers configured Authorization over ambient auth during guided detection", async () => {
  runtimeApiKeyMock.mockResolvedValue("ambient-key");
  await detect({
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
  await expect(detect({ config: {}, env: {} })).resolves.toBeNull();
  expect(discoverMock).not.toHaveBeenCalled();
});

it("prepares only the exact discovered model", async () => {
  const result = await prepare({ config: {}, env: {}, modelRef: MODEL_REF });
  expect(result).toMatchObject({ profiles: [], defaultModel: MODEL_REF });
  expect(result && configuredProvider(result)).toMatchObject({
    baseUrl: LOCAL_BASE_URL,
    api: "openai-completions",
  });
  await expect(prepare({ config: {}, env: {}, modelRef: "llama-cpp/missing" })).resolves.toBeNull();
});

it("validates the server URL before discovery and accepts a corrected host shorthand", async () => {
  const text: ProviderAuthContext["prompter"]["text"] = vi.fn(async (prompt) => {
    for (const invalid of ["bad url", "ftp://localhost:8080", "http://operator@localhost:8080"]) {
      expect(prompt.validate?.(invalid)).toMatch(/HTTP.*URL/i);
    }
    expect(discoverMock).not.toHaveBeenCalled();
    expect(prompt.validate?.("localhost:8080/v1/")).toBeUndefined();
    return "localhost:8080/v1/";
  });
  const result = await runSetup({ ...prompterFor(), text });
  expect(configuredProvider(result)?.baseUrl).toBe(LOCAL_BASE_URL);
});

it.each([
  [undefined, undefined, "http://127.0.0.1:8080/v1"],
  ["http://gpu-box:8080/v1", "http://gpu-box:8080", "http://gpu-box:8080/v1"],
])(
  "blank input with saved URL %s uses the default or prefilled origin",
  async (saved, initialValue, baseUrl) => {
    const prompter = prompterFor("");
    await runSetup(prompter, saved ? configWithProvider({ baseUrl: saved }) : {});
    expect(prompter.text.mock.calls[0]?.[0]).toMatchObject({
      initialValue,
      placeholder: "http://127.0.0.1:8080",
    });
    expectDiscovery({ baseUrl });
  },
);

it.each([false, true, undefined])(
  "forwards private-network=%s to interactive and non-interactive discovery",
  async (saved) => {
    const config = configWithProvider({
      request: saved === undefined ? {} : { allowPrivateNetwork: saved },
    });
    await runSetup(prompterFor(LOCAL_BASE_URL), config);
    const nonInteractive = nonInteractiveContext({ customBaseUrl: LOCAL_BASE_URL });
    nonInteractive.config = config;
    await validate(nonInteractive);
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
      headers: AUTH_HEADERS,
      ...(managed
        ? {
            baseUrl: "http://127.0.0.1:19432/v1",
            timeoutSeconds: 600,
            params: { modelCacheDir: "/managed/cache" },
            localService: { command: "/runtime/llama-server" },
            models: [
              modelConfig({ id: "managed-model", params: { modelPath: "/managed/model.gguf" } }),
            ],
          }
        : {}),
    };
    const result = await runSetup(prompterFor(baseUrl), configWithProvider(provider, managed), {
      LLAMA_SERVER_API_KEY: "ambient-key",
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

it.each([
  ["profile", true, TENANT, "stored-profile-key"],
  ["Authorization", false, AUTH_HEADERS, undefined],
] as const)("preserves unchanged endpoint %s auth", async (_name, useProfile, headers, apiKey) => {
  runtimeApiKeyMock.mockResolvedValue("stored-profile-key");
  const result = await runSetup(
    prompterFor(LOCAL_ORIGIN, useProfile),
    configWithProvider({ headers }, useProfile),
    { LLAMA_SERVER_API_KEY: "ambient-key" },
  );
  expectDiscovery({ apiKey, headers });
  expect(configuredProvider(result)?.headers).toEqual(headers);
  expect(result.profiles).toEqual([]);
  if (useProfile) {
    expect(runtimeApiKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({ profileId: PROFILE_ID }),
    );
    expectAuthUnchanged();
  } else {
    expect(runtimeApiKeyMock).not.toHaveBeenCalled();
    expectProfileRemoved();
  }
});

it.each([false, true])(
  "prompts for and persists a key with replacement=%s",
  async (replacement) => {
    const url = replacement ? "http://replacement.example:8080" : LOCAL_ORIGIN;
    const key = "new-secret-key";
    const config = configWithProvider(
      {
        ...STALE_AUTH,
        headers: replacement ? AUTH_HEADERS : { authorization: "Bearer stale-key", ...TENANT },
      },
      replacement,
    );
    const env = replacement ? { LLAMA_SERVER_API_KEY: "old-endpoint-key" } : {};
    const result = await runSetup(prompterFor(url, true, key), config, env, "plaintext");
    expectDiscovery({ baseUrl: url + "/v1", apiKey: key });
    expect(result.profiles).toEqual([{ profileId: PROFILE_ID, credential: credential({ key }) }]);
    if (!replacement) {
      const provider = configuredProvider(result);
      expect(provider).toMatchObject({ auth: undefined, apiKey: undefined, headers: TENANT });
    }
  },
);

it.each(authPolicyCases)(
  "%s",
  async (_name, testCase, source, [expectedApiKey, expectedHeaders, action]) => {
    const origin = testCase.replacement ? "http://replacement.example:8080" : LOCAL_ORIGIN;
    discoverMock.mockResolvedValue(successfulDiscovery(origin));
    const ctx = nonInteractiveContext({
      customBaseUrl: `${origin}/v1`,
      ...testCase.opts,
    });
    ctx.agentDir = "/test/agent";
    ctx.config = configWithProvider(
      {
        ...(action === "preserve" ? {} : STALE_AUTH),
        headers: testCase.authorization ? AUTH_HEADERS : TENANT,
      },
      true,
    );
    ctx.resolveApiKey = vi.fn(async () => ({
      key: RESOLVED_KEY,
      source,
      ...(testCase.secretRef ? { envVarName: keyRef.id } : {}),
    }));
    ctx.toApiKeyCredential = vi.fn(({ resolved }) =>
      credential(testCase.secretRef ? { keyRef } : { key: resolved.key }),
    );
    const configured = await configure(ctx);
    const provider = configured?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
    expectDiscovery({ apiKey: expectedApiKey, headers: expectedHeaders });
    expect(provider?.headers).toEqual(expectedHeaders);
    if (action !== "preserve") {
      expect(provider).toMatchObject({ auth: undefined, apiKey: undefined });
    }
    if (action === "upsert") {
      expect(upsertProfileMock.mock.lastCall?.[0]).toMatchObject({
        profileId: PROFILE_ID,
        agentDir: "/test/agent",
        credential: testCase.secretRef ? { keyRef } : { key: RESOLVED_KEY },
      });
      expect(removeProfilesMock).not.toHaveBeenCalled();
    } else if (action === "preserve") {
      expectAuthUnchanged();
      expect(configured?.auth).toEqual(ctx.config.auth);
    } else {
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
  await expect(configure(ctx)).rejects.toThrow(
    "llama-server could not be reached at http://localhost:8080.",
  );
  expect(ctx.runtime.error).not.toHaveBeenCalled();
  expect(ctx.runtime.exit).not.toHaveBeenCalled();
  expectAuthUnchanged();
});

it("rejects a requested model absent from discovery", async () => {
  const ctx = nonInteractiveContext({ customModelId: "missing" });
  await expect(validate(ctx)).rejects.toThrow(
    "llama-server model missing was not found. Available models: qwen/model:Q4_K_M",
  );
  expect(ctx.runtime.exit).not.toHaveBeenCalled();
});
