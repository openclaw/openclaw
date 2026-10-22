import { ChannelType } from "discord-api-types/v10";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordError } from "./internal/rest-errors.js";
import { RequestClient } from "./internal/rest.js";
import { discordOutbound } from "./outbound-adapter.js";
import { recordDiscordMessageCreateAmbiguity } from "./retry.js";
import { sendMessageDiscord } from "./send.outbound.js";

const sendPayload = (() => {
  const handler = discordOutbound.sendPayload;
  if (!handler) {
    throw new Error("Expected Discord outbound sendPayload");
  }
  return handler;
})();

it("plain text delegates to sendText", async () => {
  resetGlobalHookRunner();
  const sendDiscord = vi.fn().mockResolvedValue({ messageId: "dc-1", channelId: "123456" });
  const result = await sendPayload({
    cfg: {},
    to: "channel:123456",
    text: "",
    payload: { text: "hello" },
    deps: { sendDiscord },
  });
  expect(sendDiscord).toHaveBeenCalledExactlyOnceWith("channel:123456", "hello", expect.anything());
  expect(result.channel).toBe("discord");
});

describe("Discord forum outbound payload ownership", () => {
  afterEach(() => vi.restoreAllMocks());
  function createForumDelivery(params: {
    channelType?: ChannelType;
    channelData: Record<string, unknown>;
  }) {
    const requests: string[] = [];
    let threadCount = 0;
    let mediaCount = 0;
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input : input.url,
      );
      const route = url.pathname.replace("/api/v10", "");
      const method = init?.method ?? "GET";
      requests.push(`${method} ${route}`);
      let response: Record<string, unknown>;
      if (method === "GET") {
        response = {
          type:
            route === "/channels/forum1"
              ? (params.channelType ?? ChannelType.GuildForum)
              : ChannelType.PublicThread,
        };
      } else if (route === "/channels/forum1/threads") {
        threadCount += 1;
        const threadId = `thread${threadCount}`;
        response = { id: threadId, message: { id: `starter${threadCount}`, channel_id: threadId } };
      } else {
        mediaCount += 1;
        response = { id: `media${mediaCount}`, channel_id: route.split("/")[2] };
      }
      return Response.json(response);
    });
    const rest = new RequestClient("discord-fixture-token", { fetch, queueRequests: false });
    const readFile = vi.fn(async () => Buffer.from("forum attachment"));
    const mediaAccess = { localRoots: [process.cwd()], readFile, workspaceDir: process.cwd() };
    const onDeliveryResult = vi.fn();
    const sendDiscord: typeof sendMessageDiscord = async (target, text, options) =>
      await sendMessageDiscord(target, text, { ...options, rest, token: "discord-fixture-token" });
    const run = () =>
      sendPayload({
        cfg: { channels: { discord: { token: "discord-fixture-token" } } },
        to: "channel:forum1",
        text: "",
        payload: {
          text: "one forum conversation",
          mediaUrls: ["./package.json", "./package.json"],
          channelData: { discord: params.channelData },
        },
        mediaAccess,
        mediaLocalRoots: mediaAccess.localRoots,
        mediaReadFile: readFile,
        deps: { discord: sendDiscord },
        onDeliveryResult,
      });
    vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
    return { fetch, onDeliveryResult, requests, run };
  }

  it.each([
    {
      label: "embedded forum attachments",
      channelData: { embeds: [{ description: "forum embed" }] },
    },
    {
      label: "classic text components downgraded to forum messages",
      channelData: {
        presentationComponents: {
          text: "one forum conversation",
          blocks: [{ type: "text", text: "classic component body" }],
        },
      },
    },
  ])("keeps $label and their complete receipt in their first created thread", async (params) => {
    const delivery = createForumDelivery(params);
    const result = await delivery.run();
    expect(delivery.requests.filter((request) => request.startsWith("POST"))).toEqual([
      "POST /channels/forum1/threads",
      "POST /channels/thread1/messages",
      "POST /channels/thread1/messages",
    ]);
    expect(result).toMatchObject({
      target: { kind: "channel", id: "thread1" },
      receipt: {
        threadId: "thread1",
        platformMessageIds: ["starter1", "media1", "media2"],
        primaryPlatformMessageId: "starter1",
      },
    });
    expect(
      delivery.onDeliveryResult.mock.calls.map(([progressResult]) => progressResult.messageId),
    ).toEqual(["starter1", "media1", "media2"]);
  });

  it.each([
    {
      label: "classic component overrides",
      components: { blocks: [{ type: "file", file: "attachment://declared.txt" }] },
    },
    {
      label: "matching Components V2 overrides",
      components: {
        container: { accentColor: 0x123456 },
        blocks: [{ type: "file", file: "attachment://first.txt" }],
      },
    },
  ])("applies $label only to the first media upload", async ({ components }) => {
    const delivery = createForumDelivery({
      channelType: ChannelType.GuildText,
      channelData: { components, filename: " first.txt " },
    });
    await delivery.run();
    const filenames = delivery.fetch.mock.calls.flatMap(([, init]) => {
      if (!(init?.body instanceof FormData)) {
        return [];
      }
      const file = init.body.get("files[0]");
      return file && typeof file !== "string" ? [file.name] : [];
    });
    expect(filenames).toEqual(["first.txt", "package.json"]);
  });

  it.each([
    {
      name: "interactive components on a forum parent",
      channelType: ChannelType.GuildForum,
      channelData: {
        presentationComponents: {
          text: "interactive message",
          blocks: [{ type: "actions", buttons: [] }],
        },
      },
      error: "Discord components are not supported in forum-style channels",
    },
    {
      name: "a conflicting Components V2 filename",
      channelType: ChannelType.GuildText,
      channelData: {
        filename: "other.txt",
        components: {
          container: { accentColor: 0x123456 },
          blocks: [{ type: "file", file: "attachment://declared.txt" }],
        },
      },
      error:
        'Component file block expects attachment "declared.txt", but the uploaded file is "other.txt"',
    },
  ])("rejects $name before uploading", async ({ error, ...params }) => {
    const delivery = createForumDelivery(params);
    await expect(delivery.run()).rejects.toThrow(error);
    expect(delivery.requests.filter((request) => request.startsWith("POST"))).toEqual([]);
  });
});

