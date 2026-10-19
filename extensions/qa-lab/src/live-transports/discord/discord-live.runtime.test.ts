import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createDiscordQaEndpointFetcher } from "./discord-live.endpoint.js";
import {
  buildDiscordWebMessageUrl,
  collectSeenReactionSequence,
  normalizeDiscordObservedMessage,
  normalizeDiscordReactionSnapshot,
  renderDiscordStatusReactionHtml,
  renderDiscordThreadReplyAttachmentHtml,
} from "./discord-live.evidence.js";
import * as testing from "./discord-live.runtime.js";

const guildId = "123456789012345678";
const channelId = "223456789012345678";
const sutId = "323456789012345678";
const driverId = "423456789012345678";
const voiceChannelId = "523456789012345678";
const timestamp = "2026-04-22T12:00:00.000Z";
const reactionEpoch = Date.parse("2026-05-03T12:00:00.000Z");
const credentials = {
  guildId,
  channelId,
  voiceChannelId,
  driverBotToken: "driver",
  sutBotToken: "sut",
  sutApplicationId: sutId,
};
const accountConfig = {
  guildId,
  channelId,
  driverBotId: driverId,
  sutAccountId: "sut",
  sutBotToken: "sut-token",
};
const runtimeEnv = {
  OPENCLAW_QA_DISCORD_GUILD_ID: guildId,
  OPENCLAW_QA_DISCORD_CHANNEL_ID: channelId,
  OPENCLAW_QA_DISCORD_DRIVER_BOT_TOKEN: "driver",
  OPENCLAW_QA_DISCORD_SUT_BOT_TOKEN: "sut",
  OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID: sutId,
};
function reactionSnapshot(elapsedMs: number, emojis: string[]) {
  return {
    elapsedMs,
    observedAt: new Date(reactionEpoch + elapsedMs).toISOString(),
    reactions: emojis.map((emoji) => ({ emoji, count: 1, me: true })),
  };
}
function accountStatus(
  connected: boolean,
  extra: { lastError?: null; lastDisconnect?: { error: string } } = {},
) {
  return {
    channelAccounts: {
      discord: [{ accountId: "sut", running: true, connected, restartPending: false, ...extra }],
    },
  };
}
function mockGateway(call: ReturnType<typeof vi.fn>) {
  return { call } as unknown as Parameters<typeof testing.waitForDiscordChannelRunning>[0];
}
function mockResponses(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetcher.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetcher);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("forwards Discord Requests through the guarded QA endpoint and preserves null responses", async () => {
  const received: Array<{ authorization?: string; body: string; method?: string; url?: string }> =
    [];
  await withServer(
    async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(chunk);
      }
      received.push({
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method,
        url: request.url,
      });
      if (request.method === "DELETE") {
        response.writeHead(204).end();
      } else {
        response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      }
    },
    async (baseUrl) => {
      const endpointFetch = createDiscordQaEndpointFetcher(`${baseUrl}/api/v10`);
      const request = (method: string, suffix = "", body?: string) =>
        endpointFetch(
          new Request(`https://discord.com/api/v10/channels/123/messages${suffix}`, {
            method,
            body,
            headers: {
              authorization: "Bot qa-token",
              ...(body ? { "content-type": "application/json" } : {}),
            },
          }),
        );

      const writeResponse = await request("POST", "", JSON.stringify({ content: "hello" }));
      await expect(writeResponse.json()).resolves.toEqual({ ok: true });
      const deleteResponse = await request("DELETE", "/456");
      expect(deleteResponse).toMatchObject({ status: 204, body: null });
      expect(received).toEqual(
        [
          ["POST", "/api/v10/channels/123/messages", JSON.stringify({ content: "hello" })],
          ["DELETE", "/api/v10/channels/123/messages/456", ""],
        ].map(([method, url, body]) => ({ method, url, body, authorization: "Bot qa-token" })),
      );
    },
  );
});

