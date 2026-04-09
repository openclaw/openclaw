import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const DEPRECATED_FEISHU_KEYS = ["ackReaction", "threadSession"] as const;

function cleanDeprecatedKeys(
  entry: Record<string, unknown>,
  pathLabel: string,
  changes: string[],
): { entry: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next = { ...entry };
  for (const key of DEPRECATED_FEISHU_KEYS) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      changes.push(`Removed deprecated key "${pathLabel}.${key}".`);
      changed = true;
    }
  }
  return { entry: next, changed };
}

export async function cleanStaleFeishuConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): Promise<ChannelDoctorConfigMutation> {
  const rawFeishu = asObjectRecord(
    (cfg.channels as Record<string, unknown> | undefined)?.feishu,
  );
  if (!rawFeishu) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  let feishuChanged = false;
  let nextFeishu = { ...rawFeishu };

  // Clean top-level deprecated keys
  const topLevel = cleanDeprecatedKeys(nextFeishu, "channels.feishu", changes);
  nextFeishu = topLevel.entry;
  feishuChanged = feishuChanged || topLevel.changed;

  // Clean account-level deprecated keys
  const rawAccounts = asObjectRecord(nextFeishu.accounts);
  if (rawAccounts) {
    let accountsChanged = false;
    const accounts = { ...rawAccounts };
    for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
      const account = asObjectRecord(rawAccount);
      if (!account) {
        continue;
      }
      const cleaned = cleanDeprecatedKeys(
        account,
        `channels.feishu.accounts.${accountId}`,
        changes,
      );
      if (cleaned.changed) {
        accounts[accountId] = cleaned.entry;
        accountsChanged = true;
      }
    }
    if (accountsChanged) {
      nextFeishu = { ...nextFeishu, accounts };
      feishuChanged = true;
    }
  }

  if (!feishuChanged) {
    return { config: cfg, changes: [] };
  }

  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: nextFeishu as unknown as NonNullable<OpenClawConfig["channels"]>["feishu"],
      } as OpenClawConfig["channels"],
    },
    changes,
  };
}

export const feishuDoctor: ChannelDoctorAdapter = {
  cleanStaleConfig: cleanStaleFeishuConfig,
};
