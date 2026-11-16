import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveSecretRefValues, type SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { createQaGatewaySetupHarness } from "./gateway-child-setup.test-support.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const dirs = createTempDirHarness();
const setup = createQaGatewaySetupHarness();
afterEach(async () => {
  await setup.cleanup();
  await dirs.cleanup();
  vi.restoreAllMocks();
});

it.each(["env", "env-default", "file"] as const)(
  "retains the selected %s SecretRef's resolution contract",
  async (source) => {
    const root = await dirs.makeTempDir("qa-secretref-source-");
    const sourcePath = path.join(root, "source.json");
    const secretPath = path.join(root, "fixture-key.json");
    const fixtureKey = "qa-synthetic-credential-not-for-network";
    await writeFile(secretPath, JSON.stringify({ key: fixtureKey }), { mode: 0o600 });
    const ref: SecretRef = {
      source: source === "file" ? "file" : "env",
      provider: "qa_fixture",
      id: source === "file" ? "/key" : "QA_FIXTURE_API_KEY",
    };
    const secretProviders: NonNullable<NonNullable<OpenClawConfig["secrets"]>["providers"]> = {
      unused: { source: "env", allowlist: ["UNRELATED_SECRET"] },
    };
    if (source !== "env-default") {
      secretProviders.qa_fixture =
        source === "env"
          ? { source: "env", allowlist: [ref.id] }
          : { source: "file", path: path.relative(process.cwd(), secretPath), mode: "json" };
    }
    const sourceConfig: OpenClawConfig = {
      secrets: {
        defaults: { env: "qa_fixture" },
        providers: secretProviders,
      },
      models: {
        providers: {
          "custom-openai": {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-responses",
            apiKey: ref,
            models: [],
          },
        },
      },
    };
    const fixtureEnv: NodeJS.ProcessEnv =
      source === "file" ? {} : { QA_FIXTURE_API_KEY: fixtureKey };
    // The real resolver establishes valid source input without using live credentials.
    const sourceValues = await resolveSecretRefValues([ref], {
      config: sourceConfig,
      env: fixtureEnv,
    });
    expect([...sourceValues.values()]).toEqual([fixtureKey]);
    await writeFile(sourcePath, JSON.stringify(sourceConfig), { mode: 0o600 });
    const { cfg } = await setup.prepare(
      {
        providerMode: "live-frontier",
        primaryModel: "custom-openai/fixture",
        alternateModel: "custom-openai/fixture",
        controlUiEnabled: false,
      },
      {
        OPENCLAW_CONFIG_PATH: sourcePath,
        OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: sourcePath,
        ...fixtureEnv,
      },
    );
    expect(cfg.models?.providers?.["custom-openai"]?.apiKey).toEqual(ref);
    const childValues = await resolveSecretRefValues([ref], { config: cfg, env: fixtureEnv });
    expect([...childValues.values()]).toEqual([fixtureKey]);
    expect(cfg.secrets?.providers?.unused).toBeUndefined();
    expect(cfg.secrets?.defaults).toEqual({ env: "qa_fixture" });
    if (source === "file") {
      expect(cfg.secrets?.providers?.qa_fixture).toMatchObject({ path: secretPath });
    }
    expect(JSON.stringify(cfg)).not.toContain(fixtureKey);
  },
);

it("retains request-header dependencies and an explicit env deny policy", async () => {
  const root = await dirs.makeTempDir("qa-secretref-policy-");
  const sourcePath = path.join(root, "source.json");
  const ref: SecretRef = { source: "env", provider: "headers", id: "QA_HEADER_API_KEY" };
  const sourceConfig: OpenClawConfig = {
    secrets: { providers: { headers: { source: "env", allowlist: [] } } },
    models: {
      providers: {
        "custom-openai": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-responses",
          request: { headers: { "X.Qa.Auth": ref } },
          models: [],
        },
      },
    },
  };
  const env = { QA_HEADER_API_KEY: "qa-synthetic-denied-key" };
  await expect(resolveSecretRefValues([ref], { config: sourceConfig, env })).rejects.toMatchObject({
    code: "SECRET_REF_POLICY_DENIED",
  });
  await writeFile(sourcePath, JSON.stringify(sourceConfig), { mode: 0o600 });
  const { cfg } = await setup.prepare(
    {
      providerMode: "live-frontier",
      primaryModel: "custom-openai/fixture",
      alternateModel: "custom-openai/fixture",
      controlUiEnabled: false,
    },
    { OPENCLAW_QA_LIVE_PROVIDER_CONFIG_PATH: sourcePath, ...env },
  );
  await expect(resolveSecretRefValues([ref], { config: cfg, env })).rejects.toMatchObject({
    code: "SECRET_REF_POLICY_DENIED",
  });
});
