import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
  requireRegisteredProvider,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { Agent, EnvHttpProxyAgent, ProxyAgent } from "undici";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { createNoBrowserAuth } from "../test-support/no-browser-auth.test-support.js";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const discoveryFetch = vi.fn();
const servedModel: ModelDefinitionConfig = {
  id: "local-qwen",
  name: "Authored local model",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
  contextWindow: 32768,
  maxTokens: 2048,
};
const authoredProvider = {
  baseUrl: "http://127.0.0.1:4000/v1",
  api: "anthropic-messages" as const,
  apiKey: "  authored-key  ",
  request: { allowPrivateNetwork: false, headers: { "X-Proxy-Tenant": "fixture" } },
  models: [servedModel],
};

const reply = (body: unknown, status = 200) => Response.json(body, { status });
function expectModel({ result, config }: Awaited<ReturnType<typeof configure>>, modelId: string) {
  expect(result.defaultModel).toBe(`litellm/${modelId}`);
  expect(config.models?.providers?.litellm?.models.map(({ id }) => id)).toEqual([modelId]);
}
function expectDiscoveryKey(key: string, baseUrl = "http://127.0.0.1:4000/v1") {
  expect(discoveryFetch).toHaveBeenCalledExactlyOnceWith(
    `${baseUrl.replace(/\/v1$/, "")}/v1/models`,
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }),
  );
}

function createPrompter(params: { baseUrl?: string; manualModel?: string } = {}) {
  const answers: Record<string, string> = {
    "LiteLLM proxy base URL": params.baseUrl ?? "http://127.0.0.1:4000/v1",
    "Environment variable name": "LITELLM_TEST_KEY",
  };
  const text = vi.fn(
    async ({ message }: Parameters<WizardPrompter["text"]>[0]) =>
      answers[message] ?? params.manualModel ?? "local-qwen",
  );
  const prompter = createTestWizardPrompter({ text });
  vi.spyOn(prompter, "select");
  return prompter;
}

async function configure(
  params: {
    config?: OpenClawConfig;
    prompter?: WizardPrompter;
    ref?: boolean;
    credentialOnly?: boolean;
    assertCurrent?: () => void;
  } = {},
) {
  const config = params.config ?? {};
  const providers = capturePluginRegistration(plugin).providers;
  const [auth] = requireRegisteredProvider(providers, "litellm").auth;
  assert(auth, "Expected LiteLLM API-key auth");
  const result = await auth.run({
    config,
    opts: params.ref ? {} : { litellmApiKey: "resolved-fixture-key" },
    env: params.ref ? { LITELLM_TEST_KEY: "resolved-reference-key" } : {},
    runtime: createRuntimeSpies(),
    prompter: params.prompter ?? createPrompter(),
    secretInputMode: params.ref ? "ref" : "plaintext",
    credentialOnly: params.credentialOnly,
    assertCurrent: params.assertCurrent,
    isRemote: false,
    ...createNoBrowserAuth(),
  });
  return { result, config: applyProviderAuthConfigPatch(config, result.configPatch, result) };
}

beforeEach(() => {
  discoveryFetch
    .mockReset()
    .mockImplementation(async () =>
      reply({ data: [{ id: "local-qwen" }, { id: "team/second-model" }] }),
    );
  vi.stubGlobal("__OPENCLAW_TEST_UNDICI_RUNTIME_DEPS__", {
    Agent,
    EnvHttpProxyAgent,
    ProxyAgent,
    fetch: discoveryFetch,
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["http://127.0.0.1:4000", "http://127.0.0.1:4000", undefined],
  ["", "http://localhost:4000", undefined],
  ["  https://127.0.0.1:4000/v1//  ", "https://127.0.0.1:4000/v1", "http://127.0.0.1:4001"],
  ["", "http://127.0.0.1:4001", "http://127.0.0.1:4001"],
])(
  "normalizes %j to %j and selects the first served model",
  async (answer, expectedUrl, initialValue) => {
    const prompter = createPrompter({ baseUrl: answer });
    const configured = await configure({
      prompter,
      config: initialValue
        ? {
            models: { providers: { litellm: { baseUrl: initialValue, models: [] } } },
          }
        : {},
    });

    expectDiscoveryKey("resolved-fixture-key", expectedUrl);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "LiteLLM proxy base URL",
        initialValue,
        placeholder: "http://localhost:4000",
      }),
    );
    expect(configured.config.agents?.defaults).toEqual({
      model: { primary: "litellm/local-qwen" },
      models: { "litellm/local-qwen": { alias: "LiteLLM" } },
    });
    expectModel(configured, "local-qwen");
    expect(configured.config.models?.providers?.litellm?.baseUrl).toBe(expectedUrl);
    expect(configured.result.profiles).toEqual([
      {
        profileId: "litellm:default",
        credential: { type: "api_key", provider: "litellm", key: "resolved-fixture-key" },
      },
    ]);
  },
);

