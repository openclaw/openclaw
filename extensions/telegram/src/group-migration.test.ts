import { describe, expect, it } from "vitest";
import { migrateTelegramGroupConfig } from "./group-migration.js";

function config(groups: Record<string, Record<string, unknown>>, accountId?: string) {
  return {
    channels: { telegram: accountId ? { accounts: { [accountId]: { groups } } } : { groups } },
  };
}

function migrate(
  cfg: Parameters<typeof migrateTelegramGroupConfig>[0]["cfg"],
  accountId = "default",
  newChatId = "-100123",
) {
  return migrateTelegramGroupConfig({ cfg, accountId, oldChatId: "-123", newChatId });
}

describe("migrateTelegramGroupConfig", () => {
  it.each([
    ["global", undefined, { requireMention: false }],
    ["account-scoped", "primary", { requireMention: true }],
    ["case-insensitive account", "Primary", {}],
  ] as const)("migrates %s group ids", (_name, accountId, group) => {
    const groups = { "-123": { ...group } };
    expect(migrate(config(groups, accountId), accountId?.toLowerCase()).migrated).toBe(true);
    expect(groups).toEqual({ "-100123": group });
  });

  it("skips migration when new id already exists", () => {
    const groups = {
      "-123": { requireMention: true },
      "-100123": { requireMention: false },
    };

    expect(migrate(config(groups))).toEqual({ migrated: false, skippedExisting: true });
    expect(groups).toEqual({
      "-123": { requireMention: true },
      "-100123": { requireMention: false },
    });
  });

  it("no-ops when old and new group ids are the same", () => {
    const groups = { "-123": { requireMention: true } };
    expect(migrate(config(groups), "default", "-123")).toEqual({
      migrated: false,
      skippedExisting: false,
    });
    expect(groups).toEqual({
      "-123": { requireMention: true },
    });
  });
});
