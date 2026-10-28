import { afterAll, assert, beforeAll, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { configForProviders as config } from "./model-auth.fixtures.test-support.js";
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

vi.mock("./models-config.providers.implicit.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./models-config.providers.implicit.js")>()),
  resolveImplicitProviders: async () => ({}),
}));

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
type Providers = Record<string, ModelProviderConfig>;
type ModelsJson = { providers: Providers };

function provider(fields: Partial<ModelProviderConfig> = {}): ModelProviderConfig {
  return { baseUrl: "https://api.openai.com/v1", api: "openai-completions", models: [], ...fields };
}
const protectedSecrets = {
  apiKey: "OPENAI_API_KEY",
  headers: {
    Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
    "X-Tenant-Token": NON_ENV_SECRETREF_MARKER,
  },
};
const fileKey = { source: "file" as const, provider: "vault", id: "/token" };
const source = provider({
  apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
  headers: {
    Authorization: { source: "env", provider: "default", id: "OPENAI_HEADER_TOKEN" },
    "X-Tenant-Token": fileKey,
  },
});
const alias = {
  ...source,
  apiKey: { source: "env" as const, provider: "default", id: "OPENAI_CASE_VARIANT" },
};
const runtime = provider({
  apiKey: "sk-runtime-resolved", // pragma: allowlist secret
  headers: {
    Authorization: "Bearer runtime-openai-token",
    "X-Tenant-Token": "runtime-tenant-token",
  },
});

it("replaces resolved env and file API keys with source markers", () => {
  const moonshot = provider({ apiKey: "resolved-moonshot" });
  const providers = enforceSourceManagedProviderSecrets({
    providers: { openai: runtime, moonshot },
    sourceConfigForSecrets: config({ openai: source, moonshot: provider({ apiKey: fileKey }) }),
  });
  expect(providers?.openai?.apiKey).toBe("OPENAI_API_KEY");
  expect(providers?.moonshot?.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
});

it("invalidates cached readiness when projected config changes under the same runtime snapshot", async () => {
  const agentDir = await fixtureSuite.createCaseDir("agent");
  await withTempEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS, async () => {
    unsetEnv(MODELS_CONFIG_IMPLICIT_ENV_VARS);
    const candidate = (baseUrl: string, value: string) => {
      const headers = { ...runtime.headers, "X-OpenClaw-Test": value };
      return config({ openai: { ...runtime, baseUrl, headers } });
    };
    setRuntimeConfigSnapshot(config({ openai: runtime }), config({ openai: source }));
    await ensureOpenClawModelsJson(candidate(runtime.baseUrl!, "one"), agentDir);
    const expectProtectedProvider = async (value: string) => {
      const { providers } = await readGeneratedModelsJson<ModelsJson>(agentDir);
      expect(providers.openai).toMatchObject({
        ...protectedSecrets,
        baseUrl: runtime.baseUrl,
        headers: { ...protectedSecrets.headers, "X-OpenClaw-Test": value },
      });
    };
    await expectProtectedProvider("one");
    await ensureOpenClawModelsJson(candidate("https://mirror.example/v1", "two"), agentDir);
    // Merge mode preserves the authored URL while the changed header invalidates readiness.
    await expectProtectedProvider("two");
  });
});

it.each<Providers>([
  { openai: source, OpenAI: alias },
  { OpenAI: alias, openai: source },
  { " OpenAI ": source },
])("keeps canonical source secret ownership (ordering %#)", async (providers) => {
  const plan = await planModelsJsonForTest({
    cfg: config({ openai: runtime }),
    sourceConfigForSecrets: config(providers),
    agentDir: "/tmp/openclaw-models-plan",
    env: {},
  });
  assert(plan.action === "write");
  const { providers: generated }: ModelsJson = JSON.parse(plan.contents);
  expect(generated).toEqual({ openai: expect.objectContaining(protectedSecrets) });
});

it("uses a valid case alias when the canonical source entry is not a provider record", () => {
  const providers = enforceSourceManagedProviderSecrets({
    providers: { openai: runtime },
    sourceConfigForSecrets: config({ openai: null, OpenAI: source } as unknown as Providers),
  });
  expect(providers?.openai?.apiKey).toBe("OPENAI_API_KEY");
});
