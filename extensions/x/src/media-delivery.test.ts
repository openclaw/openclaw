import { writeFile } from "node:fs/promises";
import path from "node:path";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { xPlugin } from "./channel.js";
import { createXTestApi } from "./test-support/api-client.js";
import { completedMonitor } from "./test-support/completed-monitor.js";
import { client, config, fixture, page, post } from "./test-support/monitor-fixture.js";

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  getXApi: vi.fn(),
}));
const roots = useAutoCleanupTempDirTracker(afterEach);
const videoBytes = Buffer.from("00000018667479706d703432000000006d70343269736f6d", "hex");
const json = (data: unknown) => Response.json({ data });
const posted = (text: string, ids: string[], parent = "501") => ({
  ...(text ? { text } : {}),
  reply: { in_reply_to_tweet_id: parent },
  media: { media_ids: ids },
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
});

async function mediaFixture(scenario = "image") {
  const root = roots.make("openclaw-x-media-");
  const write = async (name: string, content: Buffer | string) => {
    const file = path.join(root, name);
    await writeFile(file, content);
    return file;
  };
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  const file = await write("proof.png", bytes);
  const variants: Record<string, () => Promise<[string, ...string[]]>> = {
    unsupported: async () => [await write("private.txt", "not an image")],
    video: async () => [await write("proof.mp4", videoBytes)],
    mixed: async () => [file, await write("proof.mp4", videoBytes)],
    oversized: async () => [
      await write("proof.png", Buffer.concat([bytes, Buffer.alloc(5 * 1024 * 1024)])),
    ],
    many: async () => [file, ...[1, 2, 3, 4].map((i) => path.join(root, i + ".png"))],
  };
  const urls = await (variants[scenario]?.() ?? Promise.resolve<[string, ...string[]]>([file]));
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
      if (route === "/2/media/upload/initialize" || route === "/2/tweets") {
        return json({ id: String(route === "/2/tweets" ? ++nextPostId : ++nextMediaId) });
      }
      if (route.endsWith("/append")) {
        return new Response(null, { status: 204 });
      }
      if (route.endsWith("/finalize")) {
        return json({
          id: route.split("/")[4],
          ...(scenario === "processing failed" ? { processing_info: { state: "failed" } } : {}),
        });
      }
      throw new Error("Unexpected route: " + route);
    },
  });
  client.getXApi.mockResolvedValue(api);
  const localRoots = [scenario === "outside roots" ? path.join(root, "other") : root];
  const context = { cfg: config, to: "x:501", text: "Proof.", mediaAccess: { localRoots } };
  const posts = () => requests.filter((r) => r.path === "/2/tweets").map((r) => r.body);
  return { root, file, bytes, requests, api, context, posts, write, urls };
}

it.each([
  ["message", "image"],
  ["monitor-mediaUrl", "image"],
  ["monitor-mediaUrls", "image"],
  ["action", "empty"],
  ["outbound", "video"],
] as const)("attaches native %s media with %s caption", async (route, kind) => {
  const test = await mediaFixture(kind);
  const text = kind === "empty" ? "" : kind === "video" ? "Video proof." : "Proof.";
  const ctx = { ...test.context, text, mediaUrl: test.urls[0] };
  if (route === "action") {
    await xPlugin.actions!.handleAction!({
      channel: "x",
      action: "send",
      ...ctx,
      params: { to: ctx.to, ...(text ? { message: text } : {}), media: ctx.mediaUrl },
    });
  } else if (route === "message") {
    await xPlugin.message!.send!.media!(ctx);
  } else if (route === "monitor-mediaUrl" || route === "monitor-mediaUrls") {
    const attachment =
      route === "monitor-mediaUrl" ? { mediaUrl: test.file } : { mediaUrls: [test.file] };
    const monitor = completedMonitor({
      cfg: { ...config, agents: { entries: { maintainer: { workspace: test.root } } } },
      visibleSessionUrl: null,
      finals: [{ text: "[[x_success]] Proof.", ...attachment }],
    });
    monitor.api.uploadMedia.mockImplementation((params) => test.api.uploadMedia(params));
    monitor.api.reply.mockImplementation((params) => test.api.reply(params));
    await monitor.run();
  } else {
    const result = await xPlugin.outbound!.sendMedia!(ctx);
    expect(result.receipt?.parts[0]?.kind).toBe("media");
  }
  expect(test.posts()).toEqual([posted(text, ["701"])]);
  expect(test.requests.at(-1)?.path).toBe("/2/tweets");
  if (kind === "video") {
    expect(test.requests.find((r) => r.path.endsWith("/initialize"))?.body).toMatchObject({
      media_type: "video/mp4",
      media_category: "tweet_video",
    });
  }
});

it("uploads a gallery once and attaches it only to the first caption chunk", async () => {
  const test = await mediaFixture();
  const second = await test.write("second.png", test.bytes);
  const text = "a".repeat(300);
  const result = await xPlugin.outbound!.sendPayload!({
    ...test.context,
    payload: { text, mediaUrl: test.file, mediaUrls: [test.file, second] },
  });
  expect(test.posts()).toEqual([
    posted("a".repeat(280), ["701", "702"]),
    { text: "a".repeat(20), reply: { in_reply_to_tweet_id: "901" } },
  ]);
  expect(result.receipt?.parts.map((part) => part.kind)).toEqual(["media", "text"]);
});

it.each(["outside roots", "unsupported", "many", "mixed", "oversized", "processing failed"])(
  "rejects %s without creating a Post",
  async (scenario) => {
    const test = await mediaFixture(scenario);
    const failed = scenario === "processing failed";
    const send = xPlugin.outbound!.sendPayload!({
      ...test.context,
      payload: { text: "Proof.", mediaUrls: test.urls },
    });
    await expect(send).rejects.toMatchObject({
      name: "PlatformMessageNotDispatchedError",
      retryable: false,
      message: failed ? expect.stringMatching(/processing failed/i) : expect.any(String),
    });
    expect(failed ? test.posts() : test.requests).toEqual([]);
  },
);
