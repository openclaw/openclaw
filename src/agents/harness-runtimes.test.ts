import { describe, expect, it } from "vitest";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { collectConfiguredAgentHarnessRuntimes as collect } from "./harness-runtimes.js";

function makeConfig(defaults: unknown = {}, entries: unknown = {}) {
  return createCanonicalAgentConfigFixture({ agents: { defaults, entries } }).config;
}

describe("collectConfiguredAgentHarnessRuntimes", () => {
  it("preloads explicit runtimes, ignores implicit ones, and preserves an OpenClaw default", () => {
    const model = "openai/gpt-5.6-sol";
    const config = makeConfig(
      {
        model,
        models: {
          [model]: {
            agentRuntime: { id: "openclaw" },
            pickerRuntimes: ["codex", "codex", "openclaw"],
          },
          "openai/gpt-5.4": {},
          "anthropic/claude-opus-4-7": { agentRuntime: { id: "codex" } },
        },
      },
      { ops: { models: { "fixture/model": { pickerRuntimes: ["fixture-harness"] } } } },
    );
    expect(collect(config, { includeImplicitRuntimePreferences: false })).toEqual([
      "codex",
      "fixture-harness",
    ]);
    expect(config.agents?.defaults?.models?.[model]?.agentRuntime?.id).toBe("openclaw");
  });

  it("requires Codex when OpenAI is only a default model fallback", () => {
    expect(collect(makeConfig({ model: { fallbacks: ["openai/gpt-5.5"] } }))).toEqual(["codex"]);
  });

  it("does not infer Codex for custom OpenAI-compatible base URLs", () => {
    const config = makeConfig({ models: { "openai/gpt-5.5": {} } });
    config.models = {
      providers: {
        openai: { baseUrl: "https://openai-compatible.example.test/v1", models: [] },
      },
    };
    expect(collect(config)).toEqual([]);
  });

  it("bounds roster reads per collection batch on large fleets (#135743)", () => {
    // The collector must not multiply full-roster reads by model-reference count.
    const models = Object.fromEntries(
      Array.from({ length: 40 }, (_, m) => [`openai/proof-model-${m}`, {}]),
    );
    const entries = Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`agent-${i}`, { models: structuredClone(models) }]),
    );
    const migrated = makeConfig({ models: { "anthropic/claude-opus-4-7": {} } }, entries);
    const agents = migrated.agents!;
    const roster = agents.entries;
    let reads = 0;
    Object.defineProperty(agents, "entries", {
      get: () => {
        reads += 1;
        return roster;
      },
    });

    expect(collect(migrated)).toEqual(["codex"]);
    expect(reads).toBeLessThanOrEqual(16);
  });

  it("observes roster mutations made between collection batches (#135743)", () => {
    const migrated = makeConfig({}, { main: {} });

    expect(collect(migrated)).toEqual([]);

    const roster = (migrated as { agents: { entries: Record<string, unknown> } }).agents.entries;
    roster.worker = { models: { "openai/gpt-5.5": {} } };

    expect(collect(migrated)).toEqual(["codex"]);
  });
});
