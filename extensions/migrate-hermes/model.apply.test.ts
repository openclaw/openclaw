import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
  HERMES_REASON_MODEL_PROVIDER_CONFLICT,
} from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { hermesCase } from "./test/hermes-case.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { makeConfigRuntime, makeContext, writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture();
const makeTestContext = fixture.context;

function defaultModelItem(status: "planned" | "migrated" | "conflict") {
  return {
    id: "config:default-model",
    kind: "config",
    action: "update",
    target: "agents.defaults.model",
    status,
    ...(status === "conflict" ? { reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED } : {}),
    details: { model: "openai/gpt-5.4" },
  };
}

async function planModel(yaml: string, overrides: Partial<Parameters<typeof makeContext>[0]> = {}) {
  const { stateDir, workspaceDir } = fixture.paths;
  const source = overrides.source ?? fixture.paths.source;
  await writeFile(path.join(source, "config.yaml"), yaml);
  return buildHermesMigrationProvider().plan(
    makeContext({ source, stateDir, workspaceDir, ...overrides }),
  );
}

describe("Hermes migration model apply", () => {
  beforeEach(async () => {
    await writeFile(
      path.join(fixture.paths.source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
  });

  it.each([false, true])(
    "updates only the effective primary (agent override=%s)",
    async (agentOverride) => {
      const h = hermesCase(fixture.paths.root);
      const shared = { primary: "google/gemini-3-pro", fallbacks: ["openai/gpt-5.4"] };
      const original = {
        primary: "anthropic/claude-sonnet-4.6",
        fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
        ...(!agentOverride ? { timeoutMs: 120_000 } : {}),
      };
      const expected = structuredClone({ ...original, primary: "openai/gpt-5.4" });
      h.config.agents = {
        defaults: { workspace: h.workspaceDir, model: agentOverride ? shared : original },
        ...(agentOverride ? { entries: { main: { model: original } } } : {}),
      };
      const provider = buildHermesMigrationProvider({ runtime: h.runtime });
      const result = await provider.apply(
        h.context({ config: h.config, overwrite: true, reportDir: h.reportDir }),
      );
      expect(result.items).toEqual([defaultModelItem("migrated")]);
      expect(h.config.agents?.defaults?.model).toEqual(agentOverride ? shared : expected);
      if (agentOverride) {
        expect(h.config.agents?.entries?.main?.model).toEqual(expected);
      }
    },
  );

  it("reports late-created default models as conflicts without overwriting", async () => {
    const { workspaceDir, reportDir } = fixture.paths;
    const lateConfig: OpenClawConfig = {
      agents: { defaults: { workspace: workspaceDir, model: "anthropic/claude-sonnet-4.6" } },
    };
    const provider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(lateConfig) });
    const ctx = makeTestContext({ reportDir });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expect(result.items).toEqual([defaultModelItem("conflict")]);
    expect(result.summary.conflicts).toBe(1);
    expect(lateConfig.agents?.defaults?.model).toBe("anthropic/claude-sonnet-4.6");
  });

  it.each([undefined, { primary: "old/model", fallbacks: ["backup/model"] }])(
    "applies an explicit target agent without changing shared or sibling models (%j)",
    async (model) => {
      const { source, workspaceDir } = fixture.paths;
      await writeFile(path.join(source, "config.yaml"), "model: imported/model\n");
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: workspaceDir, model: "shared/model" },
          entries: { main: { model: "main/model" }, research: { workspace: workspaceDir, model } },
        },
      };
      const ctx = makeTestContext({
        config,
        targetAgentId: "research",
        overwrite: true,
        runtime: makeConfigRuntime(config),
      });
      const provider = buildHermesMigrationProvider();
      const plan = await provider.plan(ctx);
      const result = await provider.apply(ctx, plan);

      expect(result.summary.errors).toBe(0);
      expect(config.agents?.defaults?.model).toBe("shared/model");
      expect(config.agents?.entries?.main?.model).toBe("main/model");
      expect(config.agents?.entries?.research?.model).toEqual(
        model ? { ...model, primary: "imported/model" } : "imported/model",
      );
      expect(plan.items[0]?.target).toContain("research");
    },
  );

  it("does not apply a custom default after its provider develops a late conflict", async () => {
    const { source, workspaceDir, reportDir } = fixture.paths;
    await writeFile(
      path.join(source, "config.yaml"),
      "model: {provider: 'custom:acme', default: imported-model}\n" +
        "providers: {acme: {base_url: 'https://new.example.test/v1', transport: openai_chat}}\n",
    );
    const lateConfig = {
      agents: { defaults: { workspace: workspaceDir } },
      models: {
        providers: {
          acme: { baseUrl: "https://old.example.test/v1", api: "openai-completions", models: [] },
        },
      },
    } as OpenClawConfig;
    const provider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(lateConfig) });
    const ctx = makeTestContext({ reportDir });
    const plan = await provider.plan(ctx);

    const result = await provider.apply(ctx, plan);

    expect(result.items.find((item) => item.id === "config:model-provider:acme")?.status).toBe(
      "conflict",
    );
    expect(result.items.find((item) => item.id === "config:default-model")).toMatchObject({
      status: "conflict",
      reason: HERMES_REASON_MODEL_PROVIDER_CONFLICT,
    });
    expect(lateConfig.agents?.defaults?.model).toBeUndefined();
  });
});

