import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyPluginDoctorCompatibilityMigrations } from "../../plugins/doctor-contract-registry.js";
import type { AgentMessage } from "../runtime/index.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";

const sentinel = Number.MAX_SAFE_INTEGER;
function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }) {
  return applyPluginDoctorCompatibilityMigrations(cfg, { pluginIds: ["telegram"] });
}

function transcript(turns: number): AgentMessage[] {
  return Array.from({ length: turns }, (_, index) => ({
    role: "user",
    content: "turn " + index,
    timestamp: index,
  }));
}

function retained(cfg: OpenClawConfig, key: string, messages: AgentMessage[], accountId?: string) {
  return limitHistoryTurns(messages, getHistoryLimitFromSessionKey(key, cfg, { accountId }));
}

describe("Doctor preserves independent session transcript limits", () => {
  it.each([0, 7, 5000])("preserves actual contents with inherited limit %s", (inherited) => {
    const cfg: OpenClawConfig = {
      messages: { groupChat: { historyLimit: sentinel } },
      channels: {
        telegram: {
          historyLimit: sentinel,
          dmHistoryLimit: inherited,
          dms: { "42": { historyLimit: sentinel } },
          accounts: {
            work: {
              historyLimit: sentinel,
              dmHistoryLimit: sentinel,
              dms: { "44": { historyLimit: sentinel } },
            },
          },
        },
      },
    };
    const routes = [
      { key: "agent:main:telegram:direct:42", turns: 16 },
      { key: "agent:main:telegram:direct:99", turns: 16 },
      { key: "agent:main:telegram:work:direct:42", turns: 16, accountId: "work" },
      { key: "agent:main:telegram:work:direct:44", turns: 16, accountId: "work" },
      { key: "agent:main:telegram:group:-100", turns: 76 },
      { key: "agent:main:telegram:group:-100", turns: 76, accountId: "work" },
    ];
    const result = normalizeCompatibilityConfig({ cfg });
    for (const route of routes) {
      const messages = transcript(route.turns);
      expect(retained(result.config, route.key, messages, route.accountId)).toEqual(
        retained(cfg, route.key, messages, route.accountId),
      );
    }
    expect(result.config).toEqual(cfg);
    expect(result.changes).toEqual([]);
    expect(normalizeCompatibilityConfig({ cfg: result.config }).config).toEqual(cfg);
  });

  it("retains the raw inherited limit when an existing retired-mode migration materializes it", () => {
    // Doctor accepts retired fields that are deliberately absent from the current schema.
    const cfg = {
      channels: {
        telegram: {
          historyLimit: sentinel,
          includeGroupHistoryContext: "none",
          accounts: { work: { includeGroupHistoryContext: "recent" } },
        },
      },
    } as unknown as OpenClawConfig;
    const messages = transcript(76);
    const key = "agent:main:telegram:group:-100";
    const before = retained(cfg, key, messages, "work");
    const result = normalizeCompatibilityConfig({ cfg });
    expect(before).toEqual(messages);
    expect(retained(result.config, key, messages, "work")).toEqual(before);
    expect(result.config.channels?.telegram?.accounts?.work?.historyLimit).toBe(sentinel);
    expect(result.config.channels?.telegram?.historyLimit).toBe(0);
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });
});
