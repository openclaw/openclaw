import type { Client } from "@buape/carbon";
import { VoiceServerUpdateListener, VoiceStateUpdateListener } from "@buape/carbon";
import type { VoicePlugin } from "@buape/carbon/voice";
import type {
  GatewayVoiceServerUpdateDispatchData,
  GatewayVoiceStateUpdateDispatchData,
} from "discord-api-types/v10";

function getVoiceAdapters(client: Client) {
  return client.getPlugin<VoicePlugin>("voice")?.adapters;
}

export class DiscordVoiceServerUpdateBridge extends VoiceServerUpdateListener {
  async handle(data: Record<string, unknown>, client: Client): Promise<void> {
    const adapters = getVoiceAdapters(client);
    if (!adapters) {return;}
    const guildId = data.guild_id as string | undefined;
    if (!guildId) {return;}
    const adapter = adapters.get(guildId);
    if (!adapter) {return;}
    adapter.onVoiceServerUpdate({
      guild_id: guildId,
      token: data.token,
      endpoint: data.endpoint ?? null,
    } as GatewayVoiceServerUpdateDispatchData);
  }
}

export class DiscordVoiceStateUpdateBridge extends VoiceStateUpdateListener {
  async handle(data: Record<string, unknown>, client: Client): Promise<void> {
    const adapters = getVoiceAdapters(client);
    if (!adapters) {return;}
    const guildId = data.guild_id as string | undefined;
    if (!guildId) {return;}
    const adapter = adapters.get(guildId);
    if (!adapter) {return;}
    // Reconstruct raw payload: strip Carbon-added fields, restore member from rawMember
    const { guild: _guild, member: _member, rawMember, clientId: _clientId, ...raw } = data;
    adapter.onVoiceStateUpdate({
      ...raw,
      member: rawMember,
    } as unknown as GatewayVoiceStateUpdateDispatchData);
  }
}
