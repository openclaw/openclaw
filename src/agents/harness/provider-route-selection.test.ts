import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  apiKey,
  authStore as makeAuthStore,
  model,
  oauth,
} from "../model-catalog-fixtures.test-support.js";
import { prepareAgentRuntimeAuth } from "../runtime-plan/prepare-auth.js";
import { registerAgentHarness } from "./registry.js";
import { selectAgentHarness, selectAgentHarnessForPreparedModelProviders } from "./selection.js";
import { projectPreparedModelProvider } from "./support.js";
import type { AgentHarness } from "./types.js";

let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  registrySnapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerHarness(
    "codex",
    (context) =>
      context.modelProvider?.runtimePolicy?.compatibleIds.includes("codex")
        ? { supported: true, priority: 100 }
        : { supported: false, reason: "Codex cannot reproduce the prepared provider route" },
    "codex",
  );
});

afterEach(() => restoreActivePluginRegistrySnapshot(registrySnapshot));

function registerHarness(id: string, supports: AgentHarness["supports"], ownerPluginId?: string) {
  registerAgentHarness(
    {
      id,
      label: id,
      supports,
      runAttempt: () => Promise.reject(new Error("Selection proof does not execute inference")),
    },
    { ownerPluginId },
  );
}

function providerConfig(provider: string, definition: ModelProviderConfig): OpenClawConfig {
  return {
    agents: { entries: { assistant: {} } },
    models: { providers: { [provider]: definition } },
  };
}

function selection(cfg: OpenClawConfig, modelId = "gpt-5.5", provider = "openai") {
  return { provider, modelId, agentId: "assistant", config: cfg };
}

function config(pinPrimary: boolean): OpenClawConfig {
  return {
    ...providerConfig("openai", {
      baseUrl: "https://api.openai.com/v1",
      api: "openai-completions",
      models: [],
    }),
    agents: {
      entries: { assistant: {} },
      defaults: {
        model: "openai/gpt-5.5",
        models: pinPrimary ? { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } : {},
        heartbeat: { model: "openai/gpt-5.4-mini" },
      },
    },
  };
}

function authStore(subscription: boolean) {
  return makeAuthStore({
    "openai:platform": apiKey("openai", "fixture-key"),
    ...(subscription ? { "openai:chatgpt": oauth("openai", Date.now() + 60_000) } : {}),
  });
}

describe("registered provider route selection", () => {
  it.each([
    ["exact row after legacy", ["legacy", "exact"], "Model", "custom-responses"],
    ["exact row before legacy", ["exact", "legacy"], "Model", "custom-responses"],
    ["legacy-only fallback", ["legacy"], "Model", "openclaw"],
    ["literal legacy selection", ["exact", "legacy"], "custom/Model", "openclaw"],
    ["same-spelling duplicates", ["exact", "duplicate"], "Model", "custom-responses"],
  ] as const)("uses the selected model transport for %s", (_label, ids, modelId, harness) => {
    registerHarness("custom-responses", ({ modelProvider }) =>
      modelProvider?.api === "openai-responses" &&
      modelProvider.baseUrl === "https://responses.example/v1" &&
      modelProvider.requestTransportOverrides === "none"
        ? { supported: true, priority: 100 }
        : { supported: false, reason: "Selected transport is not supported" },
    );
    const exact = model("Model", "Configured model", {
      api: "openai-responses",
      contextWindow: 64_000,
    });
    const rows: Record<"exact" | "legacy" | "duplicate", ModelDefinitionConfig> = {
      exact,
      legacy: {
        ...exact,
        id: "custom/Model",
        api: "openai-completions",
        baseUrl: "https://legacy.example/v1",
        headers: { "x-model-route": "legacy" },
      },
      duplicate: { ...exact, api: "openai-completions" },
    };
    const cfg = providerConfig("custom", {
      api: "openai-responses",
      baseUrl: "https://responses.example/v1",
      models: ids.map((row) => rows[row]),
    });
    expect(selectAgentHarness(selection(cfg, modelId, "custom")).id).toBe(harness);
  });

  it.each([
    ["Codex primary", true, true, "gpt-5.5", "codex", "openai:chatgpt", "subscription"],
    ["API Completions", false, false, "gpt-5.5", "openclaw", "openai:platform", "api-key"],
    ["heartbeat", true, true, "gpt-5.4-mini", "openclaw", "openai:chatgpt", "subscription"],
  ] as const)(
    "keeps %s on its supported route",
    (_label, pinPrimary, subscription, modelId, harness, profile, requirement) => {
      const selected = selection(config(pinPrimary), modelId);
      expect(selectAgentHarness(selected).id).toBe(harness);
      const prepared = prepareAgentRuntimeAuth({
        ...selected,
        env: {},
        authProfileStore: authStore(subscription),
      });
      expect(prepared.plan).toMatchObject({
        forwardedAuthProfileId: profile,
        modelRoute: { authRequirement: requirement },
      });
      const finalized = selectAgentHarnessForPreparedModelProviders({
        ...selected,
        modelProviders: prepared.attempts.map(({ plan, kind: attemptKind }) =>
          projectPreparedModelProvider({ plan, attemptKind }),
        ),
      });
      expect(finalized.id).toBe(harness);
    },
  );

  it("does not replace a required API profile to satisfy an explicit Codex runtime", () => {
    expect(() =>
      prepareAgentRuntimeAuth({
        ...selection(config(true)),
        env: {},
        authProfileStore: authStore(true),
        sessionAuthProfileId: "openai:platform",
        sessionAuthProfileSource: "user",
        allowAuthProfileFallback: false,
      }),
    ).toThrow(/requires subscription authentication/);
  });
});