function runVoicePayload(mode: "ambiguous" | "source" | "remaining" | "encoder") {
  const deliveredText = mode === "ambiguous" || mode === "encoder";
  const error =
    mode === "source"
      ? new DiscordError(new Response(null, { status: 503 }), {
          message: "audio source unavailable",
        })
      : mode === "ambiguous"
        ? Object.assign(new Error("voice create failed after acceptance"), { status: 503 })
        : new Error("ffmpeg unavailable");
  const onDeliveryResult = vi.fn();
  const voiceDelivery = vi.fn(async () => {
    if (mode === "ambiguous") {
      recordDiscordMessageCreateAmbiguity(error);
    }
    throw error;
  });
  let textDeliveryCalls = 0;
  const textDelivery = vi.fn(async (_to: string, _text: string, sendOptions?: unknown) => {
    const callIndex = textDeliveryCalls++;
    if (mode === "remaining" && callIndex > 0) {
      throw new Error("remaining media unavailable");
    }
    const result = { messageId: "fallback-text", channelId: "123456" };
    await (
      sendOptions as
        | { onDeliveryResult?: (deliveryResult: typeof result) => Promise<void> }
        | undefined
    )?.onDeliveryResult?.(result);
    return result;
  });
  const promise = sendPayload({
    cfg: {},
    to: "channel:123456",
    text: "",
    payload: {
      ...(deliveredText
        ? { ttsSupplement: { spokenText: "answer", visibleTextAlreadyDelivered: true } }
        : { text: "answer" }),
      mediaUrls: [
        "https://example.test/voice.ogg",
        ...(mode === "remaining" ? ["https://example.test/remaining.png"] : []),
      ],
      audioAsVoice: true,
    },
    deps: { discord: textDelivery, discordVoice: voiceDelivery },
    onDeliveryResult,
  });
  return { error, onDeliveryResult, promise, textDelivery, voiceDelivery };
}

it.each([
  ["ambiguous", 0],
  ["source", 1],
  ["remaining", 2],
  ["encoder", 0],
] as const)("preserves %s voice failure and fallback delivery", async (mode, textCalls) => {
  const { error, promise, textDelivery, voiceDelivery, onDeliveryResult } = runVoicePayload(mode);
  await expect(promise).rejects.toBe(error);
  expect(voiceDelivery).toHaveBeenCalledOnce();
  expect(textDelivery).toHaveBeenCalledTimes(textCalls);
  if (textCalls === 1) {
    expect(textDelivery).toHaveBeenCalledExactlyOnceWith(
      "channel:123456",
      "answer",
      expect.objectContaining({ cfg: {} }),
    );
    expect(onDeliveryResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ channel: "discord", messageId: "fallback-text" }),
    );
  }
  if (mode === "encoder") {
    expect(onDeliveryResult).not.toHaveBeenCalled();
  }
});
