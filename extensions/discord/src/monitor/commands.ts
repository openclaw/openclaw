import type {
  DiscordSlashCommandConfig,
  DiscordSlashCommandDeployConfig,
  DiscordSlashCommandDeployMode,
} from "openclaw/plugin-sdk/config-types";

export function resolveDiscordSlashCommandConfig(
  raw?: DiscordSlashCommandConfig,
): Required<DiscordSlashCommandConfig> {
  return {
    ephemeral: raw?.ephemeral !== false,
  };
}

export function resolveDiscordSlashCommandDeployConfig(
  raw?: DiscordSlashCommandDeployMode | DiscordSlashCommandDeployConfig,
): {
  mode: DiscordSlashCommandDeployMode;
} {
  const mode = typeof raw === "string" ? raw : (raw?.mode ?? "changed-only");
  return { mode };
}
