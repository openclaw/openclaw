import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentProfile, resolveAgentProfilePromptLimits } from "./agent-profiles.js";
import { resolveRunBootstrapTotalMaxChars } from "./embedded-agent-helpers/bootstrap.js";

const model = { modelProvider: "ollama", modelId: "qwen3:8b" };

function config(params: {
  defaults?: string;
  agent?: string;
  defaultsModel?: string;
  agentModel?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(params.defaults ? { agentProfileId: params.defaults } : {}),
        ...(params.defaultsModel
          ? { models: { "ollama/qwen3:8b": { agentProfileId: params.defaultsModel } } }
          : {}),
      },
      entries: {
        main: {
          ...(params.agent ? { agentProfileId: params.agent } : {}),
          ...(params.agentModel
            ? { models: { "ollama/qwen3:8b": { agentProfileId: params.agentModel } } }
            : {}),
        },
      },
    },
  } as OpenClawConfig;
}

function resolve(cfg: OpenClawConfig, scope: { modelProvider?: string; modelId?: string } = model) {
  const resolved = resolveAgentProfile({ config: cfg, agentId: "main", ...scope });
  return [resolved.profile.id, resolved.selectionSource];
}

describe("resolveAgentProfile", () => {
  it("falls back to openclaw/base without a selector", () => {
    expect(resolve({})).toEqual(["openclaw/base", "fallback"]);
    expect(resolveAgentProfile({}).profile.id).toBe("openclaw/base");
  });

  it.each([
    [
      { agent: "openclaw/base", defaults: "openclaw/lean", agentModel: "openclaw/lean" },
      ["openclaw/base", "agent-explicit"],
    ],
    [
      { defaults: "openclaw/lean", agentModel: "openclaw/base" },
      ["openclaw/lean", "defaults-explicit"],
    ],
    [
      { agentModel: "openclaw/lean", defaultsModel: "openclaw/base" },
      ["openclaw/lean", "agent-model"],
    ],
    [{ defaultsModel: "openclaw/lean" }, ["openclaw/lean", "defaults-model"]],
    [
      { agent: "auto", defaults: "auto", defaultsModel: "openclaw/lean" },
      ["openclaw/lean", "defaults-model"],
    ],
  ])("applies precedence for %j", (selectors, expected) => {
    expect(resolve(config(selectors))).toEqual(expected);
  });

  it("binds models by exact provider/model only", () => {
    const cfg = config({ defaultsModel: "openclaw/lean" });
    expect(resolve(cfg, { modelProvider: "ollama", modelId: "qwen3:14b" })).toEqual([
      "openclaw/base",
      "fallback",
    ]);
    expect(resolve(cfg, {})).toEqual(["openclaw/base", "fallback"]);
  });

  it("keeps the lean compatibility profile and the small prompt profile apart", () => {
    const limits = (id: string) =>
      resolveAgentProfilePromptLimits({ config: config({ defaults: id }), agentId: "main" });
    expect(limits("openclaw/lean")).toEqual({ toolProfile: "lean" });
    expect(limits("openclaw/small")).toEqual({
      promptMode: "compact",
      skillsCatalog: { maxSkills: 0 },
      workspaceFiles: { maxTotalChars: 12_000 },
    });
    expect(limits("openclaw/base")).toEqual({});
  });

  it("narrows but never widens the configured workspace budget", () => {
    const budget = (defaults: Record<string, unknown>) =>
      resolveRunBootstrapTotalMaxChars({
        config: { agents: { defaults } } as OpenClawConfig,
        agentId: "main",
      });
    expect(budget({})).toBe(60_000);
    expect(budget({ agentProfileId: "openclaw/small" })).toBe(12_000);
    expect(budget({ agentProfileId: "openclaw/small", bootstrapTotalMaxChars: 5_000 })).toBe(5_000);
  });
});
