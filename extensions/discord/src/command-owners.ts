import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function resolveDiscordCommandOwnerEntries(cfg: OpenClawConfig): string[] | undefined {
  const entries = (cfg.commands?.ownerAllowFrom ?? [])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry && (/^(discord|user|pk):/i.test(entry) || !entry.includes(":")));
  return entries.length > 0 ? entries : undefined;
}

export function resolveDiscordCommandOwnerAllowFrom(cfg: OpenClawConfig): string[] | undefined {
  return resolveDiscordCommandOwnerEntries(cfg)
    ?.map((entry) => entry.replace(/^discord:/i, "").trim())
    .filter(Boolean);
}
