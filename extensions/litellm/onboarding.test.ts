import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  capturePluginRegistration,
  createTestWizardPrompter,
  requireRegisteredProvider,
  type WizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { applyProviderAuthConfigPatch } from "openclaw/plugin-sdk/provider-auth";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { Agent, EnvHttpProxyAgent, ProxyAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../test-support/runtime-spies.js";
import plugin from "./index.js";

const discoveryFetch = vi.fn();

const reply = (body: unknown, status = 200) => Response.json(body, { status });
function expectModel(config: OpenClawConfig, modelId: string) {
  expect(config.models?.providers?.litellm?.models.map(({ id }) => id)).toEqual([modelId]);
}
function expectDiscoveryKey(key: string) {
  expect(discoveryFetch).toHaveBeenCalledExactlyOnceWith(
    "http://127.0.0.1:4000/v1/models",
    expect.objectContaining({
      headers: expect.objectContaining({ Authorization: `Bearer ${key}` }),
    }),
  );
}

function createPrompter(
  params: {
    baseUrl?: string;
    selected?: string;
    cancel?: boolean;
    manualModel?: string;
  } = {},
) {
  async function selectOption<T>(prompt: { options: Array<{ value: T }> }): Promise<T> {
    if (params.cancel) {
      throw new WizardCancelledError();
    }
    const option =
      prompt.options.find(({ value }) => value === params.selected) ?? prompt.options[0];
    if (!option) {
      throw new Error("Expected a selectable option");
    }
    return option.value;
  }
  const text = vi.fn(async (prompt: Parameters<WizardPrompter["text"]>[0]) => {
    if (prompt.message === "LiteLLM proxy base URL") {
      return params.baseUrl ?? "http://127.0.0.1:4000/v1";
    }
    if (prompt.message === "Environment variable name") {
      return "LITELLM_TEST_KEY";
    }
    return params.manualModel ?? "local-qwen";
  });
  const prompter = createTestWizardPrompter({ select: selectOption, text });
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
  const provider = requireRegisteredProvider(
    capturePluginRegistration(plugin).providers,
    "litellm",
  );
  const auth = provider.auth[0];
  if (!auth) {
    throw new Error("Expected LiteLLM API-key auth");
  }
  const context: ProviderAuthContext = {
    config,
    opts: params.ref ? {} : { litellmApiKey: "resolved-fixture-key" },
    env: params.ref ? { LITELLM_TEST_KEY: "resolved-reference-key" } : {},
    runtime: createRuntimeSpies(),
    prompter: params.prompter ?? createPrompter(),
    secretInputMode: params.ref ? "ref" : "plaintext",
    credentialOnly: params.credentialOnly,
    assertCurrent: params.assertCurrent,
    isRemote: false,
    openUrl: async () => {
      throw new Error("Unexpected browser auth");
    },
    oauth: {
      createVpsAwareHandlers: () => {
        throw new Error("Unexpected OAuth");
      },
    },
  };
  const result = await auth.run(context);
  return { result, config: applyProviderAuthConfigPatch(config, result.configPatch, result) };
}

describe("LiteLLM discovery-backed onboarding", () => {
  beforeEach(() => {
    discoveryFetch.mockReset();
    discoveryFetch.mockImplementation(async () =>
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

  it("defaults to the first served model and saves it without the hosted seed", async () => {
    const prompter = createPrompter({ baseUrl: "http://127.0.0.1:4000" });
    const { result, config } = await configure({ prompter });

    expectDiscoveryKey("resolved-fixture-key");
    expect(prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: "local-qwen" }),
    );
    expect(result.defaultModel).toBe("litellm/local-qwen");
    expect(config.agents?.defaults?.model).toEqual({ primary: "litellm/local-qwen" });
    expect(config.agents?.defaults?.models).toEqual({ "litellm/local-qwen": { alias: "LiteLLM" } });
    expectModel(config, "local-qwen");
  });

  it("preserves a selected proxy alias containing a slash", async () => {
    const { result, config } = await configure({
      prompter: createPrompter({ selected: "team/second-model" }),
    });

    expect(result.defaultModel).toBe("litellm/team/second-model");
    expectModel(config, "team/second-model");
  });

  it.each([
    { failure: "HTTP", response: () => reply({ error: "unavailable" }, 503), reason: /503/ },
    { failure: "empty", response: () => reply({ data: [] }), reason: /no models|empty/i },
    {
      failure: "malformed",
      response: () => reply({ unexpected: [] }),
      reason: /invalid|malformed/i,
    },
  ])("shows the $failure failure reason before manual entry", async ({ response, reason }) => {
    discoveryFetch.mockImplementation(async () => response());
    const prompter = createPrompter({ manualModel: "manual-model" });
    const { result, config } = await configure({ prompter });

    expect(prompter.note).toHaveBeenCalledWith(expect.stringMatching(reason), expect.any(String));
    expect(result.defaultModel).toBe("litellm/manual-model");
    expectModel(config, "manual-model");
  });

  it("propagates cancellation instead of applying the hosted default", async () => {
    await expect(configure({ prompter: createPrompter({ cancel: true }) })).rejects.toBeInstanceOf(
      WizardCancelledError,
    );
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

  it("keeps credential-only connections out of model discovery", async () => {
    const prompter = createPrompter();
    const { result } = await configure({ credentialOnly: true, prompter });

    expect(discoveryFetch).not.toHaveBeenCalled();
    expect(prompter.select).not.toHaveBeenCalled();
    expect(result.defaultModel).toBeUndefined();
    expect(result.profiles[0]?.profileId).toBe("litellm:default");
  });
});