it("resolves optional Discord QA voice channel env var", () => {
  expect(
    testing.resolveDiscordQaRuntimeEnv({
      ...runtimeEnv,
      OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID: voiceChannelId,
    }),
  ).toEqual(credentials);
});

it.each([
  ["SUT_APPLICATION_ID", undefined, "OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID"],
  ["GUILD_ID", "qa-guild", "OPENCLAW_QA_DISCORD_GUILD_ID must be a Discord snowflake."],
])("rejects invalid Discord QA %s", (key, value, error) => {
  expect(() =>
    testing.resolveDiscordQaRuntimeEnv({
      ...runtimeEnv,
      [`OPENCLAW_QA_DISCORD_${key}`]: value,
    }),
  ).toThrow(error);
});

it("parses Discord pooled credential payloads", () => {
  expect(testing.parseDiscordQaCredentialPayload({ ...credentials })).toEqual(credentials);
});

it("rejects Discord pooled credential payloads with bad snowflakes", () => {
  expect(() =>
    testing.parseDiscordQaCredentialPayload({
      ...credentials,
      voiceChannelId: undefined,
      channelId: "channel",
    }),
  ).toThrow("Discord credential payload_CHANNEL_ID must be a Discord snowflake.");
});

it("injects a temporary Discord account into the QA gateway config", () => {
  const baseCfg: OpenClawConfig = {
    plugins: {
      allow: ["memory-core", "qa-channel"],
      entries: { "memory-core": { enabled: true }, "qa-channel": { enabled: true } },
    },
    channels: {
      "qa-channel": { enabled: true },
    },
  };

  const next = testing.buildDiscordQaConfig(baseCfg, accountConfig);

  expect(next.plugins).toMatchObject({
    allow: expect.arrayContaining(["discord"]),
    entries: { discord: { enabled: true } },
  });
  expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
  const mentionAccess = { requireMention: true, users: [driverId] };
  expect(next.channels?.discord).toEqual({
    enabled: true,
    defaultAccount: "sut",
    accounts: {
      sut: {
        enabled: true,
        token: "sut-token",
        allowBots: "mentions",
        groupPolicy: "allowlist",
        guilds: {
          [guildId]: {
            ...mentionAccess,
            channels: { [channelId]: { enabled: true, ...mentionAccess } },
          },
        },
      },
    },
  });
});

it("separates text ingress from target voice authorization", () => {
  const next = testing.buildDiscordQaConfig({}, accountConfig, {
    voiceChannelAccess: { channelId: voiceChannelId, users: [sutId] },
  });

  const account = next.channels?.discord?.accounts?.sut;
  expect(next.channels?.discord?.voice).toEqual({
    enabled: true,
    mode: "stt-tts",
    autoJoin: [],
  });
  const guild = account?.guilds?.[guildId];
  expect(guild).toMatchObject({
    users: [driverId],
    channels: { [channelId]: { users: [driverId] }, [voiceChannelId]: { users: [sutId] } },
  });
  expect(next.tools?.alsoAllow).toContain("transcripts");
  expect(next.agents?.entries?.qa?.tools?.alsoAllow).toContain("transcripts");
});

it("injects tool-only Discord status reaction config for the Mantis scenario", () => {
  const next = testing.buildDiscordQaConfig({}, accountConfig, { statusReactionsToolOnly: true });

  expect(next.messages).toMatchObject({
    ackReaction: "👀",
    ackReactionScope: "all",
    groupChat: { visibleReplies: "message_tool" },
    statusReactions: { enabled: true },
  });
  const discordAccount = next.channels?.discord?.accounts?.sut;
  expect(discordAccount).toMatchObject({
    allowBots: true,
    guilds: {
      [guildId]: { requireMention: false, channels: { [channelId]: { requireMention: false } } },
    },
  });
});

