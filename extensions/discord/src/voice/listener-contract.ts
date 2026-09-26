import type { APIVoiceState } from "discord-api-types/v10";

export interface DiscordVoiceListenerManager {
  autoJoin(): Promise<void>;
  reconcileAutoJoinGuild(guildId: string): Promise<void>;
  refreshGuildRoster(guildId: string): void;
  handleVoiceStateUpdate(
    data: APIVoiceState,
    previousVoiceState?: APIVoiceState | null,
  ): Promise<void>;
}
