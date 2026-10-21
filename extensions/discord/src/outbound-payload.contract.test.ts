import { ChannelType } from "discord-api-types/v10";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestClient } from "./internal/rest.js";
import { discordOutbound } from "./outbound-adapter.js";
import { sendMessageDiscord } from "./send.outbound.js";

const sendPayload = (() => {
  const handler = discordOutbound.sendPayload;
  if (!handler) {
    throw new Error("Expected Discord outbound sendPayload");
  }
  return handler;
})();

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
