import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelSetupAdapter,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import type { FeishuConfig } from "./types.js";

export function setFeishuNamedAccountEnabled(
  cfg: OpenClawConfig,
  accountId: string,
  enabled: boolean,
): OpenClawConfig {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...feishuCfg,
        accounts: {
          ...feishuCfg?.accounts,
          [accountId]: {
            ...feishuCfg?.accounts?.[accountId],
            enabled,
          },
        },
      },
    },
  };
}

export const feishuSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => {
    return normalizeAccountId(accountId);
  },
  applyAccountConfig: ({ cfg, accountId }) => {
    const isDefault = !accountId || accountId === DEFAULT_ACCOUNT_ID;
    if (isDefault) {
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          feishu: {
            ...cfg.channels?.feishu,
            enabled: true,
          },
        },
      };
    }
    return setFeishuNamedAccountEnabled(cfg, accountId, true);
  },
};
