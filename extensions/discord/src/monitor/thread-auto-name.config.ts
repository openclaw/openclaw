import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDiscordAccountConfig } from "../accounts.js";

const DEFAULT_MESSAGE_THRESHOLD = 5;

export function resolveDiscordThreadAutoNameThreshold(
  cfg: OpenClawConfig,
  accountId: string,
): number {
  const value =
    resolveDiscordAccountConfig(cfg, accountId)?.thread?.autoName ??
    cfg.channels?.discord?.thread?.autoName ??
    false;
  return value === true ? DEFAULT_MESSAGE_THRESHOLD : value === false ? 0 : value;
}
