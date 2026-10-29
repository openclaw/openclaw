import fs from "node:fs/promises";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { useAutoCleanupTempDirTracker, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as MattermostRuntime from "../runtime.js";
import { runMattermostMessageAction, type MattermostMessageActionParams } from "./actions.js";
import type * as MattermostRuntimeApi from "./runtime-api.js";

const TOKEN = "mattermost-loopback-actions-token";
const CH = "chan1chan1chan1chan1chan1c";
const TO = `channel:${CH}`;
const ROOTS = ["/tmp/w"];

const state = vi.hoisted(() => ({
  runtimeCore: undefined as unknown,
  loadOutboundMediaFromUrl: vi.fn(async (mediaUrl: string) => ({
    buffer: Buffer.from("png-bytes"),
    fileName: mediaUrl.split("/").at(-1),
    contentType: "image/png",
  })),
}));

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MattermostRuntime>()),
  getMattermostRuntime: () => state.runtimeCore,
  getOptionalMattermostRuntime: () => state.runtimeCore,
}));
vi.mock("./runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof MattermostRuntimeApi>()),
  loadOutboundMediaFromUrl: state.loadOutboundMediaFromUrl,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  state.loadOutboundMediaFromUrl.mockClear();
  vi.unstubAllEnvs();
});

const post = (id: string, message: string, create_at: number, user_id: string) => ({
  id,
  channel_id: CH,
  message,
  create_at,
  user_id,
});
const posts = {
  order: ["post-2", "post-1"],
  posts: {
    "post-1": post("post-1", "older", 1_714_000_000_000, "user-2"),
    "post-2": post("post-2", "newer", 1_714_000_001_000, "user-gone"),
  },
};
const routes: Record<string, unknown> = {
  "GET /api/v4/users/me": { id: "bot-user" },
  "POST /api/v4/users/ids": [{ id: "user-2", username: "bob" }],
  "GET /api/v4/users/bot-user/teams": [{ id: "team-1" }],
  "GET /api/v4/users/user-1": { id: "user-1", first_name: "Alice", last_name: "Lee" },
  "GET /api/v4/users/user-2": { id: "user-2", username: "bob" },
  "GET /api/v4/users/user-3": { id: "user-3", username: "mallory" },
  [`GET /api/v4/channels/${CH}/members/user-2`]: { channel_id: CH, user_id: "user-2" },
  [`GET /api/v4/channels/${CH}`]: { id: CH, name: "deploys", team_id: "team-1", purpose: "Ship" },
  [`GET /api/v4/channels/${CH}/stats`]: { member_count: 7 },
  [`GET /api/v4/channels/${CH}/pinned`]: posts,
  "GET /api/v4/posts/post-1": posts.posts["post-1"],
  "GET /api/v4/posts/post-other": { id: "post-other", channel_id: "chan-other" },
  "PUT /api/v4/posts/post-1/patch": { id: "post-1", message: "edited" },
  "DELETE /api/v4/posts/post-1": { status: "OK" },
  "POST /api/v4/posts/post-1/pin": { status: "OK" },
  "POST /api/v4/posts/post-1/unpin": { status: "OK" },
  "POST /api/v4/teams/team-1/posts/search": {
    order: ["post-leak", ...posts.order],
    posts: { ...posts.posts, "post-leak": { id: "post-leak", channel_id: "chan-other" } },
  },
  "GET /api/v4/emoji?page=0&per_page=5&sort=name": [
    { id: "e1", name: "partyparrot" },
    { id: "e2", name: "shipit" },
  ],
  "GET /api/v4/files/file-1/info": { id: "file-1", name: "shot.png", size: 12, post_id: "post-1" },
  "GET /api/v4/files/file-1": Buffer.from("0123456789ab"),
  "POST /api/v4/files": { file_infos: [{ id: "file-up" }] },
  "POST /api/v4/posts": { id: "post-upload", channel_id: CH, message: "shot" },
};

type Request = { method: string; url: string; body?: string };

