import * as inbound from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { discordPlugin } from "../channel.js";
import { ChannelType } from "../internal/discord.js";
import { createDiscordLoopbackRest } from "../send.test-harness.js";
import { installDiscordIngressTestRuntime } from "../test-support/ingress-runtime.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import {
  createDiscordMessage,
  createDiscordPreflightArgs,
  createGuildEvent,
  createThreadClient,
  DEFAULT_PREFLIGHT_CFG,
  type DiscordClient,
  type DiscordMessageEvent,
} from "./message-handler.preflight.test-helpers.js";
import { processDiscordMessage } from "./message-handler.process.js";

const transcribe = vi.hoisted(() => vi.fn());
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/media-understanding-runtime")>();
  return {
    ...actual,
    createChannelPreflightAudio: (
      params: Parameters<typeof actual.createChannelPreflightAudio>[0],
    ) => actual.createChannelPreflightAudio({ ...params, transcribeFirstAudio: transcribe }),
  };
});
vi.mock("openclaw/plugin-sdk/media-runtime", { spy: true });

installDiscordIngressTestRuntime();
const fixtures = useAutoCleanupTempDirTracker(afterEach);
const fixtureReply = "Fixture assistant reply";

it.each([
  { dm: true, echo: true, transcript: "voice $&", admitted: true, channelId: "700" },
  { dm: false, echo: true, transcript: "hey openclaw $&", admitted: true, channelId: "701" },
  { dm: false, echo: true, transcript: "hello everyone", admitted: false, channelId: "702" },
  { dm: true, echo: false, transcript: "voice $&", admitted: true, channelId: "703" },
])(
  "routes transcript echo through Discord REST (dm=$dm, echo=$echo, admitted=$admitted)",
  async ({ dm, echo, transcript, admitted, channelId }) => {
    const guildId = "710";
    const parentId = "711";
    const senderId = `${channelId}1`;
    const channel = { id: channelId, type: dm ? ChannelType.DM : ChannelType.PublicThread };
    const discordConfig = {
      token: "test-token",
      ...(dm ? { dmPolicy: "allowlist" as const, allowFrom: [senderId] } : {}),
    };
    const stateDir = fixtures.make("discord-transcript-echo-");
    const loopback = await createDiscordLoopbackRest({
      respond: ({ path, method }) =>
        path?.endsWith("/users/@me/channels") || method === "GET"
          ? channel
          : { id: "712", channel_id: channelId },
    });
    const apiUrl = process.env.DISCORD_API_URL;
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    const dispatchTurn = inbound.dispatchChannelInboundTurn;
    const replyResolver = vi.fn(async () => ({ text: fixtureReply }));
    const mediaMarkers: Array<boolean | undefined> = [];
    const dispatch = vi.spyOn(inbound, "dispatchChannelInboundTurn").mockImplementation((plan) => {
      mediaMarkers.push(...(plan.ctxPayload.media ?? []).map((media) => media.transcribed));
      return dispatchTurn({ ...plan, replyResolver });
    });
    try {
      vi.stubEnv("DISCORD_API_URL", `${loopback.rest.options.baseUrl}/api/v10`);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.mocked(saveRemoteMedia).mockResolvedValue({
        id: "voice",
        path: `${stateDir}/voice.ogg`,
        size: 5,
      });
      transcribe.mockResolvedValue(transcript);
      setActivePluginRegistry(
        createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
      );
      const cfg = {
        ...DEFAULT_PREFLIGHT_CFG,
        session: { ...DEFAULT_PREFLIGHT_CFG.session, store: `${stateDir}/sessions.json` },
        messages: { groupChat: { mentionPatterns: ["openclaw"] }, ackReaction: "" },
        agents: { defaults: { typingMode: "never" } },
        channels: { discord: discordConfig },
        tools: { media: { audio: { echoTranscript: echo, echoFormat: "Heard: {transcript}" } } },
      } satisfies OpenClawConfig;
      const message = createDiscordMessage({
        id: `${channelId}0`,
        channelId,
        content: "",
        author: { id: senderId, bot: false },
        // Native voice notes can carry a waveform without an audio MIME.
        attachments: [
          {
            id: "voice",
            filename: "voice.ogg",
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            waveform: "AAAA",
          },
        ],
      });
      const data = dm
        ? ({ channel_id: channelId, author: message.author, message } as DiscordMessageEvent)
        : createGuildEvent({ channelId, guildId, author: message.author, message });
      const client = dm
        ? ({ fetchChannel: async () => channel } as unknown as DiscordClient)
        : createThreadClient({ threadId: channelId, parentId });
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const preflight = await preflightDiscordMessage({
        ...createDiscordPreflightArgs({ cfg, discordConfig, client, data }),
        allowFrom: discordConfig.allowFrom,
        runtime,
        guildEntries: {
          [guildId]: { channels: { [parentId]: { enabled: true, requireMention: true } } },
        },
      });
      expect(Boolean(preflight)).toBe(admitted);
      if (preflight) {
        await processDiscordMessage(preflight);
        expect(runtime.error).not.toHaveBeenCalled();
      }
      expect(replyResolver).toHaveBeenCalledTimes(admitted ? 1 : 0);
      const posts = loopback.requests
        .filter(({ method, path }) => method === "POST" && path?.endsWith("/messages"))
        .map(({ path, body }) => ({
          path,
          content: (JSON.parse(body) as { content: string }).content,
        }));
      const expectedTexts = admitted ? [fixtureReply] : [];
      if (admitted && echo) {
        expectedTexts.unshift(`Heard: ${transcript}`);
      }
      expect(posts).toEqual(
        expectedTexts.map((content) => ({
          path: `/api/v10/channels/${channelId}/messages`,
          content,
        })),
      );
      expect(mediaMarkers).toEqual(admitted ? [true] : []);
    } finally {
      dispatch.mockRestore();
      vi.mocked(saveRemoteMedia).mockReset();
      transcribe.mockReset();
      resetPluginRuntimeStateForTest();
      vi.stubEnv("DISCORD_API_URL", apiUrl);
      vi.stubEnv("OPENCLAW_STATE_DIR", originalStateDir);
      await Promise.all([loopback.close(), closeOpenClawAgentDatabasesAsync(stateDir)]);
    }
  },
);
