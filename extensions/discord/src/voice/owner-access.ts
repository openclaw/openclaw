// Discord plugin module implements voice owner resolution.
import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveDiscordAccountAllowFrom } from "../accounts.js";
import {
  normalizeDiscordAllowList,
  resolveDiscordCommandOwnerAllowFrom,
} from "../monitor/allow-list.js";

export function resolveDiscordVoiceOwnerAccess(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordAccountConfig;
  accountId: string;
}): {
  commandAllowFrom: string[];
  commandAllowAll: boolean;
  ownerAllowFrom: string[];
  ownerAllowAll: boolean;
} {
  const commandOwnerAllowFrom = resolveDiscordCommandOwnerAllowFrom(params.cfg);
  if (commandOwnerAllowFrom) {
    const allowAll = commandOwnerAllowFrom.includes("*");
    return {
      commandAllowFrom: commandOwnerAllowFrom,
      commandAllowAll: allowAll,
      ownerAllowFrom: commandOwnerAllowFrom,
      ownerAllowAll: allowAll,
    };
  }
  const commandAllowFrom =
    resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId: params.accountId }) ??
    params.discordConfig.allowFrom ??
    params.discordConfig.dm?.allowFrom ??
    [];
  return {
    commandAllowFrom,
    commandAllowAll: normalizeDiscordAllowList(commandAllowFrom, [])?.allowAll === true,
    ownerAllowFrom: [],
    ownerAllowAll: false,
  };
}
