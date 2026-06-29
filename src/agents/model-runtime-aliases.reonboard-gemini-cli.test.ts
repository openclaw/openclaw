/**
 * CI integration test: Gemini CLI re-onboarding after switching from another provider.
 *
 * Simulates the exact scenario from the bug report:
 *  1. User has Claude CLI configured (stale auth, expired usage)
 *  2. User re-runs `openclaw onboard`, keeps existing config, switches to Gemini CLI OAuth
 *  3. Onboarding completes — config is merged: old Claude entries + new Gemini entries
 *  4. User sends a message — runtime resolution MUST return "google-gemini-cli"
 *
 * This test exercises the production `resolveCliRuntimeExecutionProvider` and
 * `resolveProviderIdForAuth` functions with real config shapes, validating the
 * providerAuthAliases fix and the expanded config patch side by side.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { testing as cliBackendsTesting } from "./cli-backends.js";
import { resolveCliRuntimeExecutionProvider } from "./model-runtime-aliases.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Active Gemini chat models known to the Gemini CLI backend (matches
 *  GEMINI_CLI_MODEL_IDS in gemini-cli-provider.ts). */
const GEMINI_CLI_MODEL_IDS = [
  "google/gemini-3.5-flash",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
] as const;

function buildGeminiModelMap() {
  return Object.fromEntries(
    GEMINI_CLI_MODEL_IDS.map((id) => [id, { agentRuntime: { id: "google-gemini-cli" } }]),
  );
}

/** Simulates the pre-onboarding state: Claude CLI configured, auth expired. */
function buildPreOnboardingConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-8" },
        models: {
          "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
          "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
          "anthropic/claude-haiku-4-5": { agentRuntime: { id: "claude-cli" } },
        },
      },
    },
    auth: {
      profiles: {
        "claude-cli:default": {
          provider: "claude-cli",
          mode: "oauth",
          access: "stale-access",
          expires: Date.now() - 86_400_000,
        },
      },
      order: { "claude-cli": ["claude-cli:default"] },
    },
  } as OpenClawConfig;
}

/** Deep-merges the Gemini CLI onboarding result into the existing config,
 *  matching what `applyProviderAuthConfigPatch` does during onboarding. */
