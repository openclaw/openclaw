import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  buildProviderUsageSummary,
  normalizeProviderForLimit,
  resolveSpawnProvider,
} from "./subagent-provider-limits.js";
import {
  addSubagentRunForTests,
  releaseProviderSlot,
  reserveProviderSlot,
  resetSubagentRegistryForTests,
} from "./subagent-registry.js";

function makeConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4" },
        subagents: {
          model: { primary: "google/gemini-3-pro-preview" },
          providerLimits: {
            openai: 2,
            unknown: 3,
          },
        },
      },
      list: [
        {
          id: "main",
          model: { primary: "openai/gpt-5" },
          subagents: {
            model: { primary: "z.ai/glm-5" },
          },
        },
      ],
    },
  };
}

beforeEach(() => {
  resetSubagentRegistryForTests({ persist: false });
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
});

describe("normalizeProviderForLimit", () => {
  it("normalizes provider ids to lowercase alphanumeric", () => {
    expect(normalizeProviderForLimit(" Z.AI_PaaS ")).toBe("zaipaas");
    expect(normalizeProviderForLimit("Google")).toBe("google");
  });
});

describe("resolveSpawnProvider", () => {
  it("prefers model override over configured defaults", () => {
    const cfg = makeConfig();
    const resolved = resolveSpawnProvider({
      cfg,
      targetAgentId: "main",
      modelOverride: "openai/gpt-5-mini",
    });

    expect(resolved.model).toBe("openai/gpt-5-mini");
    expect(resolved.provider).toBe("openai");
  });

  it("falls back through subagent model then agent model", () => {
    const cfg = makeConfig();
    const fromSubagent = resolveSpawnProvider({ cfg, targetAgentId: "main" });
    expect(fromSubagent.model).toBe("z.ai/glm-5");
    expect(fromSubagent.provider).toBe("zai");

    const fromAgentModel = resolveSpawnProvider({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4" },
          },
          list: [{ id: "main", model: "openai/gpt-5" }],
        },
      },
      targetAgentId: "main",
    });
    expect(fromAgentModel.model).toBe("openai/gpt-5");
    expect(fromAgentModel.provider).toBe("openai");
  });

  it("returns undefined provider when model cannot be parsed", () => {
    const resolved = resolveSpawnProvider({
      cfg: {
        agents: {
          list: [
            {
              id: "main",
              subagents: {
                model: "gpt-5-mini",
              },
            },
          ],
        },
      },
      targetAgentId: "main",
    });

    expect(resolved.model).toBe("gpt-5-mini");
    expect(resolved.provider).toBeUndefined();
  });
});

describe("buildProviderUsageSummary", () => {
  it("includes active and pending usage per provider", () => {
    addSubagentRunForTests({
      runId: "openai-active",
      childSessionKey: "agent:main:subagent:openai-active",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "active",
      cleanup: "keep",
      createdAt: Date.now(),
      provider: "openai",
    });

    const reservation = reserveProviderSlot("openai", 2);
    expect(reservation).not.toBeNull();

    const rows = buildProviderUsageSummary({
      agents: {
        defaults: {
          subagents: {
            providerLimits: {
              openai: 2,
              unknown: 3,
            },
          },
        },
      },
    });

    const openai = rows.find((row) => row.provider === "openai");
    expect(openai).toMatchObject({
      provider: "openai",
      active: 1,
      pending: 1,
      total: 2,
      max: 2,
      available: 0,
    });

    releaseProviderSlot(reservation);
  });
});
