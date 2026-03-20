import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  type ChannelSetupAdapter,
  type ChannelSetupInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { resolveWechatLinuxAccount } from "./accounts.js";
import type { CoreConfig, GroupPolicy, WechatLinuxConfig } from "./types.js";

const channel = "wechat-linux" as const;

function getChannelConfig(cfg: OpenClawConfig): WechatLinuxConfig {
  return (cfg.channels?.[channel] as WechatLinuxConfig | undefined) ?? {};
}

function getRawAccountConfig(cfg: OpenClawConfig, accountId: string): Record<string, unknown> {
  const channelConfig = getChannelConfig(cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return channelConfig as Record<string, unknown>;
  }
  return (channelConfig.accounts?.[accountId] as Record<string, unknown> | undefined) ?? {};
}

export function patchWechatLinuxAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
  clearFields?: string[];
  enabled?: boolean;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const channelConfig = getChannelConfig(params.cfg);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const nextChannelConfig = { ...(channelConfig as Record<string, unknown>) };
    for (const field of params.clearFields ?? []) {
      delete nextChannelConfig[field];
    }
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        [channel]: {
          ...nextChannelConfig,
          ...(params.enabled ? { enabled: true } : {}),
          ...params.patch,
        },
      },
    };
  }

  const nextAccounts = { ...(channelConfig.accounts ?? {}) } as Record<
    string,
    Record<string, unknown>
  >;
  const nextAccountConfig = { ...(nextAccounts[accountId] ?? {}) };
  for (const field of params.clearFields ?? []) {
    delete nextAccountConfig[field];
  }
  nextAccounts[accountId] = {
    ...nextAccountConfig,
    ...(params.enabled ? { enabled: true } : {}),
    ...params.patch,
  };

  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      [channel]: {
        ...channelConfig,
        ...(params.enabled ? { enabled: true } : {}),
        accounts: nextAccounts,
      },
    },
  };
}

function readString(input: ChannelSetupInput, key: string): string | undefined {
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function buildWechatLinuxSetupPatch(input: ChannelSetupInput): Record<string, unknown> {
  const pyWxDumpRoot = readString(input, "pyWxDumpRoot");
  const pythonPath = readString(input, "pythonPath");
  const keyFile = readString(input, "keyFile");
  const dbDir = readString(input, "dbDir");
  const outputDir = readString(input, "outputDir");
  const display = readString(input, "display");
  const xauthority = readString(input, "xauthority");
  const windowClass = readString(input, "windowClass");
  const windowMode = readString(input, "windowMode");

  return {
    ...(pyWxDumpRoot ? { pyWxDumpRoot } : {}),
    ...(pythonPath ? { pythonPath } : {}),
    ...(keyFile ? { keyFile } : {}),
    ...(dbDir ? { dbDir } : {}),
    ...(outputDir ? { outputDir } : {}),
    ...(display ? { display } : {}),
    ...(xauthority ? { xauthority } : {}),
    ...(windowClass ? { windowClass } : {}),
    ...(windowMode ? { windowMode } : {}),
  };
}

export function setWechatLinuxAllowFrom(
  cfg: OpenClawConfig,
  accountId: string,
  allowFrom: string[],
): OpenClawConfig {
  return patchWechatLinuxAccountConfig({
    cfg,
    accountId,
    enabled: true,
    patch: { allowFrom },
  });
}

export function setWechatLinuxGroupAccess(params: {
  cfg: OpenClawConfig;
  accountId: string;
  groupPolicy: GroupPolicy;
  groupAllowFrom?: string[];
}): OpenClawConfig {
  return patchWechatLinuxAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
    enabled: true,
    patch: {
      groupPolicy: params.groupPolicy,
      ...(params.groupAllowFrom ? { groupAllowFrom: params.groupAllowFrom } : {}),
    },
  });
}

export const wechatLinuxSetupAdapter: ChannelSetupAdapter = {
  resolveAccountId: ({ accountId }) => normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID,
  validateInput: ({ cfg, accountId, input }) => {
    const existing = resolveWechatLinuxAccount({ cfg: cfg as CoreConfig, accountId });
    const pyWxDumpRoot = readString(input, "pyWxDumpRoot") ?? existing.pyWxDumpRoot;
    if (!pyWxDumpRoot?.trim()) {
      return "WeChat Linux requires pyWxDumpRoot.";
    }
    return null;
  },
  applyAccountConfig: ({ cfg, accountId, input }) =>
    patchWechatLinuxAccountConfig({
      cfg,
      accountId,
      enabled: true,
      patch: buildWechatLinuxSetupPatch(input),
    }),
  applyAccountName: ({ cfg, accountId, name }) =>
    patchWechatLinuxAccountConfig({
      cfg,
      accountId,
      enabled: true,
      patch: { name },
    }),
};

export { getRawAccountConfig };
