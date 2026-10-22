import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFlowInput,
  createScenarioEnvironment,
  polledReply,
  runtimeEnv as flowEnv,
  sentMessage,
} from "./discord-flow.test-support.js";
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
import { discordQaTranscriptsVoiceAuthorizationScenario } from "./discord-transcripts-authorization.runtime.js";
import { createDiscordQaScenarioEnvironment } from "./scenario-environment.js";
import { runDiscordScenario } from "./scenario-runtime.js";

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

function stubFetch(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetcher.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function expectChannelUsers(patch: OpenClawConfig | undefined, voiceUser: string) {
  expect(patch?.channels?.discord?.accounts?.sut?.guilds?.[guildId]).toMatchObject({
    users: [driverId],
    channels: { [channelId]: { users: [driverId] }, [voiceChannelId]: { users: [voiceUser] } },
  });
}

async function prepareScenario(voiceDestination?: string) {
  const patches: OpenClawConfig[] = [];
  const call = vi.fn(async (method: string, params?: unknown) => {
    if (method === "config.get") {
      return {
        config: {},
        hash: "config-hash",
        appliedConfigHash: "runtime-hash",
        configRevisionHash: "runtime-hash",
      };
    }
    if (method === "config.patch") {
      patches.push(JSON.parse((params as { raw: string }).raw) as OpenClawConfig);
      return { hash: "config-hash" };
    }
    if (method === "channels.status") {
      return {
        channelAccounts: { discord: [{ accountId: "sut", running: true, connected: true }] },
      };
    }
    throw new Error(`unexpected gateway call: ${method}`);
  });
  const { prepareFlow } = createDiscordQaScenarioEnvironment({
    accountId: "sut",
    driverIdentity: { id: driverId, bot: true },
    sutIdentity: { id: sutId, bot: true },
    runtimeEnv: { ...flowEnv, voiceChannelId: voiceDestination },
  });
  const prepared = await prepareFlow(createFlowInput(undefined, call));
  return { call, patches, configureScenario: prepared.discordScenarioContext.configureScenario };
}

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
    const request = (method: string, suffix: string, body?: string) =>
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

    try {
      const writeResponse = await request("POST", "", JSON.stringify({ content: "hello" }));
      await expect(writeResponse.json()).resolves.toEqual({ ok: true });

      const deleteResponse = await request("DELETE", "/456");
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
      plugins: { allow: ["qa-channel"], entries: { "qa-channel": { enabled: true } } },
      channels: { "qa-channel": { enabled: true } },
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

  it("rejects invalid Discord RTT timestamps", () => {
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
    stubFetch(Response.json({ message: "Unknown Voice State" }, { status: 404 }));

    await expect(
      testing.getCurrentDiscordVoiceState({ token: "token", guildId }),
    ).resolves.toBeNull();
  });

  it("waits for required Discord application commands to be registered", async () => {
    vi.useFakeTimers();
    const commands = { id: "623456789012345679", name: "commands" };
    stubFetch(
      Response.json([commands]),
      Response.json([commands, { id: "623456789012345678", name: "help" }]),
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
    stubFetch(
      Response.json({ message: "You are being rate limited.", retry_after: 0 }, { status: 429 }),
      Response.json({ id: driverId }),
    );

    await expect(testing.getCurrentDiscordUser("token")).resolves.toEqual({
      id: driverId,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects transcript capture without an explicit destination before discovery or gateway access", async () => {
    const resolveVoiceChannel = vi
      .spyOn(testing, "resolveDiscordQaVoiceChannel")
      .mockRejectedValue(new Error("must not discover a voice destination"));
    const { call, configureScenario } = await prepareScenario();

    await expect(configureScenario(discordQaTranscriptsVoiceAuthorizationScenario)).rejects.toThrow(
      "requires an explicit QA voiceChannelId",
    );
    expect(resolveVoiceChannel).not.toHaveBeenCalled();
    expect(call).not.toHaveBeenCalled();
  });

  it.each([true, false])("configures the voice channel (explicit: %s)", async (explicit) => {
    const voiceChannel = {
      id: voiceChannelId,
      guild_id: guildId,
      type: 2,
      name: "qa-voice",
      position: 1,
    };
    const request = vi.fn<typeof fetch>(async () =>
      Response.json(
        explicit
          ? voiceChannel
          : [
              { id: channelId, name: "general", position: 0, type: 0 },
              voiceChannel,
              { id: "623456789012345678", name: "stage", position: 2, type: 13 },
            ],
      ),
    );
    vi.stubGlobal("fetch", request);
    const { configureScenario, patches } = await prepareScenario(
      explicit ? voiceChannelId : undefined,
    );
    const configured = await configureScenario(
      explicit
        ? discordQaTranscriptsVoiceAuthorizationScenario
        : testing.discordQaVoiceAutojoinScenario,
    );

    expect(configured.voiceChannel).toEqual(voiceChannel);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[0]).toBe(
      `https://discord.com/api/v10/${explicit ? `channels/${voiceChannelId}` : `guilds/${guildId}/channels`}`,
    );
    expect(patches).toHaveLength(1);
    expect(patches[0]?.channels?.discord?.voice).toEqual({
      enabled: true,
      mode: "stt-tts",
      autoJoin: explicit ? [] : [{ guildId, channelId: voiceChannelId }],
    });
    if (explicit) {
      expect(patches[0]?.tools?.alsoAllow).toContain("transcripts");
      expect(patches[0]?.agents?.entries?.qa?.tools?.alsoAllow).toContain("transcripts");
      expectChannelUsers(patches[0], sutId);
      await configured.configureTranscriptVoiceAccess?.(true);
      expect(patches).toHaveLength(2);
      expectChannelUsers(patches[1], driverId);
      expect(request).toHaveBeenCalledOnce();
    }
  });

  it.each([true, false])(
    "observes channel replies with cleanup headroom (expect reply: %s)",
    async (expectReply) => {
      const implementation = {
        buildRun: () => ({
          kind: "channel-message" as const,
          expectReply,
          input: "ping",
          expectedTextIncludes: expectReply ? ["pong"] : [],
          matchText: "pong",
        }),
      };
      const environment = createScenarioEnvironment({
        configureScenario: vi.fn(async () => ({ cfg: {}, run: implementation.buildRun() })),
        scenario: {
          id: "discord-canary",
          title: "Discord canary",
          timeoutMs: expectReply ? 30_000 : 8_000,
        },
      });
      const timestamps = {
        requestStartedAt: "2026-09-02T12:00:00.000Z",
        responseObservedAt: "2026-09-02T12:00:01.750Z",
      };
      vi.spyOn(testing, "sendChannelMessage").mockResolvedValue(
        sentMessage(voiceChannelId, timestamps.requestStartedAt),
      );
      const poll = vi.spyOn(testing, "pollChannelMessages");
      if (expectReply) {
        poll.mockResolvedValue(
          polledReply("623456789012345678", "pong", timestamps.responseObservedAt),
        );
      } else {
        poll.mockImplementation(async ({ timeoutMs }) => {
          throw new Error(`timed out after ${timeoutMs}ms waiting for Discord message`);
        });
      }
      await expect(runDiscordScenario(environment, implementation)).resolves.toEqual(
        expectReply
          ? {
              details: "reply matched",
              ...timestamps,
              rttMs: 1750,
              rttMeasurement: {
                ...timestamps,
                finalMatchedReplyRttMs: 1750,
                source: "request-to-observed-message",
              },
            }
          : { details: "no reply" },
      );
      if (!expectReply) {
        expect(poll).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 5_000 }));
      }
    },
  );
});
