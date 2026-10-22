import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
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
const credentials = {
  guildId,
  channelId,
  sutApplicationId: sutId,
  driverBotToken: "driver",
  sutBotToken: "sut",
};
const configTarget = {
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
    observedAt: new Date(Date.parse("2026-05-03T12:00:00.000Z") + elapsedMs).toISOString(),
    reactions: emojis.map((emoji) => ({ emoji, count: 1 })),
  };
}
const discordStatus = (connected: boolean, extra = {}) => ({
  channelAccounts: {
    discord: [{ accountId: "sut", running: true, connected, restartPending: false, ...extra }],
  },
});

describe("discord live qa runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("forwards Discord Requests through the guarded QA endpoint and preserves null responses", async () => {
    const received: Array<{ authorization?: string; body: string; method?: string; url?: string }> =
      [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          authorization: request.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
          method: request.method,
          url: request.url,
        });
        if (request.method === "DELETE") {
          response.writeHead(204).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    const endpointFetch = createDiscordQaEndpointFetcher(`http://127.0.0.1:${port}/api/v10`);

    try {
      const writeResponse = await endpointFetch(
        new Request("https://discord.com/api/v10/channels/123/messages", {
          body: JSON.stringify({ content: "hello" }),
          headers: {
            authorization: "Bot qa-token",
            "content-type": "application/json",
          },
          method: "POST",
        }),
      );
      await expect(writeResponse.json()).resolves.toEqual({ ok: true });

      const deleteResponse = await endpointFetch(
        new Request("https://discord.com/api/v10/channels/123/messages/456", {
          headers: { authorization: "Bot qa-token" },
          method: "DELETE",
        }),
      );
      expect(deleteResponse.status).toBe(204);
      expect(deleteResponse.body).toBeNull();
      expect(received).toEqual([
        {
          authorization: "Bot qa-token",
          body: JSON.stringify({ content: "hello" }),
          method: "POST",
          url: "/api/v10/channels/123/messages",
        },
        {
          authorization: "Bot qa-token",
          body: "",
          method: "DELETE",
          url: "/api/v10/channels/123/messages/456",
        },
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("resolves optional Discord QA voice channel env var", () => {
    expect(
      testing.resolveDiscordQaRuntimeEnv({
        ...runtimeEnv,
        OPENCLAW_QA_DISCORD_VOICE_CHANNEL_ID: voiceChannelId,
      }),
    ).toEqual({ ...credentials, voiceChannelId });
  });

  it("fails when a required Discord QA env var is missing", () => {
    expect(() =>
      testing.resolveDiscordQaRuntimeEnv({
        ...runtimeEnv,
        OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID: undefined,
      }),
    ).toThrow("OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID");
  });

  it("fails when Discord IDs are not snowflakes", () => {
    expect(() =>
      testing.resolveDiscordQaRuntimeEnv({
        ...runtimeEnv,
        OPENCLAW_QA_DISCORD_GUILD_ID: "qa-guild",
      }),
    ).toThrow("OPENCLAW_QA_DISCORD_GUILD_ID must be a Discord snowflake.");
  });

  it("parses Discord pooled credential payloads", () => {
    expect(testing.parseDiscordQaCredentialPayload({ ...credentials, voiceChannelId })).toEqual({
      ...credentials,
      voiceChannelId,
    });
  });

  it("rejects Discord pooled credential payloads with bad snowflakes", () => {
    expect(() =>
      testing.parseDiscordQaCredentialPayload({ ...credentials, channelId: "channel" }),
    ).toThrow("Discord credential payload_CHANNEL_ID must be a Discord snowflake.");
  });

  it("injects a temporary Discord account into the QA gateway config", () => {
    const baseCfg: OpenClawConfig = {
      plugins: {
        allow: ["memory-core", "qa-channel"],
        entries: {
          "memory-core": { enabled: true },
          "qa-channel": { enabled: true },
        },
      },
      channels: {
        "qa-channel": {
          enabled: true,
          baseUrl: "http://127.0.0.1:43123",
          botUserId: "openclaw",
          botDisplayName: "OpenClaw QA",
          allowFrom: ["*"],
        },
      },
    };

    const next = testing.buildDiscordQaConfig(baseCfg, configTarget);

    expect(next.plugins?.allow).toContain("discord");
    expect(next.plugins?.entries?.discord).toEqual({ enabled: true });
    expect(next.messages?.groupChat?.visibleReplies).toBe("automatic");
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
              requireMention: true,
              users: [driverId],
              channels: {
                [channelId]: {
                  enabled: true,
                  requireMention: true,
                  users: [driverId],
                },
              },
            },
          },
        },
      },
    });
  });

  it("injects tool-only Discord status reaction config for the Mantis scenario", () => {
    const next = testing.buildDiscordQaConfig({}, configTarget, { statusReactionsToolOnly: true });

    expect(next.messages).toMatchObject({
      ackReaction: "👀",
      ackReactionScope: "all",
      groupChat: { visibleReplies: "message_tool" },
      statusReactions: { enabled: true },
    });
    const discordAccount = next.channels?.discord?.accounts?.sut;
    expect(discordAccount?.allowBots).toBe(true);
    expect(discordAccount?.guilds?.[guildId]).toMatchObject({
      requireMention: false,
      channels: { [channelId]: { requireMention: false } },
    });
  });

  it("normalizes observed Discord messages", () => {
    expect(
      normalizeDiscordObservedMessage({
        id: voiceChannelId,
        channel_id: channelId,
        guild_id: guildId,
        content: "hello",
        timestamp: "2026-04-22T12:00:00.000Z",
        author: {
          id: driverId,
          username: "driver",
          bot: true,
        },
        referenced_message: { id: sutId },
      }),
    ).toEqual({
      messageId: voiceChannelId,
      channelId,
      senderId: driverId,
      text: "hello",
      timestamp: "2026-04-22T12:00:00.000Z",
    });
  });

  it("matches Discord scenario replies by SUT id and marker", () => {
    const matches = (senderId: string) =>
      testing.matchesDiscordScenarioReply({
        channelId,
        sutBotId: sutId,
        matchText: "DISCORD_QA_ECHO_TOKEN",
        message: {
          messageId: voiceChannelId,
          channelId,
          senderId,
          text: "reply DISCORD_QA_ECHO_TOKEN",
        },
      });
    expect(matches(sutId)).toBe(true);
    expect(matches(driverId)).toBe(false);
  });

  it("computes Discord RTT from trigger and reply timestamps", () => {
    expect(
      testing.computeDiscordRttMs("2026-04-22T11:59:59.125Z", "2026-04-22T12:00:00.875Z"),
    ).toBe(1750);
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
        startedAtMs: new Date("2026-05-03T12:00:00.000Z").getTime(),
        observedAt: new Date("2026-05-03T12:00:01.000Z"),
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
        { emoji: "👀", count: 2 },
        { emoji: "🤔", count: 1 },
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
    const gateway = {
      call: vi
        .fn()
        .mockResolvedValueOnce(discordStatus(false))
        .mockResolvedValueOnce(discordStatus(true)),
    } as unknown as Parameters<typeof testing.waitForDiscordChannelRunning>[0];

    const readyPromise = testing.waitForDiscordChannelRunning(gateway, "sut");
    await vi.advanceTimersByTimeAsync(600);

    await expect(readyPromise).resolves.toBeUndefined();
    expect(gateway["call"]).toHaveBeenCalledTimes(2);
  });

  it("reports the last Discord status when connection readiness times out", async () => {
    vi.useFakeTimers();
    const gateway = {
      call: vi.fn().mockResolvedValue(
        discordStatus(false, {
          lastError: null,
          lastDisconnect: { error: "runtime-not-ready" },
        }),
      ),
    } as unknown as Parameters<typeof testing.waitForDiscordChannelRunning>[0];

    const readyPromise = testing.waitForDiscordChannelRunning(gateway, "sut");
    const assertion = expect(readyPromise).rejects.toThrow(
      'discord account "sut" did not become connected (last status: running=true connected=false',
    );
    await vi.advanceTimersByTimeAsync(45_500);
    await assertion;
  });

  it("normalizes missing current Discord voice state to null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ message: "Unknown Voice State" }, { status: 404 })),
    );

    await expect(
      testing.getCurrentDiscordVoiceState({
        token: "token",
        guildId,
      }),
    ).resolves.toBeNull();
  });

  it("waits for required Discord application commands to be registered", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([{ id: "623456789012345679", name: "commands" }]))
        .mockResolvedValueOnce(
          Response.json([
            { id: "623456789012345679", name: "commands" },
            { id: "623456789012345678", name: "help" },
          ]),
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
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { message: "You are being rate limited.", retry_after: 0 },
            { status: 429 },
          ),
        )
        .mockResolvedValueOnce(Response.json({ id: driverId })),
    );

    await expect(testing.getCurrentDiscordUser("token")).resolves.toEqual({
      id: driverId,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
