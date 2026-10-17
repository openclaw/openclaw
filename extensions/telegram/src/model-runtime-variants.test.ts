// Telegram tests cover model picker runtime variants.
import { describe, expect, it } from "vitest";
import { buildTelegramModelsListChannelData } from "./command-ui.js";
import { buildTelegramRuntimeVariants } from "./model-runtime-variants.js";

const api = { id: "openclaw", label: "OpenClaw" };
const cli = { id: "claude-cli", label: "Claude CLI" };

describe("buildTelegramRuntimeVariants", () => {
  it("lists the configured runtime first and labels Anthropic routes", () => {
    const variants = buildTelegramRuntimeVariants({
      byProvider: new Map([["anthropic", new Set(["claude-opus-5-5", "claude-opus-4-8"])]]),
      runtimeChoicesByModel: new Map([
        ["anthropic/claude-opus-5-5", [api, cli]],
        ["anthropic/claude-opus-4-8", [api, cli]],
      ]),
      modelRuntimeIds: new Map([
        ["anthropic/claude-opus-5-5", "openclaw"],
        ["anthropic/claude-opus-4-8", "claude-cli"],
      ]),
    });
    expect(variants.get("anthropic/claude-opus-5-5")).toEqual([
      { runtime: "openclaw", label: "API" },
      { runtime: "claude-cli", label: "Claude CLI" },
    ]);
    expect(variants.get("anthropic/claude-opus-4-8")).toEqual([
      { runtime: "claude-cli", label: "Claude CLI" },
      { runtime: "openclaw", label: "API" },
    ]);
  });

  it("offers no variants without a known default runtime or a second choice", () => {
    const variants = buildTelegramRuntimeVariants({
      byProvider: new Map([
        ["anthropic", new Set(["claude-haiku-4-5", "claude-sonnet-5-5"])],
        ["nvidia", new Set(["glm5"])],
      ]),
      runtimeChoicesByModel: new Map([
        ["anthropic/claude-haiku-4-5", [api, cli]],
        ["anthropic/claude-sonnet-5-5", [api]],
        ["nvidia/glm5", [api]],
      ]),
      modelRuntimeIds: new Map([["anthropic/claude-sonnet-5-5", "openclaw"]]),
    });
    expect(variants.size).toBe(0);
  });

  it("keeps a runtime's own label for providers without a route prefix", () => {
    const variants = buildTelegramRuntimeVariants({
      byProvider: new Map([["openai", new Set(["gpt-6-sol"])]]),
      runtimeChoicesByModel: new Map([
        ["openai/gpt-6-sol", [{ id: "codex", label: "Codex" }, api]],
      ]),
      modelRuntimeIds: new Map([["openai/gpt-6-sol", "codex"]]),
    });
    expect(variants.get("openai/gpt-6-sol")).toEqual([
      { runtime: "codex", label: "Codex" },
      { runtime: "openclaw", label: "OpenClaw" },
    ]);
  });
});

describe("buildTelegramModelsListChannelData with runtime choices", () => {
  const models = Array.from({ length: 6 }, (_, index) => `gpt-6-${index}`);
  const codex = { id: "codex", label: "Codex" };
  const runtimeChoicesByModel = new Map(models.map((model) => [`openai/${model}`, [api, codex]]));
  const modelRuntimeIds = new Map(models.map((model) => [`openai/${model}`, "codex"]));
  const buttons = (requestedPage: number) =>
    (
      buildTelegramModelsListChannelData({
        provider: "openai",
        models,
        currentPage: 1,
        totalPages: 1,
        pageSize: 8,
        requestedPage,
        runtimeChoicesByModel,
        modelRuntimeIds,
      }) as { telegram: { buttons: { text: string; callback_data: string }[][] } }
    ).telegram.buttons.flat();

  it("pages over runtime rows like the picker callbacks do", () => {
    const first = buttons(1);
    expect(first.filter((button) => button.callback_data.startsWith("mdl_rt_"))).toHaveLength(8);
    expect(first[0]?.text).toBe("Codex · gpt-6-0");
    expect(first[1]?.text).toBe("OpenClaw · gpt-6-0");
    const second = buttons(2);
    expect(second.filter((button) => button.callback_data.startsWith("mdl_rt_"))).toHaveLength(4);
    expect(second[0]?.text).toBe("Codex · gpt-6-4");
  });

  it("keeps plain model rows without runtime choices", () => {
    const plain = buildTelegramModelsListChannelData({
      provider: "openai",
      models: ["gpt-6-0"],
      currentPage: 1,
      totalPages: 1,
    }) as { telegram: { buttons: { callback_data: string }[][] } };
    expect(plain.telegram.buttons.flat()[0]?.callback_data).toBe("mdl_sel_openai/gpt-6-0");
  });
});
