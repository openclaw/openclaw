import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePromptHistoryLimit } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it } from "vitest";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveTelegramDmHistoryLimit } from "./dm-history.js";
import { normalizeCompatibilityConfig } from "./doctor-contract.js";

const sentinel = Number.MAX_SAFE_INTEGER;
function effectiveLimits(cfg: OpenClawConfig, accountId?: string) {
  const config: TelegramAccountConfig = accountId
    ? mergeTelegramAccountConfig(cfg, accountId)
    : (cfg.channels?.telegram ?? {});
  return [
    resolvePromptHistoryLimit(config.historyLimit ?? cfg.messages?.groupChat?.historyLimit),
    resolveTelegramDmHistoryLimit({ config }),
    resolveTelegramDmHistoryLimit({ config, senderId: "42" }),
  ];
}

describe("Telegram observed history and saved limits", () => {
  it.each([0, 7, 5000])("preserves sentinel overrides over inherited %s windows", (inherited) => {
    const cfg: OpenClawConfig = {
      messages: { groupChat: { historyLimit: inherited } },
      channels: {
        telegram: {
          historyLimit: sentinel,
          dmHistoryLimit: inherited,
          dms: { "42": { historyLimit: sentinel } },
          accounts: { work: { historyLimit: sentinel, dmHistoryLimit: sentinel } },
        },
      },
    };
    const before = [effectiveLimits(cfg), effectiveLimits(cfg, "work")];
    const result = normalizeCompatibilityConfig({ cfg });
    expect([effectiveLimits(result.config), effectiveLimits(result.config, "work")]).toEqual(
      before,
    );
    expect(result.config).toEqual(cfg);
    expect(result.changes).toEqual([]);
    expect(cfg.channels?.telegram?.historyLimit).toBe(sentinel);
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });

  it("preserves ordinary and disabled account/sender windows", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          historyLimit: 5000,
          dmHistoryLimit: sentinel,
          accounts: {
            work: { historyLimit: 0, dmHistoryLimit: 7, dms: { "42": { historyLimit: 0 } } },
          },
        },
      },
    };
    const result = normalizeCompatibilityConfig({ cfg });
    expect(effectiveLimits(result.config)).toEqual([200, 10, 10]);
    expect(effectiveLimits(result.config, "work")).toEqual([0, 7, 0]);
    expect(result.config.channels?.telegram?.historyLimit).toBe(5000);
  });
});
