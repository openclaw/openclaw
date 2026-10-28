import type { createRealtimeVoiceBridgeSession } from "openclaw/plugin-sdk/realtime-voice";
import { vi, type Mock } from "vitest";
import { ChannelType } from "../internal/discord.js";
import { DiscordGatewayVoiceStateCache } from "../internal/gateway-voice-state-cache.js";
import type { voiceTestMocks } from "./voice-test-mocks.test-support.js";

export type MockCallSource = {
  mock: { calls: ArrayLike<ReadonlyArray<unknown>> };
};

export type TestRealtimeBridgeParams = Omit<
  Parameters<typeof createRealtimeVoiceBridgeSession>[0],
  "provider" | "onToolCall" | "onReady" | "tools" | "cfg"
> & {
  cfg?: unknown;
  onReady?: () => void;
  onToolCall?: (
    event: { args: unknown; callId: string; itemId: string; name: string },
    session: unknown,
  ) => Promise<void> | void;
  tools?: Array<{ name: string }>;
};

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

export function mockCall(source: MockCallSource, index: number, label: string) {
  const call = source.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call: ${label}`);
  }
  return call;
}

export function lastMockCall(source: MockCallSource, label: string) {
  return mockCall(source, source.mock.calls.length - 1, label);
}

export function createRealtimeBridgeTestHelpers(
  createBridge: typeof voiceTestMocks.createRealtimeVoiceBridgeSessionMock,
) {
  const bridgeParamsAt = (index: number): TestRealtimeBridgeParams =>
    requireRecord(
      mockCall(createBridge, index, "realtime bridge")[0],
      "realtime bridge params",
    ) as TestRealtimeBridgeParams;
  const realtimeBridgeAt = (index: number) => {
    const result = createBridge.mock.results[index];
    if (result?.type !== "return") {
      throw new Error(`expected realtime provider session at index ${index}`);
    }
    return { bridgeParams: bridgeParamsAt(index), session: result.value };
  };
  const lastRealtimeBridge = () => realtimeBridgeAt(createBridge.mock.calls.length - 1);
  // Factory callbacks can fire before their mock result is available.
  const lastRealtimeBridgeParams = () => bridgeParamsAt(createBridge.mock.calls.length - 1);
  const sentUserMessages = (session?: typeof voiceTestMocks.realtimeSessionMock) => {
    const sessions = session
      ? [session]
      : createBridge.mock.results.flatMap((result) =>
          result.type === "return" ? [result.value] : [],
        );
    return [...new Set(sessions)].flatMap((source) =>
      Array.from(source.sendUserMessage.mock.calls).map(([message]) => String(message)),
    );
  };
  return { realtimeBridgeAt, lastRealtimeBridge, lastRealtimeBridgeParams, sentUserMessages };
}

export function createDiscordVoiceTestHelpers(updateVoiceStateMock: ReturnType<typeof vi.fn>) {
  const voicePlugin = () => ({
    getGatewayAdapterCreator: vi.fn(() =>
      vi.fn(() => ({ sendPayload: vi.fn(() => true), destroy: vi.fn() })),
    ),
    getGateway: vi.fn(() => ({ updateVoiceState: updateVoiceStateMock })),
  });
  const createVoiceChannelInfo = (channelId: string, guildId = "g1", guildName = "Guild One") => ({
    id: channelId,
    guildId,
    guild: { id: guildId, name: guildName },
    type: ChannelType.GuildVoice,
  });
  type VoiceChannelInfo = ReturnType<typeof createVoiceChannelInfo>;

  const createClient = () => {
    const voiceStateCache = new DiscordGatewayVoiceStateCache();
    return {
      rest: { get: vi.fn() as Mock },
      fetchChannel: vi.fn(async (channelId: string): Promise<VoiceChannelInfo | null> =>
        createVoiceChannelInfo(channelId),
      ),
      fetchGuild: vi.fn(async (guildId: string) => ({ id: guildId, name: "Guild One" })),
      getPlugin: vi.fn((id?: string): unknown =>
        id === "gateway"
          ? {
              listVoiceChannelStates: voiceStateCache.listVoiceChannelStates.bind(voiceStateCache),
              takeVoiceStateTransition: voiceStateCache.takeTransition.bind(voiceStateCache),
            }
          : id === "voice"
            ? voicePlugin()
            : undefined,
      ),
      fetchMember: vi.fn() as Mock,
      fetchUser: vi.fn() as Mock,
    };
  };

  const createClientWithMember = (
    id: string,
    globalName: string,
    discriminator: string,
    nickname = `${globalName} Nick`,
  ) => {
    const client = createClient();
    client.fetchMember.mockResolvedValue({
      nickname,
      roles: [],
      user: { id, username: globalName.toLowerCase(), globalName, discriminator },
    });
    return client;
  };

  const configureVoiceStateGateway = (
    client: ReturnType<typeof createClient>,
    listVoiceChannelStates: (...args: unknown[]) => unknown,
  ) => {
    client.getPlugin.mockImplementation((id?: string) => {
      if (id === "gateway") {
        return { listVoiceChannelStates: vi.fn(listVoiceChannelStates) };
      }
      return voicePlugin();
    });
  };

  return { configureVoiceStateGateway, createClient, createClientWithMember };
}

export function createDefaultVoiceStates() {
  return [
    ["u-owner", "peter", "Peter"],
    ["u-friend", "sam", "Sam"],
    ["bot-user", "molty", "Molty"],
  ].map(([userId, username, name]) => ({
    guild_id: "g1",
    user_id: userId,
    channel_id: "1001",
    member: { nick: name, user: { id: userId, username, global_name: name } },
  }));
}

export function createVoiceTestRuntime() {
  return { log: vi.fn() as Mock, error: vi.fn() as Mock, exit: vi.fn() as Mock };
}
