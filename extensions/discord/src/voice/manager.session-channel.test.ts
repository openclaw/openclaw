import { ChannelType } from "@buape/carbon";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createConnectionMock,
  joinVoiceChannelMock,
  entersStateMock,
  createAudioPlayerMock,
  resolveAgentRouteMock,
} = vi.hoisted(() => {
  const createConnectionMock = () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    return {
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(event, handler);
      }),
      subscribe: vi.fn(),
      disconnect: vi.fn(),
      destroy: vi.fn(),
      receiver: { speaking: { on: vi.fn() } },
      handlers,
    };
  };
  return {
    createConnectionMock,
    joinVoiceChannelMock: vi.fn(() => createConnectionMock()),
    entersStateMock: vi.fn().mockResolvedValue(undefined),
    createAudioPlayerMock: vi.fn(() => ({ on: vi.fn() })),
    resolveAgentRouteMock: vi.fn(() => ({
      sessionKey: "discord:g1:c1",
      agentId: "agent-1",
    })),
  };
});

vi.mock("./sdk-runtime.js", () => ({
  loadDiscordVoiceSdk: () => ({
    AudioPlayerStatus: { Playing: "playing", Idle: "idle" },
    EndBehaviorType: { AfterSilence: "AfterSilence" },
    VoiceConnectionStatus: {
      Ready: "ready",
      Disconnected: "disconnected",
      Destroyed: "destroyed",
      Signalling: "signalling",
      Connecting: "connecting",
    },
    createAudioPlayer: createAudioPlayerMock,
    createAudioResource: vi.fn(),
    entersState: entersStateMock,
    joinVoiceChannel: joinVoiceChannelMock,
  }),
}));

vi.mock("openclaw/plugin-sdk/routing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/routing")>();
  return { ...actual, resolveAgentRoute: resolveAgentRouteMock };
});

vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>();
  return { ...actual, agentCommandFromIngress: vi.fn().mockResolvedValue({ payloads: [] }) };
});

vi.mock("openclaw/plugin-sdk/media-understanding-runtime", () => ({
  transcribeAudioFile: vi.fn().mockResolvedValue({ text: "" }),
}));

let managerModule: typeof import("./manager.js");

function createClient(overrides?: Partial<{ fetchChannel: (id: string) => Promise<unknown> }>) {
  return {
    fetchChannel:
      overrides?.fetchChannel ??
      vi.fn(async (channelId: string) => ({
        id: channelId,
        guildId: "g1",
        type: ChannelType.GuildVoice,
      })),
    getPlugin: vi.fn(() => ({
      getGatewayAdapterCreator: vi.fn(() => vi.fn()),
    })),
    fetchMember: vi.fn(),
    fetchUser: vi.fn(),
  };
}

describe("DiscordVoiceManager sessionChannelId validation", () => {
  beforeAll(async () => {
    managerModule = await import("./manager.js");
  });

  beforeEach(() => {
    joinVoiceChannelMock.mockImplementation(() => createConnectionMock());
    entersStateMock.mockResolvedValue(undefined);
    createAudioPlayerMock.mockReturnValue({ on: vi.fn() });
    resolveAgentRouteMock.mockReturnValue({ sessionKey: "discord:g1:c1", agentId: "agent-1" });
  });

  const createManager = (clientOverride?: ReturnType<typeof createClient>) =>
    new managerModule.DiscordVoiceManager({
      client: (clientOverride ?? createClient()) as never,
      cfg: {},
      discordConfig: {},
      accountId: "default",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });

  // Discord snowflake IDs must be numeric strings for formatMention to work
  const VOICE_CHANNEL_ID = "111111111111111111";
  const TEXT_CHANNEL_ID = "222222222222222222";
  const GUILD_ID = "333333333333333333";

  it("rejects sessionChannelId that resolves to a voice channel", async () => {
    const client = createClient({
      fetchChannel: vi.fn(async (channelId: string) => ({
        id: channelId,
        guildId: GUILD_ID,
        type: ChannelType.GuildVoice,
      })),
    });
    const manager = createManager(client);
    const result = await manager.join({
      guildId: GUILD_ID,
      channelId: VOICE_CHANNEL_ID,
      sessionChannelId: TEXT_CHANNEL_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a text-capable channel");
  });

  it("rejects sessionChannelId from a different guild", async () => {
    const client = createClient({
      fetchChannel: vi.fn(async (channelId: string) => {
        if (channelId === VOICE_CHANNEL_ID) {
          return { id: VOICE_CHANNEL_ID, guildId: GUILD_ID, type: ChannelType.GuildVoice };
        }
        return { id: channelId, guildId: "444444444444444444", type: ChannelType.GuildText };
      }),
    });
    const manager = createManager(client);
    const result = await manager.join({
      guildId: GUILD_ID,
      channelId: VOICE_CHANNEL_ID,
      sessionChannelId: TEXT_CHANNEL_ID,
    });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not in this guild");
  });

  it("accepts a valid text sessionChannelId in the same guild", async () => {
    const client = createClient({
      fetchChannel: vi.fn(async (channelId: string) => {
        if (channelId === VOICE_CHANNEL_ID) {
          return { id: VOICE_CHANNEL_ID, guildId: GUILD_ID, type: ChannelType.GuildVoice };
        }
        return { id: channelId, guildId: GUILD_ID, type: ChannelType.GuildText };
      }),
    });
    const manager = createManager(client);
    const result = await manager.join({
      guildId: GUILD_ID,
      channelId: VOICE_CHANNEL_ID,
      sessionChannelId: TEXT_CHANNEL_ID,
    });
    expect(result.ok).toBe(true);
  });

  it("falls back to voice channel when sessionChannelId is not provided", async () => {
    const client = createClient({
      fetchChannel: vi.fn(async (channelId: string) => ({
        id: channelId,
        guildId: GUILD_ID,
        type: ChannelType.GuildVoice,
      })),
    });
    const manager = createManager(client);
    const result = await manager.join({ guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID });
    expect(result.ok).toBe(true);
  });
});
