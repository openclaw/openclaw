import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";

/** Only unresolved name rules carry a pause. Rekeying or removing one releases its IDs. */
export function discordPausedGuildIds(guilds: DiscordAccountConfig["guilds"], accountId: string) {
  const ids = new Set<string>();
  for (const [key, rule] of Object.entries(guilds ?? {})) {
    if (key === "*" || /^\d+$/.test(key)) {
      continue;
    }
    for (const id of rule.doctorPausedGuildIds?.[accountId] ?? []) {
      ids.add(id);
    }
  }
  return ids;
}