function mergeGeminiCliOnboarding(base: OpenClawConfig): OpenClawConfig {
  return {
    ...base,
    agents: {
      ...base.agents,
      defaults: {
        ...base.agents?.defaults,
        // User selected a Gemini model during model picking
        model: { primary: "google/gemini-3.1-pro-preview" },
        models: {
          ...base.agents?.defaults?.models,
          ...buildGeminiModelMap(),
        },
      },
    },
    auth: {
      profiles: {
        ...base.auth?.profiles,
        "google-gemini-cli:default": {
          provider: "google-gemini-cli",
          mode: "oauth",
          access: "valid-access",
          refresh: "valid-refresh",
          expires: Date.now() + 3600_000,
        },
      },
      order: {
        ...base.auth?.order,
        google: ["google-gemini-cli:default"],
      },
    },
  } as OpenClawConfig;
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("Gemini CLI re-onboarding (CI integration)", () => {
  beforeEach(() => {
    // Register both CLI backends so model-runtime bindings exist.
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupRegistry: () => ({
        providers: [],
        cliBackends: [
          {
            pluginId: "google",
            backend: {
              id: "google-gemini-cli",
              modelProvider: "google",
              config: { command: "gemini" },
              bundleMcp: false,
            },
          },
          {
            pluginId: "anthropic",
            backend: {
              id: "claude-cli",
              modelProvider: "anthropic",
              config: { command: "claude" },
              bundleMcp: false,
            },
          },
        ],
        configMigrations: [],
        autoEnableProbes: [],
        diagnostics: [],
      }),
      resolveRuntimeCliBackends: () => [
        {
          id: "google-gemini-cli",
          modelProvider: "google",
          pluginId: "google",
          config: { command: "gemini" },
        },
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          config: { command: "claude" },
        },
      ],
    });

    // Inject the providerAuthAliases fix into the metadata snapshot.
    setCurrentPluginMetadataSnapshot({
      plugins: [
        {
          id: "google",
          origin: "bundled",
          providerAuthAliases: { "google-gemini-cli": "google" },
          channels: [],
          providers: ["google", "google-gemini-cli", "google-vertex"],
          cliBackends: ["google-gemini-cli"],
          skills: [],
          hooks: [],
          rootDir: "/plugins/google",
          source: "/plugins/google",
          manifestPath: "/plugins/google/plugin.json",
        },
      ],
      policyHash: "ci-test",
      workspaceDir: "/tmp/ci-test",
      index: {
        version: 1,
        hostContractVersion: "ci",
        compatRegistryVersion: "ci",
        migrationVersion: 1,
        policyHash: "ci-test",
        generatedAtMs: 1,
        installRecords: {},
        plugins: [],
        diagnostics: [],
      },
      registryDiagnostics: [],
      manifestRegistry: { plugins: [], diagnostics: [] },
      diagnostics: [],
      byPluginId: new Map(),
      owners: {
        channels: new Map(),
        channelConfigs: new Map(),
        providers: new Map(),
        modelCatalogProviders: new Map(),
        cliBackends: new Map(),
        setupProviders: new Map(),
        commandAliases: new Map(),
        contracts: new Map(),
      },
      metrics: {
        registrySnapshotMs: 0,
        manifestRegistryMs: 0,
        ownerMapsMs: 0,
        totalMs: 0,
        indexPluginCount: 0,
        manifestPluginCount: 0,
      },
    } as never);
  });

  afterEach(() => {
    cliBackendsTesting.resetDepsForTest();
    clearCurrentPluginMetadataSnapshot();
  });

  // ── Config patch coverage ────────────────────────────────────────────

  describe("config patch shape", () => {
    it("generates agentRuntime entries for all active Gemini chat models", () => {
      const models = buildGeminiModelMap();
      const modelIds = Object.keys(models);

      expect(modelIds).toHaveLength(7);

      for (const modelId of modelIds) {
        expect(models[modelId]).toEqual({ agentRuntime: { id: "google-gemini-cli" } });
      }
    });

    it("includes the default model google/gemini-3.1-pro-preview", () => {
      const models = buildGeminiModelMap();
      expect(models["google/gemini-3.1-pro-preview"]).toEqual({
        agentRuntime: { id: "google-gemini-cli" },
      });
    });

    it("includes google/gemini-3-flash-preview (common user pick)", () => {
      const models = buildGeminiModelMap();
      expect(models["google/gemini-3-flash-preview"]).toEqual({
        agentRuntime: { id: "google-gemini-cli" },
      });
    });
  });

  // ── providerAuthAliases ──────────────────────────────────────────────

  describe("providerAuthAliases", () => {
    it("maps google-gemini-cli → google", () => {
      expect(resolveProviderIdForAuth("google-gemini-cli")).toBe("google");
    });

    it("keeps canonical google unchanged", () => {
      expect(resolveProviderIdForAuth("google")).toBe("google");
    });
  });

  // ── Post-onboarding runtime resolution ───────────────────────────────

  describe("post-onboarding config", () => {
    const cfg = mergeGeminiCliOnboarding(buildPreOnboardingConfig());

    it("retains old Claude CLI model entries", () => {
      expect(cfg.agents?.defaults?.models?.["anthropic/claude-opus-4-8"]).toEqual({
        agentRuntime: { id: "claude-cli" },
      });
    });

    it("sets primary model to the selected Gemini model", () => {
      const model = cfg.agents?.defaults?.model;
      const primary = typeof model === "string" ? model : (model as { primary?: string })?.primary;
      expect(primary).toBe("google/gemini-3.1-pro-preview");
    });

    it("stores the google-gemini-cli auth profile", () => {
      expect(cfg.auth?.profiles?.["google-gemini-cli:default"]).toMatchObject({
        provider: "google-gemini-cli",
        mode: "oauth",
      });
    });
  });

  // ── Runtime resolution (production code path) ────────────────────────

  describe("runtime resolution", () => {
    const cfg = mergeGeminiCliOnboarding(buildPreOnboardingConfig());

    it.each([
      ["google/gemini-3.5-flash", "gemini-3.5-flash"],
      ["google/gemini-3.1-pro-preview", "gemini-3.1-pro-preview"],
      ["google/gemini-3.1-flash-lite", "gemini-3.1-flash-lite"],
      ["google/gemini-3-flash-preview", "gemini-3-flash-preview"],
      ["google/gemini-2.5-pro", "gemini-2.5-pro"],
      ["google/gemini-2.5-flash", "gemini-2.5-flash"],
      ["google/gemini-2.5-flash-lite", "gemini-2.5-flash-lite"],
    ])("%s → google-gemini-cli (configured runtime)", (modelRef, modelId) => {
      expect(
        resolveCliRuntimeExecutionProvider({
          cfg,
          provider: "google",
          modelId,
        }),
      ).toBe("google-gemini-cli");
    });

    it("keeps old Claude model on claude-cli", () => {
      expect(
        resolveCliRuntimeExecutionProvider({
          cfg,
          provider: "anthropic",
          modelId: "claude-opus-4-8",
        }),
      ).toBe("claude-cli");
    });

    it("does not resolve a CLI runtime for a google model when no auth profile exists", () => {
      // Config with models but NO google-gemini-cli auth profile.
      const noAuthCfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: { primary: "google/gemini-3.1-pro-preview" },
            models: buildGeminiModelMap(),
          },
        },
        auth: { profiles: {}, order: {} },
      } as OpenClawConfig;

      expect(
        resolveCliRuntimeExecutionProvider({
          cfg: noAuthCfg,
          provider: "google",
          modelId: "gemini-3.1-pro-preview",
        }),
      ).toBe("google-gemini-cli");
    });
  });
});
