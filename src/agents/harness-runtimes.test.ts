import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { collectConfiguredAgentHarnessRuntimes as collect } from "./harness-runtimes.js";

function countRosterReads(config: OpenClawConfig): () => number {
  const agents = (config as { agents: Record<string, unknown> }).agents;
  const entries = agents.entries;
  let reads = 0;
  Object.defineProperty(agents, "entries", {
    enumerable: true,
    configurable: true,
    get: () => {
      reads += 1;
      return entries;
    },
  });
  return () => reads;
}

function makeConfig(defaults: unknown = {}, entries: unknown = {}) {
  return createCanonicalAgentConfigFixture({ agents: { defaults, entries } }).config;
}

describe("collectConfiguredAgentHarnessRuntimes", () => {
  it("preloads explicit picker alternatives without changing an OpenClaw default", () => {
    const model = "openai/gpt-5.6-sol";
    const config = makeConfig(
      {
        model: "openai/gpt-5.6-sol",
        models: {
          [model]: {
            agentRuntime: { id: "openclaw" },
            pickerRuntimes: ["codex", "codex", "openclaw"],
          },
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

  it("can ignore implicit OpenAI Codex runtime preferences", () => {
    const config = makeConfig({
      model: "openai/gpt-5.5",
      models: {
        "openai/gpt-5.4": {},
        "anthropic/claude-opus-4-7": { agentRuntime: { id: "codex" } },
      },
    });
    expect(collect(config, { includeImplicitRuntimePreferences: false })).toEqual(["codex"]);
  });

  it("does not infer Codex for custom OpenAI-compatible base URLs", () => {
    const config = {
      ...makeConfig({ models: { "openai/gpt-5.5": {} } }),
      models: {
        providers: {
          openai: {
            baseUrl: "https://openai-compatible.example.test/v1",
            models: [],
          },
        },
      },
    };

    expect(collect(config)).toEqual([]);
  });

  it("bounds roster reads per collection batch on large fleets (#135743)", () => {
    // The collector must not multiply full-roster reads by model-reference count.
    const agentCount = 300;
    const modelsPerAgent = 40;
    const entries: Record<string, { models: Record<string, Record<string, never>> }> = {};
    for (let i = 0; i < agentCount; i++) {
      const models: Record<string, Record<string, never>> = {};
      for (let m = 0; m < modelsPerAgent; m++) {
        models[`openai/proof-model-${m}`] = {};
      }
      entries[`agent-${i}`] = { models };
    }
    const migrated = makeConfig({ models: { "anthropic/claude-opus-4-7": {} } }, entries);
    const rosterReads = countRosterReads(migrated);

    const runtimes = collect(migrated);

    expect(runtimes).toEqual(["codex"]);
    expect(rosterReads()).toBeLessThanOrEqual(16);
  });

  it("observes roster mutations made between collection batches (#135743)", () => {
    const migrated = makeConfig({}, { main: {} });

    expect(collect(migrated)).toEqual([]);

    const roster = (migrated as { agents: { entries: Record<string, unknown> } }).agents.entries;
    roster.worker = { models: { "openai/gpt-5.5": {} } };

    expect(collect(migrated)).toEqual(["codex"]);
  });
});