it("normalizes observed Discord messages", () => {
  expect(
    normalizeDiscordObservedMessage({
      id: voiceChannelId,
      channel_id: channelId,
      guild_id: guildId,
      content: "hello",
      timestamp,
      author: { id: driverId, username: "driver", bot: true },
      referenced_message: { id: sutId },
    }),
  ).toEqual({
    messageId: voiceChannelId,
    channelId,
    guildId,
    senderId: driverId,
    senderIsBot: true,
    senderUsername: "driver",
    text: "hello",
    replyToMessageId: sutId,
    timestamp,
  });
});

it("matches Discord scenario replies by SUT id and marker", () => {
  const params = {
    channelId,
    sutBotId: sutId,
    matchText: "DISCORD_QA_ECHO_TOKEN",
    message: {
      messageId: voiceChannelId,
      channelId,
      senderId: sutId,
      senderIsBot: true,
      text: "reply DISCORD_QA_ECHO_TOKEN",
    },
  };
  expect(testing.matchesDiscordScenarioReply(params)).toBe(true);
  const other = { ...params.message, messageId: "523456789012345679", senderId: driverId };
  expect(testing.matchesDiscordScenarioReply({ ...params, message: other })).toBe(false);
});

it("computes Discord RTT from trigger and reply timestamps", () => {
  expect(testing.computeDiscordRttMs("2026-04-22T11:59:59.125Z", "2026-04-22T12:00:00.875Z")).toBe(
    1750,
  );
  expect(testing.computeDiscordRttMs("bad", "2026-04-22T12:00:00.875Z")).toBeUndefined();
});

it("collects the status reaction sequence across timeline snapshots", () => {
  expect(
    collectSeenReactionSequence(
      [
        reactionSnapshot(0, ["👀"]),
        reactionSnapshot(250, ["👀", "🤔"]),
        reactionSnapshot(500, ["👍"]),
      ],
      ["👀", "🤔", "👍"],
    ),
  ).toEqual(["👀", "🤔", "👍"]);
});

it("normalizes reaction snapshots from Discord messages", () => {
  expect(
    normalizeDiscordReactionSnapshot({
      startedAtMs: reactionEpoch,
      observedAt: new Date(reactionEpoch + 1000),
      message: {
        id: voiceChannelId,
        channel_id: channelId,
        reactions: [
          { count: 1, emoji: { name: "🤔" }, me: true },
          { count: 2, emoji: { name: "👀" }, me: false },
        ],
      },
    }),
  ).toEqual({
    elapsedMs: 1000,
    observedAt: "2026-05-03T12:00:01.000Z",
    reactions: [
      { emoji: "👀", count: 2, me: false },
      { emoji: "🤔", count: 1, me: true },
    ],
  });
});

it("renders a human-readable status reaction timeline artifact", () => {
  const html = renderDiscordStatusReactionHtml({
    scenarioTitle: "Discord's status reactions",
    expectedSequence: ["👀", "🤔", "👍"],
    seenSequence: ["👀", "🤔"],
    snapshots: [reactionSnapshot(0, ["👀"])],
  });

  expect(html).toContain("Discord&#39;s status reactions");
  expect(html).toContain("Expected: 👀 → 🤔 → 👍");
  expect(html).toContain("Seen: 👀 → 🤔");
});

it("renders a human-readable thread attachment artifact", () => {
  const html = renderDiscordThreadReplyAttachmentHtml({
    attachmentFilenames: [],
    expectedAttachmentFilename: "mantis-thread-report.md",
    messageContent: "Mantis' thread attachment reply",
    scenarioTitle: "Discord thread reply preserves filePath attachment",
    status: "fail",
    threadName: "mantis-thread-filepath-1234",
  });

  expect(html).toContain("Attachment missing");
  expect(html).toContain("Mantis&#39; thread attachment reply");
  expect(html).toContain("No attachments on the SUT thread reply");
  expect(html).toContain("mantis-thread-report.md");
});

