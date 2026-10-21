import { describe, expect, it } from "vitest";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectConfiguredCatalogModels,
  resolveConfiguredModelEntries,
} from "./configured-model-entries.js";

function model(id: string, overrides: Partial<ModelDefinitionConfig> = {}): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 1024,
    ...overrides,
  };
}

type ResolveOptions = Omit<Parameters<typeof resolveConfiguredModelEntries>[0], "cfg">;
function resolveDefaults(
  defaults: AgentDefaultsConfig,
  options: ResolveOptions = {},
  providers: NonNullable<OpenClawConfig["models"]>["providers"] = {},
) {
  return resolveConfiguredModelEntries({
    cfg: { agents: { defaults }, models: { providers } },
    allowPluginNormalization: false,
    ...options,
  });
}

const configuredTags = new Set(["default", "configured"]);
const canonical: ResolveOptions = { canonicalizeRef: (ref) => ({ ...ref, provider: "current" }) };
function metadata(entries: ReturnType<typeof resolveConfiguredModelEntries>["entries"]) {
  return entries.map(({ key, aliases, tags }) => [key, aliases, tags]);
}

describe("resolveConfiguredModelEntries", () => {
  it("collects authored catalog candidates with scoped aliases and literal provider declarations", () => {
    const models = collectConfiguredCatalogModels({
      agents: {
        defaults: {
          model: "local-chat",
          models: { "ollama/qwen3:8b": { alias: "local-chat" }, "ollama/*": {} },
        },
        entries: {
          ops: { model: "local-chat", models: { "ollama/llama3.2": { alias: "local-chat" } } },
        },
      },
      hooks: { gmail: { model: "local-chat" } },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [model("qwen3:8bb", { baseUrl: "http://other-server:11434" })],
          },
        },
      },
    });
    expect(models).toEqual([
      { provider: "ollama", modelId: "qwen3:8bb", baseUrl: "http://other-server:11434" },
      { provider: "ollama", modelId: "qwen3:8b", baseUrl: "http://127.0.0.1:11434" },
      { provider: "ollama", modelId: "llama3.2", baseUrl: "http://127.0.0.1:11434" },
    ]);
  });

  it.each([undefined, [], ["openclaw"]])(
    "inherits picker choices and lets an agent replace them with %j",
    (pickerRuntimes) => {
      const key = "openai/gpt-5.6-sol";
      const defaults = { model: key, models: { [key]: { pickerRuntimes: ["codex", "codex"] } } };
      const override = {
        alias: "Work",
        ...(pickerRuntimes === undefined ? {} : { pickerRuntimes }),
      };
      const { byKey } = resolveConfiguredModelEntries({
        agentId: "ops",
        allowPluginNormalization: false,
        cfg: { agents: { defaults, entries: { ops: { models: { [key]: override } } } } },
      });
      expect(byKey.get(key)?.pickerRuntimes).toEqual(pickerRuntimes ?? ["codex"]);
    },
  );

  it("parses configured models without loading provider-runtime normalization", () => {
    const { entries } = resolveDefaults({
      model: { primary: "codex/gpt-5.5", fallbacks: ["codex/gpt-5.4-mini"] },
      models: {
        "codex/gpt-5.5": { alias: "Codex" },
        "codex/gpt-5.4-mini": {},
      },
    });

    expect(metadata(entries)).toEqual([
      ["codex/gpt-5.5", ["Codex"], configuredTags],
      ["codex/gpt-5.4-mini", [], new Set(["fallback#1", "configured"])],
    ]);
  });

  it("normalizes retired nested Gemini ids in configured provider rows", () => {
    const key = "kilocode/google/gemini-3-pro-preview";
    const { entries } = resolveDefaults(
      { model: { primary: key }, models: { [key]: { alias: "Kilo Gemini" } } },
      {},
      {
        kilocode: {
          api: "openai-completions",
          baseUrl: "https://kilocode.test/v1",
          models: [model("google/gemini-3-pro-preview")],
        },
      },
    );

    expect(metadata(entries)).toEqual([
      ["kilocode/google/gemini-3.1-pro-preview", ["Kilo Gemini"], configuredTags],
    ]);
  });
  it.each([
    ["openai/gpt-5.5", "Primary", { "openai/*": {} }, {}, "openai/gpt-5.5"],
    ["legacy/model", "Work", {}, canonical, "current/model"],
  ] as const)("preserves configured metadata for %s", (ref, alias, selectors, options, key) => {
    const defaults = { model: ref, models: { [ref]: { alias }, ...selectors } };
    const { entries } = resolveDefaults(defaults, options);
    expect(metadata(entries)).toEqual([[key, [alias], configuredTags]]);
  });
});
