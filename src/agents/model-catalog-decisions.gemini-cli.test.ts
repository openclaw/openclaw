import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createCapturedPluginRegistration } from "../test-utils/plugin-registration.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import type { AuthProfileCredential } from "./auth-profiles/types.js";
import { resolveCliExecutionAuthProfileId } from "./cli-execution-auth.js";
import { createModelCatalogDecisions } from "./model-catalog-decisions.js";
import { apiKey, authStore, oauth, row, snapshot } from "./model-catalog-fixtures.test-support.js";

const runtime = "google-gemini-cli";
const modelId = "gemini-2.5-pro";
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [{ id: "google", providers: ["google"], cliBackends: [runtime] }],
});
const registry = createEmptyPluginRegistry();
let backend: CliBackendPlugin;
beforeAll(async () => {
  const plugin = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
    pluginId: "google",
    artifactBasename: "setup-api.js",
  });
  const captured = createCapturedPluginRegistration({ id: "google" });
  plugin.default.register?.(captured.api);
  const gemini = captured.cliBackends.find((entry) => entry.id === runtime);
  if (!gemini?.prepareExecution) {
    throw new Error("Google setup must register Gemini CLI execution preparation");
  }
  backend = gemini;
  registry.cliBackends.push({ pluginId: "google", source: "fixture", backend });
});

const cases: Array<{
  name: string;
  credential?: AuthProfileCredential;
  selected: boolean;
  automatic?: boolean;
  available: boolean | undefined;
  admissionOnly?: boolean;
}> = [
  { name: "missing account", selected: true, available: false },
  { name: "wrong provider", credential: apiKey("other"), selected: true, available: false },
  {
    name: "unsupported canonical OAuth",
    credential: oauth("google", 1),
    selected: true,
    available: false,
  },
  {
    name: "unsupported CLI token",
    credential: { type: "token", provider: runtime, token: "synthetic-token" },
    selected: true,
    available: false,
  },
  { name: "Google API key", credential: apiKey("google"), selected: true, available: true },
  { name: "CLI API key", credential: apiKey(runtime), selected: true, available: true },
  {
    name: "unmaterialized CLI API-key reference",
    credential: {
      type: "api_key",
      provider: runtime,
      keyRef: { source: "env", provider: "default", id: "UNMATERIALIZED_GEMINI_TEST_KEY" },
    },
    selected: true,
    available: undefined,
    admissionOnly: true,
  },
  {
    name: "invalid CLI API-key reference",
    credential: {
      type: "api_key",
      provider: runtime,
      keyRef: { source: "file", provider: "absent", id: "key" },
    },
    selected: true,
    available: false,
    admissionOnly: true,
  },
  {
    name: "CLI-owned OAuth refresh",
    credential: { ...oauth(runtime, 1), projectId: "synthetic-project" },
    selected: true,
    available: true,
  },
  { name: "native login without stored accounts", selected: false, available: true },
  { name: "missing automatic preference", selected: true, automatic: true, available: true },
];

afterEach(() => vi.unstubAllEnvs());

function projectModels(
  owner: ReturnType<typeof createModelCatalogDecisions>,
  cfg: OpenClawConfig,
  catalog: ReturnType<typeof snapshot>,
  paths: { agentDir: string; workspaceDir: string },
  includeDetails = false,
) {
  return buildModelsListResult({
    source: {
      kind: "gateway",
      context: {
        getRuntimeConfig: () => cfg,
        loadGatewayModelCatalogSnapshot: async () => ({
          ...catalog,
          ...paths,
          agentId: "main",
          config: cfg,
          catalogComplete: true,
        }),
        logGateway: { debug() {} },
      },
    },
    agentId: "main",
    params: { view: "configured", includeDetails },
    preloadedCatalog: { agentId: "main", config: cfg, snapshot: catalog },
    catalogProjector: owner,
    preloadedOnly: true,
  });
}

