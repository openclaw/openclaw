import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { prepareAgentRuntimeAuth } from "../runtime-plan/prepare-auth.js";
import { registerAgentHarness } from "./registry.js";
import { selectAgentHarness, selectAgentHarnessForPreparedModelProviders } from "./selection.js";
import { projectPreparedModelProvider } from "./support.js";

let registrySnapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;

beforeEach(() => {
  registrySnapshot = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
  registerAgentHarness(
    {
      id: "codex",
      label: "Codex route fixture",
      supports: (context) =>
        context.modelProvider?.runtimePolicy?.compatibleIds.includes("codex")
          ? { supported: true, priority: 100 }
          : { supported: false, reason: "Codex cannot reproduce the prepared provider route" },
      async runAttempt() {
        throw new Error("Selection proof does not execute inference");
      },
    },
    { ownerPluginId: "codex" },
  );
});

afterEach(() => restoreActivePluginRegistrySnapshot(registrySnapshot));

function config(pinPrimary: boolean): OpenClawConfig {
  return {
    agents: {
      entries: { assistant: {} },
      defaults: {
        model: "openai/gpt-5.5",
        models: pinPrimary ? { "openai/gpt-5.5": { agentRuntime: { id: "codex" } } } : {},
        heartbeat: { model: "openai/gpt-5.4-mini" },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          models: [],
        },
      },
    },
  };
}

function authStore(subscription: boolean): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "openai:platform": { type: "api_key", provider: "openai", key: "fixture-key" },
      ...(subscription
        ? {
            "openai:chatgpt": {
              type: "oauth" as const,
              provider: "openai",
              access: "fixture-access",
              refresh: "fixture-refresh",
              expires: Date.now() + 60_000,
            },
          }
        : {}),
    },
  };
}

describe("registered provider route selection", () => {
  it.each([
    ["exact row after legacy", ["legacy", "exact"], "Model", "custom-responses"],
    ["exact row before legacy", ["exact", "legacy"], "Model", "custom-responses"],
    ["legacy-only fallback", ["legacy"], "Model", "openclaw"],
    ["literal legacy selection", ["exact", "legacy"], "custom/Model", "openclaw"],
    ["same-spelling duplicates", ["exact", "duplicate"], "Model", "custom-responses"],
  ] as const)(
    "uses the selected model transport for %s",
    (_label, selectedRows, modelId, harness) => {
      registerAgentHarness({
        id: "custom-responses",
        label: "Custom Responses harness",
        supports: ({ modelProvider }) =>
          modelProvider?.api === "openai-responses" &&
          modelProvider.baseUrl === "https://responses.example/v1" &&
          modelProvider.requestTransportOverrides === "none"
            ? { supported: true, priority: 100 }
            : { supported: false, reason: "Selected transport is not supported" },
        async runAttempt() {
          throw new Error("Selection proof does not execute inference");
        },
      });
      const exact: ModelDefinitionConfig = {
        id: "Model",
        name: "Configured model",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64_000,
        maxTokens: 1024,
      };
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
      const cfg: OpenClawConfig = {
        agents: { entries: { assistant: {} } },
        models: {
          providers: {
            custom: {
              api: "openai-responses",
              baseUrl: "https://responses.example/v1",
              models: selectedRows.map((row) => rows[row]),
            },
          },
        },
      };
      expect(
        selectAgentHarness({
          provider: "custom",
          modelId,
          agentId: "assistant",
          config: cfg,
        }).id,
      ).toBe(harness);
    },
  );

  it.each([
    ["Codex primary", true, true, "gpt-5.5", "codex", "openai:chatgpt", "subscription"],
    ["API Completions", false, false, "gpt-5.5", "openclaw", "openai:platform", "api-key"],
    ["heartbeat", true, true, "gpt-5.4-mini", "openclaw", "openai:chatgpt", "subscription"],
  ] as const)(
    "keeps %s on its supported route",
    (_label, pinPrimary, subscription, modelId, harness, profile, requirement) => {
      const selection = {
        provider: "openai",
        modelId,
        config: config(pinPrimary),
        agentId: "assistant",
      };
      expect(selectAgentHarness(selection).id).toBe(harness);
      const prepared = prepareAgentRuntimeAuth({
        ...selection,
        env: {},
        authProfileStore: authStore(subscription),
      });
      expect(prepared.plan).toMatchObject({
        forwardedAuthProfileId: profile,
        modelRoute: { authRequirement: requirement },
      });
      const finalized = selectAgentHarnessForPreparedModelProviders({
        ...selection,
        modelProviders: prepared.attempts.map((attempt) =>
          projectPreparedModelProvider({
            plan: attempt.plan,
            attemptKind: attempt.kind,
          }),
        ),
      });
      expect(finalized.id).toBe(harness);
    },
  );

  it("does not replace a required API profile to satisfy an explicit Codex runtime", () => {
    expect(() =>
      prepareAgentRuntimeAuth({
        provider: "openai",
        modelId: "gpt-5.5",
        config: config(true),
        agentId: "assistant",
        env: {},
        authProfileStore: authStore(true),
        sessionAuthProfileId: "openai:platform",
        sessionAuthProfileSource: "user",
        allowAuthProfileFallback: false,
      }),
    ).toThrow(/requires subscription authentication/);
  });
});
