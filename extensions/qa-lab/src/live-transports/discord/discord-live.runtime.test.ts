import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import * as discordApi from "@openclaw/discord/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
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
import {
  discordQaTranscriptsVoiceAuthorizationScenario,
  runDiscordTranscriptsVoiceAuthorizationScenario as runTranscriptScenario,
} from "./discord-transcripts-authorization.runtime.js";
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

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function transcriptFixture() {
  const outputDir = tempDirs.make("discord-transcript-auth-");
  const run = discordQaTranscriptsVoiceAuthorizationScenario.buildRun(sutId);
  if (run.kind !== "transcripts-voice-authorization") {
    throw new Error("unexpected scenario run kind");
  }
  const configureTranscriptVoiceAccess = vi.fn(async () => {});
  const environment = createScenarioEnvironment({
    outputDir,
    runtimeEnv: { ...flowEnv, voiceChannelId },
    scenario: {
      id: "discord-transcripts-voice-authorization",
      timeoutMs: 60_000,
      title: "Discord transcript authorization",
    },
  });
  return {
    run,
    configureTranscriptVoiceAccess,
    start: () =>
      runTranscriptScenario(environment, {
        cfg: {},
        run,
        configureTranscriptVoiceAccess,
        voiceChannel: { id: voiceChannelId, type: 2 },
      }),
    evidence: async (): Promise<Record<string, unknown>> =>
      JSON.parse(
        await fs.readFile(
          path.join(outputDir, "discord-transcripts-voice-authorization-evidence.json"),
          "utf8",
        ),
      ),
  };
}

