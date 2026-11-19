import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentProfile } from "./agent-profiles.js";

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
      { agent: "openclaw/base", defaults: "openclaw/small", agentModel: "openclaw/small" },
      ["openclaw/base", "agent-explicit"],
    ],
    [
      { defaults: "openclaw/small", agentModel: "openclaw/base" },
      ["openclaw/small", "defaults-explicit"],
    ],
    [
      { agentModel: "openclaw/small", defaultsModel: "openclaw/base" },
      ["openclaw/small", "agent-model"],
    ],
    [{ defaultsModel: "openclaw/small" }, ["openclaw/small", "defaults-model"]],
    [
      { agent: "auto", defaults: "auto", defaultsModel: "openclaw/small" },
      ["openclaw/small", "defaults-model"],
    ],
  ])("applies precedence for %j", (selectors, expected) => {
    expect(resolve(config(selectors))).toEqual(expected);
  });

  it("binds models by exact provider/model only", () => {
    const cfg = config({ defaultsModel: "openclaw/small" });
    expect(resolve(cfg, { modelProvider: "ollama", modelId: "qwen3:14b" })).toEqual([
      "openclaw/base",
      "fallback",
    ]);
    expect(resolve(cfg, {})).toEqual(["openclaw/base", "fallback"]);
  });
});
