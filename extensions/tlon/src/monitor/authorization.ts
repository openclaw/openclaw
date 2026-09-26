// Tlon plugin module implements authorization behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { TlonSettingsStore } from "../settings.js";

type ChannelAuthorization = NonNullable<TlonSettingsStore["channelRules"]>[string];

export function resolveChannelAuthorization(
  cfg: OpenClawConfig,
  channelNest: string,
  settings?: TlonSettingsStore,
): { mode: "restricted" | "open"; allowedShips: string[]; requireMentionInBotThreads?: boolean } {
  const tlonConfig = cfg.channels?.tlon as
    | {
        authorization?: { channelRules?: Record<string, ChannelAuthorization> };
        defaultAuthorizedShips?: string[];
      }
    | undefined;

  const fileRules = tlonConfig?.authorization?.channelRules ?? {};
  const settingsRules = settings?.channelRules ?? {};
  const fileRule = fileRules[channelNest];
  const settingsRule = settingsRules[channelNest];
  const rule = settingsRule ?? fileRule;
  const defaultShips = settings?.defaultAuthorizedShips ?? tlonConfig?.defaultAuthorizedShips ?? [];
  // Existing settings access rules must not erase a file's newer thread policy.
  const requireMentionInBotThreads =
    typeof settingsRule?.requireMentionInBotThreads === "boolean"
      ? settingsRule.requireMentionInBotThreads
      : fileRule?.requireMentionInBotThreads;

  return {
    mode: rule?.mode ?? "restricted",
    allowedShips: rule?.allowedShips ?? defaultShips,
    requireMentionInBotThreads:
      typeof requireMentionInBotThreads === "boolean" ? requireMentionInBotThreads : undefined,
  };
}