it.each([
  ["not-a-url", "Enter a full URL, such as http://localhost:4000"],
  ["ftp://litellm.example", "must start with http:// or https://"],
])("rejects invalid proxy URL %s", async (answer, expected) => {
  const prompter = createTestWizardPrompter({
    text: async ({ validate }) => {
      expect(validate?.(answer)).toContain(expected);
      for (const accepted of ["", "http://localhost:4000", "https://litellm.example/v1"]) {
        expect(validate?.(accepted)).toBeUndefined();
      }
      throw new WizardCancelledError();
    },
  });
  await expect(configure({ prompter })).rejects.toBeInstanceOf(WizardCancelledError);
});

it("preserves a selected proxy alias containing a slash", async () => {
  const prompter = createPrompter();
  vi.mocked(prompter.select).mockImplementation(async ({ options }) => {
    const option = options.find(({ value }) => value === "team/second-model");
    assert(option, "Expected proxy alias option");
    return option.value;
  });
  expectModel(await configure({ prompter }), "team/second-model");
});

it.each([
  ["HTTP", { error: "unavailable" }, 503, /503/],
  ["empty", { data: [] }, 200, /no models|empty/i],
  ["malformed", { unexpected: [] }, 200, /invalid|malformed/i],
] as const)(
  "shows the %s failure reason before manual entry",
  async (_failure, body, status, reason) => {
    discoveryFetch.mockImplementation(async () => reply(body, status));
    const prompter = createPrompter({ manualModel: "manual-model" });
    const configured = await configure({ prompter });
    expect(prompter.note).toHaveBeenCalledWith(expect.stringMatching(reason), expect.any(String));
    expectModel(configured, "manual-model");
  },
);

it("propagates cancellation instead of applying the hosted default", async () => {
  const prompter = createPrompter();
  vi.mocked(prompter.select).mockRejectedValue(new WizardCancelledError());
  await expect(configure({ prompter })).rejects.toBeInstanceOf(WizardCancelledError);
});

it("propagates revoked authority instead of offering manual entry", async () => {
  const revoked = new Error("Setup config changed; rerun setup.");
  let current = true;
  discoveryFetch.mockImplementation(async () => {
    current = false;
    throw revoked;
  });
  const prompter = createPrompter();

  await expect(
    configure({
      prompter,
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
    }),
  ).rejects.toBe(revoked);
  expect(prompter.select).not.toHaveBeenCalled();
  expect(prompter.text).not.toHaveBeenCalledWith(
    expect.objectContaining({ message: "LiteLLM model ID" }),
  );
});

it("uses the resolved reference for discovery and retains its stored shape", async () => {
  const { result } = await configure({ ref: true });

  expectDiscoveryKey("resolved-reference-key");
  expect(result.profiles).toEqual([
    {
      profileId: "litellm:default",
      credential: {
        type: "api_key",
        provider: "litellm",
        keyRef: { source: "env", provider: "default", id: "LITELLM_TEST_KEY" },
      },
    },
  ]);
});

it.each([
  ["merge", false],
  ["replace", false],
  ["merge", true],
] as const)(
  "preserves authored metadata in %s mode with canonical row %s",
  async (mode, canonical) => {
    const selected = structuredClone(authoredProvider);
    if (canonical) {
      selected.baseUrl = "https://canonical.example/v1";
      selected.apiKey = "canonical-key";
      selected.models = [{ ...servedModel, params: { temperature: 0.3 } }];
    }
    const prompter = createPrompter({ baseUrl: "https://selected.example/v1" });
    const { config } = await configure({
      prompter,
      config: {
        models: {
          mode,
          providers: {
            LiteLLM: structuredClone(authoredProvider),
            ...(canonical ? { litellm: structuredClone(selected) } : {}),
          },
        },
      },
    });

    expect(Object.keys(config.models?.providers ?? {})).toEqual(["litellm"]);
    expect(config.models?.mode).toBe(mode);
    expect(prompter.text).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: selected.baseUrl }),
    );
    expect(config.models?.providers?.litellm).toEqual({
      ...selected,
      baseUrl: "https://selected.example/v1",
      api: "openai-completions",
      apiKey: canonical ? "canonical-key" : "authored-key",
    });
  },
);

it("keeps credential-only connections out of model discovery", async () => {
  const prompter = createPrompter();
  const { result } = await configure({ credentialOnly: true, prompter });

  expect(discoveryFetch).not.toHaveBeenCalled();
  expect(prompter.select).not.toHaveBeenCalled();
  expect(result.defaultModel).toBeUndefined();
  expect(result.profiles[0]?.profileId).toBe("litellm:default");
});
