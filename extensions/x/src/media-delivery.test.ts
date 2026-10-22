import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { xPlugin } from "./channel.js";
import { createXTestApi } from "./test-support/api-client.js";
import { completedMonitor } from "./test-support/completed-monitor.js";
import { client, config, fixture, page, post } from "./test-support/monitor-fixture.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
}));
const roots: string[] = [];
const videoBytes = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
afterEach(async () => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function mediaFixture(failProcessing = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-x-media-"));
  roots.push(root);
  const file = path.join(root, "proof.png");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(file, bytes);
  const mention = {
    ...post("501", "10"),
    entities: { mentions: [{ id: "100", username: "roboclawbot" }] },
  };
  fixture({ posts: [mention] });
  const requests: { path: string; body: unknown }[] = [];
  let nextMediaId = 700;
  let nextPostId = 900;
  const api = createXTestApi({
    fetch: async (url, init) => {
      const route = new URL(url).pathname;
      if (route.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "test-access" });
      }
      if (route === "/2/tweets" && init?.method !== "POST") {
        return Response.json(page([mention]));
      }
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      requests.push({ path: route, body });
      if (route === "/2/media/upload/initialize") {
        return Response.json({ data: { id: String(++nextMediaId) } });
      }
      if (route.endsWith("/append")) {
        return new Response(null, { status: 204 });
      }
      if (route.endsWith("/finalize")) {
        return Response.json({
          data: {
            id: route.split("/")[4],
            ...(failProcessing ? { processing_info: { state: "failed" } } : {}),
          },
        });
      }
      if (route === "/2/tweets") {
        return Response.json({ data: { id: String(++nextPostId) } });
      }
      throw new Error("Unexpected route: " + route);
    },
  });
  client.getXApi.mockResolvedValue(api);
  const context = {
    cfg: config,
    to: "x:501",
    text: "Proof.",
    mediaAccess: { localRoots: [root] },
  };
  const sendMedia = (mediaUrl = file, text = context.text) =>
    xPlugin.outbound!.sendMedia!({ ...context, mediaUrl, text });
  const posts = () => requests.filter((r) => r.path === "/2/tweets").map((r) => r.body);
  return { root, file, bytes, requests, api, context, sendMedia, posts };
}

describe("X native attachment delivery", () => {
  it.each([
    ["action", "image"],
    ["outbound", "image"],
    ["message", "image"],
    ["payload", "image"],
    ["monitor-mediaUrl", "image"],
    ["monitor-mediaUrls", "image"],
    ["action", "empty"],
    ["outbound", "video"],
  ] as const)("attaches native %s media with %s caption", async (route, kind) => {
    const test = await mediaFixture();
    const mediaUrl = kind === "video" ? path.join(test.root, "proof.mp4") : test.file;
    if (kind === "video") {
      await writeFile(mediaUrl, videoBytes);
    }
    const text = kind === "empty" ? "" : kind === "video" ? "Video proof." : "Proof.";
    const ctx = { ...test.context, text };
    if (route === "action") {
      await xPlugin.actions!.handleAction!({
        channel: "x",
        action: "send",
        ...ctx,
        params: { to: ctx.to, ...(text ? { message: text } : {}), media: mediaUrl },
      });
    } else if (route === "payload") {
      await xPlugin.outbound!.sendPayload!({
        ...ctx,
        payload: { text, mediaUrl },
      });
    } else if (route === "message") {
      await xPlugin.message!.send!.media!({ ...ctx, mediaUrl });
    } else if (route === "monitor-mediaUrl" || route === "monitor-mediaUrls") {
      const monitor = completedMonitor({
        cfg: {
          ...config,
          agents: { entries: { maintainer: { workspace: test.root } } },
        },
        visibleSessionUrl: null,
        finals: [
          {
            text: "[[x_success]] Proof.",
            ...(route === "monitor-mediaUrl"
              ? { mediaUrl: test.file }
              : { mediaUrls: [test.file] }),
          },
        ],
      });
      monitor.api.uploadMedia.mockImplementation((params) => test.api.uploadMedia(params));
      monitor.api.reply.mockImplementation((params) => test.api.reply(params));
      await monitor.run();
    } else {
      const result = await test.sendMedia(mediaUrl, text);
      expect(result.receipt?.parts[0]?.kind).toBe("media");
    }
    const expected = {
      ...(text ? { text } : {}),
      reply: { in_reply_to_tweet_id: "501" },
      media: { media_ids: ["701"] },
    };
    expect(test.posts()).toEqual([expected]);
    if (kind !== "image") {
      expect(test.requests.at(-1)?.body).toEqual(expected);
    }
    if (kind === "video") {
      expect(test.requests.find((r) => r.path.endsWith("/initialize"))?.body).toMatchObject({
        media_type: "video/mp4",
        media_category: "tweet_video",
        total_bytes: videoBytes.length,
      });
    }
  });

  it("uploads a gallery once and attaches it only to the first caption chunk", async () => {
    const test = await mediaFixture();
    const second = path.join(test.root, "second.png");
    await writeFile(second, test.bytes);
    const text = "a".repeat(300);
    const result = await xPlugin.outbound!.sendPayload!({
      ...test.context,
      text,
      payload: { text, mediaUrl: test.file, mediaUrls: [test.file, second] },
    });
    expect(test.posts()).toEqual([
      {
        text: "a".repeat(280),
        reply: { in_reply_to_tweet_id: "501" },
        media: { media_ids: ["701", "702"] },
      },
      { text: "a".repeat(20), reply: { in_reply_to_tweet_id: "901" } },
    ]);
    expect(result.receipt?.parts.map((part) => part.kind)).toEqual(["media", "text"]);
  });

  it.each([
    "outside roots",
    "unsupported file",
    "too many",
    "mixed video",
    "oversized image",
  ] as const)("rejects %s before any upload or post", async (scenario) => {
    const test = await mediaFixture();
    let urls = [test.file];
    let allowed = [test.root];
    if (scenario === "outside roots") {
      allowed = [path.join(test.root, "other")];
    }
    if (scenario === "unsupported file") {
      const file = path.join(test.root, "private.txt");
      await writeFile(file, "not an image");
      urls = [file];
    }
    if (scenario === "too many") {
      urls = Array.from({ length: 5 }, (_, i) => path.join(test.root, i + ".png"));
    }
    if (scenario === "mixed video") {
      const video = path.join(test.root, "proof.mp4");
      await writeFile(video, videoBytes);
      urls.push(video);
    }
    if (scenario === "oversized image") {
      await writeFile(test.file, Buffer.concat([test.bytes, Buffer.alloc(5 * 1024 * 1024)]));
    }
    await expect(
      xPlugin.outbound!.sendPayload!({
        ...test.context,
        mediaAccess: { localRoots: allowed },
        payload: { text: "Proof.", mediaUrls: urls },
      }),
    ).rejects.toMatchObject({ name: "PlatformMessageNotDispatchedError", retryable: false });
    expect(test.requests).toEqual([]);
  });

  it("does not post a caption if media processing fails", async () => {
    const test = await mediaFixture(true);
    await expect(test.sendMedia()).rejects.toThrow(/processing failed/i);
    expect(test.requests.some((r) => r.path.endsWith("/finalize"))).toBe(true);
    expect(test.posts()).toEqual([]);
  });
});
