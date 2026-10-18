// Migrate Hermes tests cover model.plan plugin behavior.
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { describe, expect, it } from "vitest";
import { HERMES_REASON_DEFAULT_MODEL_CONFIGURED } from "./items.js";
import { buildHermesMigrationProvider } from "./provider.js";
import { useHermesFixture } from "./test/migration-fixture.js";
import { makeContext, writeFile } from "./test/provider-helpers.js";

const fixture = useHermesFixture();

async function planModel(yaml: string, overrides: Partial<Parameters<typeof makeContext>[0]> = {}) {
  const { stateDir, workspaceDir } = fixture.paths;
  const source = overrides.source ?? fixture.paths.source;
  await writeFile(path.join(source, "config.yaml"), yaml);
  return buildHermesMigrationProvider().plan(
    makeContext({ source, stateDir, workspaceDir, ...overrides }),
  );
}

function expectedHermesModelPlanItems(status: "planned" | "conflict") {
  return [
    {
      id: "config:default-model",
      kind: "config",
      action: "update",
      target: "agents.defaults.model",
      status,
      ...(status === "conflict" ? { reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED } : {}),
      details: { model: "openai/gpt-5.4" },
    },
  ];
}

describe("Hermes migration model planning", () => {
  it("preserves the provider for top-level string model refs", async () => {
    const plan = await planModel("provider: openai\nmodel: gpt-5.4\n");
    expect(plan.items).toEqual(expectedHermesModelPlanItems("planned"));
  });

  it("preserves provider routing for vendor-qualified models and normalizes aliases", async () => {
    const { root } = fixture.paths;
    const cases = [
      ["openrouter", "anthropic/claude-opus-4.7", "openrouter/anthropic/claude-opus-4.7"],
      ["custom:local", "vendor/model", "local/vendor/model"],
      ["openai-codex", "gpt-5.6", "openai/gpt-5.6"],
      ["azure-foundry", "gpt-5.4", "microsoft-foundry/gpt-5.4"],
      ["bedrock", "anthropic.claude-opus-4-6-v1", "amazon-bedrock/anthropic.claude-opus-4-6-v1"],
      ["copilot", "gpt-5.4", "github-copilot/gpt-5.4"],
      ["gemini", "gemini-3.1-pro", "google/gemini-3.1-pro"],
      ["glm", "glm-5.2", "zai/glm-5.2"],
      ["kimi-for-coding", "kimi-k2.5", "moonshot/kimi-k2.5"],
      ["kimi-coding", "kimi-k2.5", "moonshot/kimi-k2.5"],
      ["kimi", "kimi-for-coding/kimi-k2.5", "moonshot/kimi-k2.5"],
      ["moonshot", "kimi-k2.5", "moonshot/kimi-k2.5"],
      ["alibaba", "qwen3.5-plus", "qwen/qwen3.5-plus"],
      ["dashscope", "qwen3.6-plus", "qwen/qwen3.6-plus"],
      ["alibaba-coding-plan", "qwen3-coder-next", "qwen/qwen3-coder-next"],
      ["xai-oauth", "grok-4.1-fast", "xai/grok-4.1-fast"],
      ["minimax-oauth", "MiniMax-M2.7", "minimax-portal/MiniMax-M2.7"],
      ["minimax-cn", "MiniMax-M2.7", "minimax/MiniMax-M2.7"],
      ["opencode-zen", "gpt-5.4", "opencode/gpt-5.4"],
      ["auto", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6"],
      ["qwen-cli", "qwen3.5-plus", "qwen/qwen3.5-plus"],
      ["qwen-oauth", "qwen3.5-plus", "qwen/qwen3.5-plus"],
      ["qwen-portal", "qwen3.5-plus", "qwen/qwen3.5-plus"],
      ["vertex", "gemini-3.1-pro", "google-vertex/gemini-3.1-pro"],
      ["custom:My Local LLM", "local-model", "my-local-llm/local-model"],
    ] as const;
    for (const [hermesProvider, model, expected] of cases) {
      const source = path.join(root, hermesProvider.replaceAll(":", "-"));
      const plan = await planModel(`model:\n  provider: ${hermesProvider}\n  default: ${model}\n`, {
        source,
      });
      expect(plan.items[0]?.details?.model).toBe(expected);
      expect(plan.items.some((item) => item.id.startsWith("config:model-provider:"))).toBe(
        ["alibaba", "dashscope", "minimax-cn"].includes(hermesProvider),
      );
      if (["qwen-cli", "qwen-oauth", "qwen-portal"].includes(hermesProvider)) {
        const reauthItem = plan.items.find((item) => item.id === "manual:auth-reauthenticate:qwen");
        expect(reauthItem?.reason).toBe(
          "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
        );
      }
    }
  });

  it("rewrites a provider-qualified retired Qwen model without a separate provider field", async () => {
    const plan = await planModel("model: qwen-oauth/qwen3.5-plus\n");

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
    expect(plan.items).toEqual(expectedHermesModelPlanItems("conflict"));
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
