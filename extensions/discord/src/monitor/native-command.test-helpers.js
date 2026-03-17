import { ChannelType } from "discord-api-types/v10";
import { vi } from "vitest";
function createMockCommandInteraction(params = {}) {
  const guildId = params.guildId;
  const guild = guildId === null || guildId === void 0 ? null : { id: guildId, name: params.guildName };
  return {
    user: {
      id: params.userId ?? "owner",
      username: params.username ?? "tester",
      globalName: params.globalName ?? "Tester"
    },
    channel: {
      type: params.channelType ?? ChannelType.DM,
      id: params.channelId ?? "dm-1"
    },
    guild,
    rawData: {
      id: params.interactionId ?? "interaction-1",
      member: { roles: [] }
    },
    options: {
      getString: vi.fn().mockReturnValue(null),
      getNumber: vi.fn().mockReturnValue(null),
      getBoolean: vi.fn().mockReturnValue(null)
    },
    reply: vi.fn().mockResolvedValue({ ok: true }),
    followUp: vi.fn().mockResolvedValue({ ok: true }),
    client: {}
  };
}
export {
  createMockCommandInteraction
};
