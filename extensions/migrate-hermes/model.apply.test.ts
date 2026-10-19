// Migrate Hermes tests cover model.apply plugin behavior.
import path from "node:path";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
  HERMES_REASON_MODEL_PROVIDER_CONFLICT,
} from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { makeConfigRuntime, writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture();
const makeTestContext = fixture.context;

function defaultModelItem(status: "migrated" | "conflict") {
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

describe("Hermes migration model apply", () => {
  beforeEach(async () => {
    await writeFile(
      path.join(fixture.paths.source, "config.yaml"),
      "model:\n  provider: openai\n  model: gpt-5.4\n",
    );
  });

  it("updates only the primary model when applying over object-form model config", async () => {
    const { workspaceDir, reportDir } = fixture.paths;
    const existingConfig = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          model: {
            primary: "anthropic/claude-sonnet-4.6",
            fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            timeoutMs: 120_000,
          },
        },
      },
    } as OpenClawConfig;
    const provider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(existingConfig) });

    const result = await provider.apply(
      makeTestContext({
        overwrite: true,
        model: existingConfig.agents?.defaults?.model,
        reportDir,
      }),
    );

    expect(result.items).toEqual([defaultModelItem("migrated")]);
    expect(existingConfig.agents?.defaults?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
      timeoutMs: 120_000,
    });
  });

  it("updates the default-agent model override when applying with overwrite", async () => {
    const { workspaceDir, reportDir } = fixture.paths;
    const sharedModel = { primary: "google/gemini-3-pro", fallbacks: ["openai/gpt-5.4"] };
    const existingConfig = {
      agents: {
        defaults: { workspace: workspaceDir, model: sharedModel },
        entries: {
          main: {
            model: {
              primary: "anthropic/claude-sonnet-4.6",
              fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
            },
          },
        },
      },
    } as OpenClawConfig;
    const provider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(existingConfig) });

    const result = await provider.apply(
      makeTestContext({ config: existingConfig, overwrite: true, reportDir }),
    );

    expect(result.items).toEqual([defaultModelItem("migrated")]);
    expect(existingConfig.agents?.entries?.main?.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["openrouter/anthropic/claude-opus-4.6"],
    });
    expect(existingConfig.agents?.defaults?.model).toEqual(sharedModel);
  });

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
