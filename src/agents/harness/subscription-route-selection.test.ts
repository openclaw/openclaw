import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("registered OpenAI subscription route selection", () => {
  it.each([
    {
      label: "explicit Codex primary",
      pinPrimary: true,
      subscription: true,
      modelId: "gpt-5.5",
      harness: "codex",
      profile: "openai:chatgpt",
      requirement: "subscription",
    },
    {
      label: "API-only unpinned Completions",
      pinPrimary: false,
      subscription: false,
      modelId: "gpt-5.5",
      harness: "openclaw",
      profile: "openai:platform",
      requirement: "api-key",
    },
    {
      label: "heartbeat inheriting subscription preference",
      pinPrimary: true,
      subscription: true,
      modelId: "gpt-5.4-mini",
      harness: "openclaw",
      profile: "openai:chatgpt",
      requirement: "subscription",
    },
  ])("keeps $label on its supported route", (fixture) => {
    const selection = {
      provider: "openai",
      modelId: fixture.modelId,
      config: config(fixture.pinPrimary),
      agentId: "assistant",
    };
    expect(selectAgentHarness(selection).id).toBe(fixture.harness);
    const prepared = prepareAgentRuntimeAuth({
      ...selection,
      env: {},
      authProfileStore: authStore(fixture.subscription),
    });
    expect(prepared.plan).toMatchObject({
      forwardedAuthProfileId: fixture.profile,
      modelRoute: { authRequirement: fixture.requirement },
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
    expect(finalized.id).toBe(fixture.harness);
  });

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
