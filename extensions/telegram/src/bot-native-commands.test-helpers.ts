import type { OpenClawConfig } from "../../../src/config/config.js";
import type { TelegramAccountConfig } from "../../../src/config/types.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import type { registerTelegramNativeCommands } from "./bot-native-commands.js";

type RegisterTelegramNativeCommandParams = Parameters<typeof registerTelegramNativeCommands>[0];

export function createNativeCommandTestParams(params: {
  bot: RegisterTelegramNativeCommandParams["bot"];
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  accountId?: string;
  telegramCfg?: TelegramAccountConfig;
  allowFrom?: string[];
  groupAllowFrom?: string[];
  replyToMode?: RegisterTelegramNativeCommandParams["replyToMode"];
  textLimit?: number;
  useAccessGroups?: boolean;
  nativeEnabled?: boolean;
  nativeSkillsEnabled?: boolean;
  nativeDisabledExplicit?: boolean;
  resolveTelegramGroupConfig?: RegisterTelegramNativeCommandParams["resolveTelegramGroupConfig"];
  opts?: RegisterTelegramNativeCommandParams["opts"];
}): RegisterTelegramNativeCommandParams {
  return {
    bot: params.bot,
    cfg: params.cfg ?? {},
    runtime: params.runtime ?? ({} as RuntimeEnv),
    accountId: params.accountId ?? "default",
    telegramCfg: params.telegramCfg ?? ({} as TelegramAccountConfig),
    allowFrom: params.allowFrom ?? [],
    groupAllowFrom: params.groupAllowFrom ?? [],
    replyToMode: params.replyToMode ?? "off",
    textLimit: params.textLimit ?? 4096,
    useAccessGroups: params.useAccessGroups ?? false,
    nativeEnabled: params.nativeEnabled ?? true,
    nativeSkillsEnabled: params.nativeSkillsEnabled ?? true,
    nativeDisabledExplicit: params.nativeDisabledExplicit ?? false,
    resolveGroupPolicy: () => ({ allowlistEnabled: false, allowed: true }),
    resolveTelegramGroupConfig:
      params.resolveTelegramGroupConfig ??
      (() => ({
        groupConfig: undefined,
        topicConfig: undefined,
      })),
    shouldSkipUpdate: () => false,
    opts: params.opts ?? { token: "token" },
  };
}