describe("discord live qa runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("forwards Discord Requests through the guarded QA endpoint and preserves null responses", async () => {
    const received: [string | undefined, string, string | undefined, string | undefined][] = [];
    const authorization = "Bot qa-token";
    const messagePath = "/api/v10/channels/123/messages";
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push([
          request.headers.authorization,
          Buffer.concat(chunks).toString("utf8"),
          request.method,
          request.url,
        ]);
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
        new Request(`https://discord.com${messagePath}${suffix}`, {
          method,
          body,
          headers: {
            authorization,
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
        [authorization, JSON.stringify({ content: "hello" }), "POST", messagePath],
        [authorization, "", "DELETE", `${messagePath}/456`],
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

  it.each([
    ["SUT_APPLICATION_ID", undefined, "OPENCLAW_QA_DISCORD_SUT_APPLICATION_ID"],
    ["GUILD_ID", "qa-guild", "OPENCLAW_QA_DISCORD_GUILD_ID must be a Discord snowflake."],
  ])("rejects invalid environment field %s", (field, value, error) => {
    expect(() =>
      testing.resolveDiscordQaRuntimeEnv({
        ...runtimeEnv,
        [`OPENCLAW_QA_DISCORD_${field}`]: value,
      }),
    ).toThrow(error);
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
    const ingress = { requireMention: true, users: [driverId] };
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
            [guildId]: { ...ingress, channels: { [channelId]: { ...ingress, enabled: true } } },
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
    const timestamp = "2026-04-22T12:00:00.000Z";
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
    ).toEqual({ ...polledReply(voiceChannelId, "hello", timestamp).message, senderId: driverId });
  });

  it("matches Discord scenario replies by SUT id and marker", () => {
    const matches = (senderId: string) =>
      testing.matchesDiscordScenarioReply({
        channelId,
        sutBotId: sutId,
        matchText: "DISCORD_QA_ECHO_TOKEN",
        message: {
          ...polledReply(voiceChannelId, "reply DISCORD_QA_ECHO_TOKEN").message,
          senderId,
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

  it.each([true, false])(
    "waits for connection and reports readiness timeouts (connects: %s)",
    async (connects) => {
      vi.useFakeTimers();
      const call = vi.fn().mockResolvedValue(
        discordStatus(false, {
          lastError: null,
          lastDisconnect: { error: "runtime-not-ready" },
        }),
      );
      const gateway = { call } as unknown as Parameters<
        typeof testing.waitForDiscordChannelRunning
      >[0];

      if (connects) {
        call.mockResolvedValueOnce(discordStatus(false)).mockResolvedValueOnce(discordStatus(true));
      }
      const ready = testing.waitForDiscordChannelRunning(gateway, "sut");
      const assertion = connects
        ? expect(ready).resolves.toBeUndefined()
        : expect(ready).rejects.toThrow(
            'discord account "sut" did not become connected (last status: running=true connected=false',
          );
      await vi.advanceTimersByTimeAsync(connects ? 600 : 45_500);
      await assertion;
      if (connects) {
        expect(call).toHaveBeenCalledTimes(2);
      }
    },
  );

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

  it("proves visible denial, authorized join/stop, and message cleanup", async () => {
    const f = transcriptFixture();
    const send = vi
      .spyOn(testing, "sendChannelMessage")
      .mockResolvedValueOnce(sentMessage("623456789012345671", "2026-08-14T12:00:00.000Z"))
      .mockResolvedValueOnce(sentMessage("623456789012345673", "2026-08-14T12:00:01.000Z"))
      .mockResolvedValueOnce(sentMessage("623456789012345675", "2026-08-14T12:00:02.000Z"));
    vi.spyOn(testing, "pollChannelMessages")
      .mockResolvedValueOnce(
        polledReply(
          "623456789012345672",
          `${f.run.negativeMarker} You are not authorized to use this command.`,
        ),
      )
      .mockResolvedValueOnce(polledReply("623456789012345674", f.run.positiveMarker))
      .mockResolvedValueOnce(polledReply("623456789012345676", f.run.stopMarker));
    vi.spyOn(testing, "getCurrentDiscordVoiceState").mockResolvedValue(null);
    vi.spyOn(testing, "waitForDiscordVoiceState").mockResolvedValue({
      channel_id: voiceChannelId,
      guild_id: guildId,
      user_id: sutId,
    });
    const request = vi.spyOn(discordApi, "requestDiscord").mockResolvedValue(undefined);
    await expect(f.start()).resolves.toMatchObject({
      details: "visible denial, authorized transcript join, and verified stop/leave",
    });
    expect(f.configureTranscriptVoiceAccess).toHaveBeenCalledExactlyOnceWith(true);
    expect(send).toHaveBeenCalledTimes(3);
    const prompts = send.mock.calls.map((call) => call[2]);
    expect(prompts[0]).toContain('"action":"start"');
    expect(prompts[0]).toContain(f.run.deniedSessionId);
    expect(prompts[1]).toContain(f.run.allowedSessionId);
    expect(prompts[2]).toContain('"action":"stop"');
    expect(prompts.join("\n")).not.toContain('"accountId"');
    expect(request).toHaveBeenCalledTimes(6);
    expect(await f.evidence()).toEqual({
      schemaVersion: 1,
      scenarioId: "discord-transcripts-voice-authorization",
      denied: { replyObserved: true, visibleDenial: true, voiceStayedDisconnected: true },
      allowed: { replyObserved: true, voiceJoined: true },
      cleanup: {
        emergencyStopAttempted: false,
        messagesDeleted: 6,
        messageDeleteFailures: 0,
        stopReplyObserved: true,
        voiceDisconnected: true,
      },
    });
  });
  it("does not attest voice disconnect when Discord state reads fail", async () => {
    vi.useFakeTimers();
    const f = transcriptFixture();
    vi.spyOn(testing, "getCurrentDiscordVoiceState").mockRejectedValue(
      new Error("REST unavailable"),
    );
    const send = vi
      .spyOn(testing, "sendChannelMessage")
      .mockRejectedValue(new Error("REST unavailable"));
    const rejected = expect(f.start()).rejects.toThrow("did not leave Discord voice channel");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect((await f.evidence()).cleanup).toMatchObject({
      emergencyStopAttempted: true,
      voiceDisconnected: false,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});