it("builds Discord Web message URLs for logged-in Mantis capture", () => {
  expect(
    buildDiscordWebMessageUrl({
      guildId: "111111111111111111",
      messageId: "333333333333333333",
      threadId: "222222222222222222",
    }),
  ).toBe("https://discord.com/channels/111111111111111111/222222222222222222/333333333333333333");
});

it("waits for the Discord account to become connected, not just running", async () => {
  vi.useFakeTimers();
  const gateway = mockGateway(
    vi.fn().mockResolvedValueOnce(accountStatus(false)).mockResolvedValueOnce(accountStatus(true)),
  );

  const readyPromise = testing.waitForDiscordChannelRunning(gateway, "sut");
  await vi.advanceTimersByTimeAsync(600);

  await expect(readyPromise).resolves.toBeUndefined();
  expect(gateway["call"]).toHaveBeenCalledTimes(2);
});

it("reports the last Discord status when connection readiness times out", async () => {
  vi.useFakeTimers();
  const disconnected = accountStatus(false, {
    lastError: null,
    lastDisconnect: { error: "runtime-not-ready" },
  });
  const gateway = mockGateway(vi.fn().mockResolvedValue(disconnected));

  const readyPromise = testing.waitForDiscordChannelRunning(gateway, "sut");
  const assertion = expect(readyPromise).rejects.toThrow(
    'discord account "sut" did not become connected (last status: running=true connected=false',
  );
  await vi.advanceTimersByTimeAsync(45_500);
  await assertion;
});

it("discovers the first visible Discord voice channel for the voice smoke", async () => {
  mockResponses(
    Response.json([
      { id: guildId, name: "general", position: 0, type: 0 },
      { id: voiceChannelId, name: "qa-voice", position: 1, type: 2 },
      { id: "623456789012345678", name: "stage", position: 2, type: 13 },
    ]),
  );

  const voiceChannel = await testing.resolveDiscordQaVoiceChannel({ token: "token", guildId });
  expect(voiceChannel).toMatchObject({ id: voiceChannelId, name: "qa-voice" });
});

it("normalizes missing current Discord voice state to null", async () => {
  mockResponses(Response.json({ message: "Unknown Voice State" }, { status: 404 }));

  await expect(
    testing.getCurrentDiscordVoiceState({ token: "token", guildId }),
  ).resolves.toBeNull();
});

it("waits for required Discord application commands to be registered", async () => {
  vi.useFakeTimers();
  mockResponses(
    ...[["commands"], ["commands", "help"]].map((names) =>
      Response.json(names.map((name) => ({ name }))),
    ),
  );

  const registeredPromise = testing.assertDiscordApplicationCommandsRegistered({
    token: "token",
    applicationId: sutId,
    expectedCommandNames: ["help", "commands"],
    timeoutMs: 5_000,
  });
  await vi.advanceTimersByTimeAsync(1_100);

  await expect(registeredPromise).resolves.toEqual({
    commandNames: ["commands", "help"],
  });
  const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers;
  expect(headers).toBeInstanceOf(Headers);
  expect(new Headers(headers).get("authorization")).toBe("Bot token");
});

it("aborts Discord identity probes after the API helper timeout", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn((_input: string | URL | globalThis.Request, init?: RequestInit) => {
      signal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
          once: true,
        });
      });
    }),
  );

  const request = testing.getCurrentDiscordUser("token");
  const rejection = expect(request).rejects.toBeInstanceOf(Error);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await rejection;
  expect(signal?.aborted).toBe(true);
});

it("retries Discord REST requests after a 429 rate limit", async () => {
  mockResponses(
    Response.json({ message: "You are being rate limited.", retry_after: 0 }, { status: 429 }),
    Response.json({ id: driverId }),
  );

  await expect(testing.getCurrentDiscordUser("token")).resolves.toEqual({ id: driverId });
  expect(fetch).toHaveBeenCalledTimes(2);
});