describe("Hermes migration model planning", () => {
  it("preserves the provider for top-level string model refs", async () => {
    const plan = await planModel("provider: openai\nmodel: gpt-5.4\n");
    expect(plan.items).toEqual([defaultModelItem("planned")]);
  });

  it.each([
    ["openrouter", "anthropic/claude-opus-4.7", "openrouter/anthropic/claude-opus-4.7"],
    ["custom:local", "vendor/model", "local/vendor/model"],
    ["auto", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6"],
  ])("preserves qualified model routing through %s", async (provider, model, expected) => {
    const plan = await planModel(`model:\n  provider: ${provider}\n  default: ${model}\n`);
    expect(plan.items[0]?.details?.model).toBe(expected);
    expect(plan.items.some((entry) => entry.id.startsWith("config:model-provider:"))).toBe(false);
  });

  it.each([
    "model: qwen-oauth/qwen3.5-plus\n",
    "model: {provider: qwen-cli, default: qwen3.5-plus}\n",
  ])("reauthenticates retired Qwen input %s", async (yaml) => {
    const plan = await planModel(yaml);

    expect(plan.items[0]?.details?.model).toBe("qwen/qwen3.5-plus");
    expect(plan.items.find((item) => item.id === "manual:auth-reauthenticate:qwen")?.reason).toBe(
      "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
    );
  });

  it("routes a model-scoped custom endpoint without an explicit provider", async () => {
    const plan = await planModel(
      "model:\n  default: vendor/current-model\n  base_url: https://models.example/v1\n",
    );

    expect(plan.items.find((item) => item.id === "config:default-model")?.details?.model).toBe(
      "custom/vendor/current-model",
    );
  });

  it("treats existing object-form default model primaries as conflicts", async () => {
    const plan = await planModel("model:\n  provider: openai\n  model: gpt-5.4\n", {
      model: { primary: "anthropic/claude-sonnet-4.6", fallbacks: ["openai/gpt-5.4"] },
    });
    expect(plan.items).toEqual([defaultModelItem("conflict")]);
  });

  it.each([["main/model", "imported/model", "skipped"]])(
    "checks the selected agent model instead of the default (%s, %s)",
    async (main, model, status) => {
      const { workspaceDir } = fixture.paths;
      const config: OpenClawConfig = {
        agents: {
          defaults: { workspace: workspaceDir },
          entries: { main: { model: main }, research: { workspace: workspaceDir, model } },
        },
      };
      const plan = await planModel("model: imported/model\n", {
        config,
        targetAgentId: "research",
      });
      expect(plan.items[0]?.status).toBe(status);
      expect(plan.items[0]?.target).toContain("research");
    },
  );
});
