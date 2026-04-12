import type {
  ChannelDoctorAdapter,
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { FeishuConfig } from "./types.js";

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function hasLegacyFeishuBotNameAliases(value: unknown): boolean {
  const accounts = asObjectRecord(value);
  if (!accounts) {
    return false;
  }
  return Object.values(accounts).some((rawAccount) => {
    const account = asObjectRecord(rawAccount);
    return account ? hasOwnKey(account, "botName") : false;
  });
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  {
    path: ["channels", "feishu", "accounts"],
    message:
      'channels.feishu.accounts.<id>.botName is legacy; use channels.feishu.accounts.<id>.name. Run "openclaw doctor --fix".',
    match: hasLegacyFeishuBotNameAliases,
  },
];

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const feishu = asObjectRecord((cfg.channels as Record<string, unknown> | undefined)?.feishu);
  const rawAccounts = asObjectRecord(feishu?.accounts);
  if (!feishu || !rawAccounts) {
    return { config: cfg, changes: [] };
  }

  const changes: string[] = [];
  const accounts = { ...rawAccounts };
  let changed = false;

  for (const [accountId, rawAccount] of Object.entries(rawAccounts)) {
    const account = asObjectRecord(rawAccount);
    if (!account || !hasOwnKey(account, "botName")) {
      continue;
    }
    const nextAccount = { ...account };
    const botName = typeof nextAccount.botName === "string" ? nextAccount.botName.trim() : "";
    delete nextAccount.botName;
    if (botName && typeof nextAccount.name !== "string") {
      nextAccount.name = botName;
      changes.push(
        `Moved channels.feishu.accounts.${accountId}.botName -> channels.feishu.accounts.${accountId}.name.`,
      );
    } else {
      changes.push(`Removed legacy channels.feishu.accounts.${accountId}.botName.`);
    }
    accounts[accountId] = nextAccount;
    changed = true;
  }

  if (!changed) {
    return { config: cfg, changes: [] };
  }

  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: {
          ...feishu,
          accounts,
        } as FeishuConfig,
      },
    },
    changes,
  };
}

export const feishuDoctor: ChannelDoctorAdapter = {
  legacyConfigRules,
  normalizeCompatibilityConfig,
};
