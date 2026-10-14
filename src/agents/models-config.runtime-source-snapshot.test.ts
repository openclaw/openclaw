import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import {
  installModelsConfigTestHooks,
  MODELS_CONFIG_IMPLICIT_ENV_VARS,
  unsetEnv,
  withTempEnv,
} from "./models-config.e2e-harness.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => ({ plugins: [] }),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  listKnownProviderEnvApiKeyNames: () => ["OPENAI_API_KEY"],
  resolveProviderEnvAuthLookupMaps: () => ({
    aliasMap: {},
    envCandidateMap: { openai: ["OPENAI_API_KEY"] },
    authEvidenceMap: {},
  }),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

vi.mock("./models-config.providers.js", async () => {
  const actual = await vi.importActual<typeof import("./models-config.providers.js")>(
    "./models-config.providers.js",
  );
  return {
    ...actual,
    resolveImplicitProviders: async () => ({}),
  };
});

installModelsConfigTestHooks();

let setRuntimeConfigSnapshot: typeof import("../config/io.js").setRuntimeConfigSnapshot;
let ensureOpenClawModelsJson: typeof import("./models-config.js").ensureOpenClawModelsJson;
let planModelsJsonForTest: typeof import("./models-config.plan.test-support.js").planModelsJsonForTest;
let readGeneratedModelsJson: typeof import("./models-config.test-utils.js").readGeneratedModelsJson;
const fixtureSuite = createFixtureSuite("openclaw-models-runtime-source-");

beforeAll(async () => {
  await fixtureSuite.setup();
  ({ setRuntimeConfigSnapshot } = await import("../config/io.js"));
  ({ ensureOpenClawModelsJson } = await import("./models-config.js"));
  ({ planModelsJsonForTest } = await import("./models-config.plan.test-support.js"));
  ({ readGeneratedModelsJson } = await import("./models-config.test-utils.js"));
});
afterAll(() => fixtureSuite.cleanup());

function provider(fields: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return { baseUrl: "https://api.openai.com/v1", api: "openai-completions", models: [], ...fields };
}
const source = provider({
  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
  headers: {
    Authorization: { source: "env", provider: "default", id: "OPENAI_HEADER_TOKEN" },
    "X-Tenant-Token": { source: "file", provider: "vault", id: "/providers/openai/tenantToken" },
  },
});
const runtime = provider({
  apiKey: "sk-runtime-resolved", // pragma: allowlist secret
  headers: {
    Authorization: "Bearer runtime-openai-token",
    "X-Tenant-Token": "runtime-tenant-token",
  },
});

describe("models-config runtime source snapshot", () => {
  it("replaces resolved env and file API keys with source markers", () => {
    const providers = enforceSourceManagedProviderSecrets({
      providers: { openai: runtime, moonshot: provider({ apiKey: "sk-runtime-moonshot" }) }, // pragma: allowlist secret
      sourceConfigForSecrets: {
        models: {
          providers: {
            openai: source,
            moonshot: provider({
              apiKey: { source: "file", provider: "vault", id: "/moonshot/apiKey" },
            }),
          },
        },
      },
    });
    expect(providers?.openai?.apiKey).toBe("OPENAI_API_KEY");
    expect(providers?.moonshot?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("invalidates cached readiness when projected config changes under the same runtime snapshot", async () => {
    const agentDir = await fixtureSuite.createCaseDir("agent");
    await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
      unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
      const sourceConfig = { models: { providers: { openai: source } } };
      const runtimeConfig = { models: { providers: { openai: runtime } } };
      const candidate = (baseUrl: string, value: string): OpenClawConfig => ({
        models: {
          providers: {
            openai: {
              ...runtime,
              baseUrl,
              headers: { ...runtime.headers, "X-OpenClaw-Test": value },
            },
          },
        },
      });
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      await ensureOpenClawModelsJson(candidate(runtime.baseUrl!, "one"), agentDir);
      const readProvider = async () =>
        (
          await readGeneratedModelsJson<{
            providers: Record<string, ModelProviderConfig>;
          }>(agentDir)
        ).providers.openai;
      expect(await readProvider()).toMatchObject({
        baseUrl: runtime.baseUrl,
        apiKey: "OPENAI_API_KEY",
        headers: {
          "X-OpenClaw-Test": "one",
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Tenant-Token": NON_ENV_SECRETREF_MARKER,
        },
      });
      await ensureOpenClawModelsJson(candidate("https://mirror.example/v1", "two"), agentDir);
      // Merge mode preserves the authored URL while the changed header invalidates readiness.
      expect(await readProvider()).toMatchObject({
        baseUrl: runtime.baseUrl,
        apiKey: "OPENAI_API_KEY",
        headers: {
          "X-OpenClaw-Test": "two",
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Tenant-Token": NON_ENV_SECRETREF_MARKER,
        },
      });
    });
  });

  it.each(["before", "after", "absent"] as const)(
    "keeps source secret ownership with the canonical key %s the alias",
    async (position) => {
      const alias = {
        ...source,
        apiKey: { source: "env" as const, provider: "default", id: "OPENAI_CASE_VARIANT" },
      };
      const providers: Record<string, ModelProviderConfig> =
        position === "before"
          ? { openai: source, OpenAI: alias }
          : position === "after"
            ? { OpenAI: alias, openai: source }
            : { " OpenAI ": source };
      const plan = await planModelsJsonForTest({
        cfg: { models: { providers: { openai: runtime } } },
        sourceConfigForSecrets: { models: { providers } },
        agentDir: "/tmp/openclaw-models-plan",
        env: {},
      });
      expect(plan.action).toBe("write");
      if (plan.action !== "write") {
        throw new Error(`Expected write, got ${plan.action}`);
      }
      const { providers: generated }: { providers: Record<string, ModelProviderConfig> } =
        JSON.parse(plan.contents);
      expect(Object.keys(generated)).toEqual(["openai"]);
      expect(generated.openai).toMatchObject({
        apiKey: "OPENAI_API_KEY",
        headers: {
          Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
          "X-Tenant-Token": NON_ENV_SECRETREF_MARKER,
        },
      });
    },
  );

  it("uses a valid case alias when the canonical source entry is not a provider record", () => {
    const sourceProviders = { openai: null, OpenAI: source } as unknown as NonNullable<
      NonNullable<OpenClawConfig["models"]>["providers"]
    >;
    const providers = enforceSourceManagedProviderSecrets({
      providers: { openai: runtime },
      sourceConfigForSecrets: { models: { providers: sourceProviders } },
    });
    expect(providers?.openai?.apiKey).toBe("OPENAI_API_KEY");
  });
});
