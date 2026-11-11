import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import { ModelsConfigSchema } from "../config/zod-schema.core.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { configForProviders, modelDefinition } from "./model-auth.fixtures.test-support.js";
import { planModelsJsonForTest } from "./models-config.plan.test-support.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

// mock-isolation: normalization consumes hook results without loading the plugin runtime.
vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: () => undefined,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
}));

// mock-isolation: exercise real catalog planning without external provider discovery.
vi.mock("./models-config.providers.implicit.js", () => ({
  resolveImplicitProviders: async () => ({}),
}));

describe("provider normalization through catalog planning", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  type Providers = NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;
  const provider = (overrides: Partial<Providers[string]> = {}): Providers[string] => ({
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    models: [],
    ...overrides,
  });
  const plan = (
    providers: Providers,
    options: Partial<Parameters<typeof planModelsJsonForTest>[0]> = {},
  ) =>
    planModelsJsonForTest({
      ...options,
      cfg: options.cfg ?? configForProviders(providers),
      sourceConfigForSecrets: options.sourceConfigForSecrets ?? {},
      agentDir: options.agentDir ?? tempDirs.make("provider-normalize-"),
      env: options.env ?? {},
    });
  const publish = async (
    providers: Providers,
    options: Partial<Parameters<typeof planModelsJsonForTest>[0]> = {},
  ) => {
    const result = await plan(providers, options);
    if (result.action !== "write") {
      throw new Error(`Expected a catalog write, received ${result.action}`);
    }
    return {
      providers: ModelsConfigSchema.parse(JSON.parse(result.contents))?.providers,
      contents: result.contents,
    };
  };

  const canonical = provider({ apiKey: "OPENAI_API_KEY" }); // pragma: allowlist secret
  const alias = provider({
    baseUrl: "https://example.com/v1",
    apiKey: "CUSTOM_OPENAI_API_KEY", // pragma: allowlist secret
    models: [modelDefinition("gpt-4.1-mini")],
  });
  it.each<[string, Providers, Providers[string]]>([
    ["canonical before alias", { openai: canonical, " openai ": alias }, canonical],
    ["canonical after alias", { " openai ": alias, openai: canonical }, canonical],
    ["latest alias without canonical", { " openai": canonical, "openai ": alias }, alias],
  ])("publishes one provider for %s", async (_label, providers, expected) => {
    const published = await publish(providers);
    expect(Object.keys(published.providers ?? {})).toEqual(["openai"]);
    expect(published.providers?.openai).toEqual(expected);
  });

  it("deduplicates model rows and keeps repeated publication stable with secret ownership", async () => {
    const agentDir = tempDirs.make("provider-normalize-");
    const pinned = modelDefinition("gemini-3.1-pro-preview", { name: "Pinned Gemini" });
    const expected = structuredClone(pinned);
    const providers = {
      google: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        api: "google-generative-ai",
        apiKey: "GOOGLE_API_KEY", // pragma: allowlist secret
        models: [
          modelDefinition("gemini-3-pro-preview", { name: "Alias Gemini" }),
          pinned,
          modelDefinition("gemini-3.1-pro-preview", { name: "Discovered Gemini" }),
        ],
      },
    } satisfies Providers;

    const published = await publish(providers, { agentDir });

    // Exact authored rows beat aliases; the first exact row keeps its configured details.
    expect(published.providers?.google?.models).toEqual([expected]);
    expect(published.providers?.google?.apiKey).toBe("GOOGLE_API_KEY");

    const repeated = await plan(providers, {
      agentDir,
      existingRaw: published.contents,
      existingParsed: JSON.parse(published.contents),
    });
    expect(repeated).toEqual({ action: "noop", pluginCatalogWrites: {} });

    const existing = {
      providers: { google: { ...providers.google, apiKey: "stale-inline-google-key" } },
    };
    const refreshed = await publish(providers, {
      agentDir,
      existingRaw: `${JSON.stringify(existing, null, 2)}\n`,
      existingParsed: existing,
    });
    expect(refreshed.providers?.google?.apiKey).toBe("GOOGLE_API_KEY");
    expect(refreshed.contents).not.toContain("stale-inline-google-key");
    expect(refreshed.providers?.google?.models).toEqual([expected]);
  });

  it("replaces resolved env var value with env var name to prevent plaintext persistence", async () => {
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test-secret-value-12345", // pragma: allowlist secret
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const providers = {
      openai: provider({
        apiKey: "sk-test-secret-value-12345", // pragma: allowlist secret; simulates resolved ${OPENAI_API_KEY}
        models: [modelDefinition("gpt-4.1")],
      }),
    };
    const published = await publish(providers, { env });
    expect(published.providers?.openai?.apiKey).toBe("OPENAI_API_KEY");
    expect(published.contents).not.toContain("sk-test-secret-value-12345");
  });

  it("normalizes SecretRef-backed provider headers to non-secret marker values", async () => {
    const providers = {
      openai: provider({
        headers: {
          Authorization: { source: "env", provider: "default", id: "OPENAI_HEADER_TOKEN" },
          "X-Tenant-Token": { source: "file", provider: "vault", id: "/openai/token" },
        },
      }),
    };
    const published = await publish(providers);
    // Env refs persist the env-name marker; non-env refs collapse to a non-secret sentinel.
    expect(published.providers?.openai?.headers).toEqual({
      Authorization: "secretref-env:OPENAI_HEADER_TOKEN",
      "X-Tenant-Token": NON_ENV_SECRETREF_MARKER,
    });
  });

  it.each([
    [
      "substituted literal",
      "${HEADER_SOURCE}",
      { HEADER_SOURCE: "${HEADER_LITERAL}" },
      "${HEADER_LITERAL}",
    ],
    ["pending reference", "$HEADER_PENDING", {}, "secretref-env:HEADER_PENDING"],
  ] satisfies Array<[string, string, NodeJS.ProcessEnv, string]>)(
    "preserves loader %s headers through normalization and source enforcement",
    async (_label, authored, env, expected) => {
      await withOpenClawTestState(
        {
          label: "catalog-header-facts",
          env: { HEADER_LITERAL: undefined, HEADER_PENDING: undefined, ...env },
        },
        async (state) => {
          await state.writeConfig({
            plugins: { enabled: false },
            ...configForProviders({
              custom: provider({
                baseUrl: "https://provider.example/v1",
                apiKey: "plain-fixture-key",
                headers: { "X.Trace": authored },
              }),
            }),
          });
          const snapshot = await readConfigFileSnapshotFromContext(
            createConfigIoContext({
              configPath: state.configPath,
              env: state.env,
              homedir: () => state.home,
              observe: false,
            }),
          );
          expect(snapshot.valid).toBe(true);
          const params = {
            providers: snapshot.config.models?.providers,
            sourceConfigForSecrets: snapshot.sourceConfig,
          };
          const published = await publish(snapshot.config.models?.providers ?? {}, {
            cfg: snapshot.config,
            sourceConfigForSecrets: snapshot.sourceConfig,
            agentDir: state.agentDir(),
            env: state.env,
          });
          const enforced = enforceSourceManagedProviderSecrets(params);
          expect({
            published: published.providers?.custom?.headers?.["X.Trace"],
            enforced: enforced?.custom?.headers?.["X.Trace"],
          }).toEqual({ published: expected, enforced: expected });
        },
      );
    },
  );
});