it.each(
  ["google", runtime].flatMap((provider) =>
    cases.map((scenario) => Object.assign({ provider }, scenario)),
  ),
)("$provider: $name preserves execution admission and credential readiness", async (scenario) => {
  vi.stubEnv("GOOGLE_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH", "");
  vi.stubEnv("UNMATERIALIZED_GEMINI_TEST_KEY", "");
  await withTempDir("openclaw-gemini-admission-", async (workspaceDir) => {
    await withPluginRuntimeRegistryScope(registry, async () => {
      const { provider } = scenario;
      const agentDir = path.join(workspaceDir, "agent");
      const entry = row(provider, modelId);
      const recovery = row("recovery", "model");
      const catalog = snapshot([entry, recovery]);
      const cfg: OpenClawConfig = {
        plugins: { entries: { google: { enabled: true } } },
        agents: {
          defaults: {
            model: { primary: `${provider}/${modelId}` },
            models: {
              [`${provider}/${modelId}`]: { agentRuntime: { id: runtime } },
              "recovery/model": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      };
      const store = authStore({
        recovery: apiKey("recovery"),
        ...(scenario.selected ? { shared: apiKey("google") } : {}),
        ...(scenario.credential ? { selected: scenario.credential } : {}),
      });
      const expectedProfile = scenario.automatic
        ? provider === "google"
          ? "shared"
          : undefined
        : scenario.selected
          ? "selected"
          : undefined;
      const preparationContext = {
        workspaceDir,
        agentDir,
        provider: runtime,
        modelId,
        authProfileId: expectedProfile,
        authCredential: expectedProfile ? store.profiles[expectedProfile] : undefined,
      };
      // Exercise Google's actual staging owner, not just the core forwarding selector.
      const preparation = backend.prepareExecution!(preparationContext);
      if (scenario.available === true) {
        const prepared = await preparation;
        try {
          if (expectedProfile) {
            expect(prepared?.beforeExecution).toBeTypeOf("function");
            await prepared?.beforeExecution?.();
            if (scenario.credential?.type === "oauth") {
              const home = prepared?.env?.GEMINI_CLI_HOME;
              if (!home) {
                throw new Error("Gemini OAuth preparation must supply its isolated home");
              }
              const staged = JSON.parse(
                await fs.readFile(path.join(home, ".gemini", "oauth_creds.json"), "utf8"),
              );
              expect(staged).toMatchObject({ refresh_token: "synthetic-refresh", expiry_date: 1 });
            } else {
              expect(prepared?.env?.GEMINI_API_KEY).toBe("synthetic-key");
            }
          } else {
            expect(prepared).toBeNull();
          }
        } finally {
          await prepared?.cleanup?.();
        }
      } else {
        await expect(preparation).rejects.toThrow();
      }
      const admission = resolveCliExecutionAuthProfileId({
        cliExecutionProvider: runtime,
        authProfileProvider: provider,
        config: cfg,
        agentDir,
        metadataSnapshot,
        selected: scenario.selected
          ? { authProfileId: "selected", authProfileIdSource: scenario.automatic ? "auto" : "user" }
          : undefined,
        loadAuthProfileStoreForRuntimeAsync: async () => store,
      });
      if (scenario.available === true || scenario.admissionOnly) {
        await expect(admission).resolves.toBe(expectedProfile);
      } else {
        await expect(admission).rejects.toThrow(
          scenario.credential ? "cannot use auth profile" : "No credentials found",
        );
      }
      const owner = createModelCatalogDecisions({
        cfg,
        agentId: "main",
        agentDir,
        workspaceDir,
        snapshot: catalog,
        metadataSnapshot,
        pluginRegistry: registry,
        preparedAuthStore: store,
        preparedRuntimeAuthModes: { [runtime]: "oauth" },
        preparedSyntheticAuthComplete: true,
        // A session's selected model provider scopes its explicit account override.
        profileProvider: provider,
        ...(scenario.selected
          ? {
              preferredProfileId: "selected",
              ...(scenario.automatic ? {} : { pinnedProfileId: "selected" }),
            }
          : {}),
      });
      const evaluated = owner.evaluateEntry(entry);
      expect(evaluated.availability).toBe(scenario.available);
      expect(owner.evaluateNative(entry, evaluated).availability).toBe(scenario.available);
      expect(owner.evaluateEntry(recovery).availability).toBe(true);
      const result = await projectModels(owner, cfg, catalog, { agentDir, workspaceDir });
      const projected = result.models.find((model) => model.id === modelId);
      expect(projected).toBeDefined();
      expect(projected?.available).toBe(scenario.available ?? false);
      if (scenario.available === undefined) {
        // Unknown static material is not native auth. The ordinary picker disables it;
        // detailed projections retain the distinction without claiming an auth failure.
        expect(evaluated.runtimeAuth).toBeUndefined();
        expect(projected?.unavailableReason).toBeUndefined();
        const detailed = await projectModels(owner, cfg, catalog, { agentDir, workspaceDir }, true);
        const detail = detailed.models.find((model) => model.id === modelId);
        expect(detail).toBeDefined();
        expect(detail?.available).toBeUndefined();
      }
    });
  });
});

it.each(["openclaw", runtime])(
  "keeps %s Google recovery available for an unscoped account from another provider",
  async (runtimeId) => {
    await withPluginRuntimeRegistryScope(registry, async () => {
      const entry = row("google", modelId);
      const catalog = snapshot([entry]);
      const workspaceDir = "/tmp/gemini-recovery-workspace";
      const agentDir = path.join(workspaceDir, "agent");
      const cfg: OpenClawConfig = {
        plugins: { entries: { google: { enabled: true } } },
        agents: {
          defaults: {
            model: { primary: `google/${modelId}` },
            models: { [`google/${modelId}`]: { agentRuntime: { id: runtimeId } } },
          },
        },
      };
      const owner = createModelCatalogDecisions({
        cfg,
        agentId: "main",
        agentDir,
        workspaceDir,
        snapshot: catalog,
        metadataSnapshot,
        pluginRegistry: registry,
        preparedAuthStore: authStore({
          selected: apiKey("anthropic"),
          google: apiKey("google"),
        }),
        preparedRuntimeAuthModes: { [runtime]: "oauth" },
        preparedSyntheticAuthComplete: true,
        preferredProfileId: "selected",
        pinnedProfileId: "selected",
      });
      expect(owner.evaluateEntry(entry).availability).toBe(true);
      const result = await projectModels(owner, cfg, catalog, { agentDir, workspaceDir });
      expect(result.models.find((model) => model.id === modelId)?.available).toBe(true);
    });
  },
);