function withLoopbackMattermost(body: (baseUrl: string, requests: Request[]) => Promise<void>) {
  const requests: Request[] = [];
  return withServer(
    (request, response) => {
      const method = request.method ?? "GET";
      const url = request.url ?? "";
      let requestBody = "";
      request.on("data", (chunk) => {
        requestBody += String(chunk);
      });
      request.on("end", () => {
        requests.push({ method, url, body: requestBody });
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${TOKEN}`) {
          response.writeHead(401);
          response.end(JSON.stringify({ message: "unauthorized" }));
          return;
        }
        const payload = Object.hasOwn(routes, `${method} ${url}`)
          ? routes[`${method} ${url}`]
          : null;
        response.writeHead(payload ? 200 : 404);
        if (Buffer.isBuffer(payload)) {
          response.end(payload);
          return;
        }
        response.end(JSON.stringify(payload ?? { message: `unknown loopback route ${url}` }));
      });
    },
    (baseUrl) => body(baseUrl, requests),
  );
}

function loopbackConfig(baseUrl: string, groupPolicy: "open" | "allowlist" = "open") {
  const network = { dangerouslyAllowPrivateNetwork: true };
  return {
    channels: { mattermost: { enabled: true, baseUrl, botToken: TOKEN, groupPolicy, network } },
  };
}

const toolContext = { currentChannelProvider: "mattermost", currentChannelId: TO };
const operator = { context: { conversationReadOrigin: "direct-operator" as const } };
const foreignAccount: Partial<MattermostMessageActionParams> = {
  context: {
    conversationReadOrigin: "delegated",
    requesterAccountId: "other-account",
    toolContext,
  },
};
const revoked: Partial<MattermostMessageActionParams> = {
  context: {
    conversationReadOrigin: "direct-operator",
    assertDirectAdapterHandoff: () => {
      throw new Error("message action caller is no longer active");
    },
  },
  mediaLocalRoots: ROOTS,
};

function run(
  baseUrl: string,
  action: MattermostMessageActionParams["action"],
  params: Record<string, unknown>,
  overrides: Partial<MattermostMessageActionParams> = {},
) {
  const runtimeCore = createPluginRuntimeMock();
  runtimeCore.channel.media.saveRemoteMedia = saveRemoteMedia;
  state.runtimeCore = runtimeCore;
  return runMattermostMessageAction({
    action,
    params,
    cfg: loopbackConfig(baseUrl),
    accountId: "default",
    context: {
      conversationReadOrigin: "delegated",
      requesterAccountId: "default",
      requesterSenderId: "user-1",
      toolContext,
    },
    ...overrides,
  });
}

const parse = (result: Awaited<ReturnType<typeof runMattermostMessageAction>>) => {
  const content = result.content[0];
  return JSON.parse(content?.type === "text" ? content.text : "{}") as Record<string, unknown>;
};

const requestKeys = (requests: Request[]) =>
  requests.map((entry) => `${entry.method} ${entry.url}`);

// `openclaw message list-pins|search --channel mattermost` prints rows through the shared CLI
// formatter (src/commands/message-format.ts, renderMessageList): it reads `pins`/`messages` and
// each row's `id`, `user`, `content`, and `timestamp`, else it falls back to an object summary
// with a `--json` hint. The pins and search tests below pin that envelope and those fields.

describe("mattermost message actions", () => {
  it.each([
    ["edit", "PUT /api/v4/posts/post-1/patch"],
    ["delete", "DELETE /api/v4/posts/post-1"],
    ["pin", "POST /api/v4/posts/post-1/pin"],
    ["unpin", "POST /api/v4/posts/post-1/unpin"],
  ] as const)("%s writes only inside the authorized conversation", async (action, expected) => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      await run(baseUrl, action, { messageId: "post-1", to: TO, message: "edited" });
      expect(requestKeys(requests)).toContain(expected);
      // The post lookup settles authorization first; a write would 404 with a different error.
      await expect(
        run(baseUrl, action, { messageId: "post-other", to: TO, message: "edited" }),
      ).rejects.toThrow("different conversation");
    });
  });

  it.each(["edit", "delete", "pin", "unpin", "upload-file", "download-file"] as const)(
    "%s stops at a revoked caller before any provider request",
    async (action) => {
      await withLoopbackMattermost(async (baseUrl, requests) => {
        const params = { messageId: "post-1", to: TO, message: "edited", filePath: "/tmp/w/a.png" };
        await expect(run(baseUrl, action, params, revoked)).rejects.toThrow("no longer active");
        expect(requests).toEqual([]);
      });
    },
  );

  it("lists pins in the shape the message CLI prints", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      const pins = parse(await run(baseUrl, "list-pins", { target: TO }));
      expect(pins).not.toHaveProperty("messages");
      expect(pins).toMatchObject({
        ok: true,
        channelId: CH,
        pins: [
          {
            id: "post-2",
            channel_id: CH,
            user_id: "user-gone",
            user: "user-gone",
            content: "newer",
            timestamp: "2024-04-24T23:06:41.000Z",
          },
          { id: "post-1", user: "bob", content: "older", timestamp: "2024-04-24T23:06:40.000Z" },
        ],
      });
    });
  });

  it("returns member, channel and emoji details", async () => {
    await withLoopbackMattermost(async (baseUrl) => {
      expect(parse(await run(baseUrl, "member-info", {}))).toMatchObject({
        user: { id: "user-1", displayName: "Alice Lee", isBot: false },
      });
      expect(parse(await run(baseUrl, "member-info", { userId: "user-2" }))).toMatchObject({
        user: { id: "user-2", username: "bob" },
      });
      expect(parse(await run(baseUrl, "channel-info", { target: TO }))).toMatchObject({
        channel: { id: CH, name: "deploys", purpose: "Ship", memberCount: 7 },
      });
      expect(parse(await run(baseUrl, "emoji-list", { limit: 5 }))).toMatchObject({
        emoji: [
          { id: "e1", name: "partyparrot" },
          { id: "e2", name: "shipit" },
        ],
      });
    });
  });

  it("scopes delegated search to the authorized channel and drops posts from elsewhere", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      const result = parse(
        await run(baseUrl, "search", { query: "release", channelId: CH, limit: 5 }),
      );
      const search = requests.find((entry) => entry.url.endsWith("/posts/search"));
      expect(JSON.parse(search?.body ?? "{}")).toMatchObject({
        terms: "in:deploys release",
        per_page: 5,
      });
      expect(result).toMatchObject({
        ok: true,
        teamId: "team-1",
        channelId: CH,
        messages: [
          {
            id: "post-2",
            user: "user-gone",
            content: "newer",
            timestamp: "2024-04-24T23:06:41.000Z",
          },
          { id: "post-1", user: "bob", content: "older", timestamp: "2024-04-24T23:06:40.000Z" },
        ],
      });
      expect(result.messages).toHaveLength(2);
    });
  });

  it("rejects delegated searches without a channel or with in: operators; operators search the team", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      for (const [params, error] of [
        [{ query: "release" }, "requires a channel target"],
        [{ query: "in:other release", channelId: CH }, "remove in: operators"],
        [{ query: "release -in:deploys", channelId: CH }, "remove in: operators"],
      ] as const) {
        await expect(run(baseUrl, "search", params)).rejects.toThrow(error);
      }
      expect(requests).toEqual([]);
      await run(baseUrl, "search", { query: "release" }, operator);
      expect(requestKeys(requests)).toContain("POST /api/v4/teams/team-1/posts/search");
    });
  });

  it("refuses member info for users outside the current conversation", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      await expect(run(baseUrl, "member-info", { userId: "user-3" })).rejects.toThrow(
        "limited to members of the current conversation",
      );
      expect(requestKeys(requests)).toEqual([`GET /api/v4/channels/${CH}/members/user-3`]);
    });
  });

  it.each([
    ["member-info", {}],
    ["emoji-list", { limit: 5 }],
    ["channel-info", { target: TO }],
    ["download-file", { fileId: "file-1" }],
  ] as const)(
    "%s refuses a delegated caller from another account before any request",
    async (action, params) => {
      await withLoopbackMattermost(async (baseUrl, requests) => {
        await expect(run(baseUrl, action, params, foreignAccount)).rejects.toThrow(
          "require the current Mattermost account",
        );
        expect(requests).toEqual([]);
      });
    },
  );

  it("saves a downloaded file and never fetches its bytes for a caller revoked after the info lookup", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("mattermost-download-"));
      const result = parse(await run(baseUrl, "download-file", { fileId: "file-1" }));
      expect(result).toMatchObject({ ok: true, fileId: "file-1", fileName: "shot.png", size: 12 });
      await expect(fs.stat(result.path as string)).resolves.toMatchObject({ size: 12 });
      expect(requestKeys(requests).at(-1)).toBe("GET /api/v4/files/file-1");

      requests.length = 0;
      // The loopback log flips the revocation as soon as the info response is served.
      const assertDirectAdapterHandoff = () => {
        if (requests.some((entry) => entry.url.endsWith("/files/file-1/info"))) {
          throw new Error("message action caller is no longer active");
        }
      };
      const context = { ...operator.context, assertDirectAdapterHandoff };
      await expect(
        run(baseUrl, "download-file", { fileId: "file-1" }, { context }),
      ).rejects.toThrow("no longer active");
      expect(requestKeys(requests)).toEqual(["GET /api/v4/files/file-1/info"]);
    });
  });

  it("uploads a file through the send path only into a channel the conversation may read", async () => {
    await withLoopbackMattermost(async (baseUrl, requests) => {
      const mediaReadFile = vi.fn(async () => Buffer.from("x"));
      const upload = { filePath: "/tmp/w/a.png", message: "shot" };
      const allowlist = { cfg: loopbackConfig(baseUrl, "allowlist"), mediaLocalRoots: ROOTS };
      await expect(
        run(baseUrl, "upload-file", { ...upload, to: "channel:chan-other" }, allowlist),
      ).rejects.toThrow("not allowed");
      expect(state.loadOutboundMediaFromUrl).not.toHaveBeenCalled();
      expect(requests).toEqual([]);

      const options = { mediaLocalRoots: ROOTS, mediaReadFile };
      const result = parse(await run(baseUrl, "upload-file", { ...upload, to: TO }, options));
      expect(state.loadOutboundMediaFromUrl).toHaveBeenCalledExactlyOnceWith(
        "/tmp/w/a.png",
        expect.objectContaining(options),
      );
      const created = requests.find((entry) => entry.url === "/api/v4/posts");
      expect(JSON.parse(created?.body ?? "{}")).toEqual({
        channel_id: CH,
        message: "shot",
        file_ids: ["file-up"],
      });
      expect(result).toMatchObject({ ok: true, messageId: "post-upload", channelId: CH });
    });
  });
});
