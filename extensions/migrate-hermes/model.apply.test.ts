import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
  HERMES_REASON_MODEL_PROVIDER_CONFLICT,
} from "./items.js";
import { hermesCase, item as migrationItem } from "./test/hermes-case.js";
import { useHermesFixture } from "./test/migration-fixture.js";

const fixture = useHermesFixture();
const makeCase = () => hermesCase(fixture.paths.root);

async function planModel(
  yaml: string,
  overrides: Parameters<ReturnType<typeof makeCase>["plan"]>[0] = {},
) {
  const h = makeCase();
  await h.write("config.yaml", yaml);
  return h.plan(overrides);
}

describe("Hermes migration model apply", () => {
  beforeEach(() => makeCase().write("config.yaml", "model: {provider: openai, model: gpt-5.4}\n"));

  it.each([false, true])("preserves model options (agent override=%s)", async (agentOverride) => {
    const h = makeCase();
    const shared = { primary: "google/gemini-3-pro", fallbacks: ["openai/gpt-5.4"] };
    const original = { primary: "old/model", fallbacks: ["backup/model"], timeoutMs: 120_000 };
    const expected = structuredClone({ ...original, primary: "openai/gpt-5.4" });
    h.config.agents = {
      defaults: { workspace: h.workspaceDir, model: agentOverride ? shared : original },
      ...(agentOverride ? { entries: { main: { model: original } } } : {}),
    };
    expect(migrationItem(await h.plan({ config: h.config }), "config:default-model")).toMatchObject(
      {
        status: "conflict",
        reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
      },
    );
    const result = await h.import({ overwrite: true });
    expect(migrationItem(result, "config:default-model")?.status).toBe("migrated");
    expect(h.config.agents?.defaults?.model).toEqual(agentOverride ? shared : expected);
    if (agentOverride) {
      expect(h.config.agents?.entries?.main?.model).toEqual(expected);
    }
  });

  it("preserves late-created default models", async () => {
    const h = makeCase();
    const plan = await h.plan();
    h.config.agents = {
      defaults: { workspace: h.workspaceDir, model: "anthropic/claude-sonnet-4.6" },
    };
    const result = await h.import({}, plan);
    expect(migrationItem(result, "config:default-model")).toMatchObject({
      status: "conflict",
      reason: HERMES_REASON_DEFAULT_MODEL_CONFIGURED,
    });
    expect(result.summary.conflicts).toBe(1);
    expect(h.config.agents?.defaults?.model).toBe("anthropic/claude-sonnet-4.6");
  });

  it.each([undefined, { primary: "old/model", fallbacks: ["backup/model"] }])(
    "isolates the target agent model (%j)",
    async (model) => {
      const h = makeCase();
      await h.write("config.yaml", "model: imported/model\n");
      const { config, workspaceDir } = h;
      config.agents = {
        defaults: { workspace: workspaceDir, model: "shared/model" },
        entries: { main: { model: "main/model" }, research: { workspace: workspaceDir, model } },
      };
      const options = { targetAgentId: "research", overwrite: true };
      const plan = await h.plan({ ...options, config });
      const result = await h.import(options, plan);
      expect(result.summary.errors).toBe(0);
      expect(config.agents?.defaults?.model).toBe("shared/model");
      expect(config.agents?.entries?.main?.model).toBe("main/model");
      expect(config.agents?.entries?.research?.model).toEqual(
        model ? { ...model, primary: "imported/model" } : "imported/model",
      );
      expect(plan.items[0]?.target).toContain("research");
      expect(
        migrationItem(
          await h.plan({ ...options, config, overwrite: false }),
          "config:default-model",
        )?.status,
      ).toBe("skipped");
    },
  );

  it("blocks defaults after a late provider conflict", async () => {
    const h = makeCase();
    await h.write(
      "config.yaml",
      "model: {provider: 'custom:acme', default: imported-model}\n" +
        "providers: {acme: {base_url: 'https://new.example.test/v1', transport: openai_chat}}\n",
    );
    const plan = await h.plan();
    h.config.models = {
      providers: {
        acme: { baseUrl: "https://old.example.test/v1", api: "openai-completions", models: [] },
      },
    };
    const result = await h.import({}, plan);
    expect(migrationItem(result, "config:model-provider:acme")?.status).toBe("conflict");
    expect(migrationItem(result, "config:default-model")).toMatchObject({
      status: "conflict",
      reason: HERMES_REASON_MODEL_PROVIDER_CONFLICT,
    });
    expect(h.config.agents?.defaults?.model).toBeUndefined();
  });
});

describe("Hermes migration model planning", () => {
  it("routes top-level string model refs", async () => {
    const plan = await planModel("provider: openai\nmodel: gpt-5.4\n");
    expect(migrationItem(plan, "config:default-model")?.details?.model).toBe("openai/gpt-5.4");
  });

  it.each([
    ["openrouter", "anthropic/claude-opus-4.7", "openrouter/anthropic/claude-opus-4.7"],
    ["custom:local", "vendor/model", "local/vendor/model"],
    ["openai-codex", "gpt-5.6", "openai/gpt-5.6"],
    ["kimi-coding", "kimi-k2.5", "moonshot/kimi-k2.5"],
    ["kimi", "kimi-for-coding/kimi-k2.5", "moonshot/kimi-k2.5"],
    ["alibaba", "qwen3.5-plus", "qwen/qwen3.5-plus"],
    ["alibaba-coding-plan", "qwen3-coder-next", "qwen/qwen3-coder-next"],
    ["minimax-cn", "MiniMax-M2.7", "minimax/MiniMax-M2.7"],
    ["auto", "anthropic/claude-opus-4.6", "anthropic/claude-opus-4.6"],
    ["qwen-cli", "qwen3.5-plus", "qwen/qwen3.5-plus"],
    ["custom:My Local LLM", "local-model", "my-local-llm/local-model"],
  ])("preserves qualified model routing through %s", async (provider, model, expected) => {
    const plan = await planModel(`model:\n  provider: ${provider}\n  default: ${model}\n`);
    expect(plan.items[0]?.details?.model).toBe(expected);
    expect(plan.items.some((entry) => entry.id.startsWith("config:model-provider:"))).toBe(
      ["alibaba", "dashscope", "minimax-cn"].includes(provider),
    );
    if (provider === "qwen-cli") {
      expect(migrationItem(plan, "manual:auth-reauthenticate:qwen")?.reason).toBe(
        "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
      );
    }
  });

  it("reauthenticates a retired qualified Qwen model", async () => {
    const plan = await planModel("model: qwen-oauth/qwen3.5-plus\n");
    expect(plan.items[0]?.details?.model).toBe("qwen/qwen3.5-plus");
    expect(migrationItem(plan, "manual:auth-reauthenticate:qwen")?.reason).toBe(
      "Authenticate qwen with an API key after migration: openclaw onboard --auth-choice qwen-api-key.",
    );
  });

  it("infers custom providers from model endpoints", async () => {
    const plan = await planModel(
      "model:\n  default: vendor/current-model\n  base_url: https://models.example/v1\n",
    );
    expect(plan.items.find((item) => item.id === "config:default-model")?.details?.model).toBe(
      "custom/vendor/current-model",
    );
  });
});
