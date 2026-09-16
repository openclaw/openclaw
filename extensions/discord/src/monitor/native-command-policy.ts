import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveDiscordAccountAllowFrom } from "../accounts.js";
import { createDiscordLivePolicyReader, type DiscordLivePolicyReader } from "./live-policy.js";
import type { DiscordCommandArgContext } from "./native-command-ui.types.js";

export function resolveDiscordNativePolicyReader(
  params: Pick<DiscordCommandArgContext, "cfg" | "discordConfig" | "accountId" | "readPolicy">,
): DiscordLivePolicyReader {
  return (
    params.readPolicy ??
    createDiscordLivePolicyReader({
      ...params,
      readConfig: () => getRuntimeConfigSnapshot() ?? params.cfg,
      resolvedAllowlist: {
        guildEntries: params.discordConfig?.guilds,
        allowFrom: params.discordConfig?.allowFrom ?? resolveDiscordAccountAllowFrom(params),
      },
    })
  );
}
