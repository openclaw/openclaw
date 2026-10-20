import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createMattermostMonitorResources,
  formatMattermostInboundMediaText,
  formatMattermostPendingMediaText,
} from "./monitor-resources.js";

const fetchMattermostChannel = vi.hoisted(() => vi.fn());
const fetchMattermostUser = vi.hoisted(() => vi.fn());
const sendMattermostTyping = vi.hoisted(() => vi.fn());
const updateMattermostPost = vi.hoisted(() => vi.fn());
const buildButtonProps = vi.hoisted(() => vi.fn());

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return {
    ...actual,
    fetchMattermostChannel,
    fetchMattermostUser,
    sendMattermostTyping,
    updateMattermostPost,
  };
});

// mock-isolation: Exercise button construction without interaction secret or callback registries.
vi.mock("./interactions.js", () => ({ buildButtonProps }));

type ResourceOptions = Parameters<typeof createMattermostMonitorResources>[0];
const mediaClient = {
  apiBaseUrl: "https://chat.example.com/api/v4",
  baseUrl: "https://chat.example.com",
  token: "bot-token",
} as ResourceOptions["client"];

function createResources(options: Partial<ResourceOptions> = {}) {
  return createMattermostMonitorResources({
    accountId: "default",
    callbackUrl: "https://openclaw.test/callback",
    client: {} as never,
    logger: {},
    mediaMaxBytes: 1024,
    saveRemoteMedia: vi.fn(),
    mediaKindFromMime: () => "document",
    ...options,
  });
}

it("omits an unusable unavailable attachment name", () => {
  expect(
    formatMattermostInboundMediaText({
      body: "",
      nativeMedia: [{}],
      materializedMedia: [{ kind: "document", fileName: "\u0000\u0001" }],
    }),
  ).toBe("[mattermost attachment unavailable]");
});

it("bounds multiple unavailable attachment names without losing their count", () => {
  const materializedMedia = Array.from({ length: 4 }, (_, index) => ({
    kind: "document" as const,
    fileName: index === 0 ? "first.pdf" : `${index}-${"a".repeat(250)}.pdf`,
  }));
  const result = formatMattermostInboundMediaText({
    body: "",
    nativeMedia: materializedMedia.map(() => ({})),
    materializedMedia,
  });

  expect(result).toContain("[mattermost 4 attachments unavailable]");
  expect(result).toContain('"first.pdf, ');
  expect(result.length).toBeLessThanOrEqual(560);
});

it("keeps successfully materialized media-only text empty", () => {
  expect(
    formatMattermostInboundMediaText({
      body: "",
      nativeMedia: [{}],
      materializedMedia: [{ path: "/tmp/q1.pdf", contentType: "application/pdf" }],
    }),
  ).toBe("");
});

it("renders type-only attachment facts only in pending room text", () => {
  expect(formatMattermostPendingMediaText({ body: "", media: [{}, {}] })).toBe(
    "<media:attachment> (2 attachments)",
  );
  expect(formatMattermostPendingMediaText({ body: "caption", media: [{}] })).toBe(
    "caption\n<media:attachment>",
  );
});

beforeEach(() => {
  fetchMattermostChannel.mockReset();
  fetchMattermostUser.mockReset();
  sendMattermostTyping.mockReset();
  updateMattermostPost.mockReset();
  buildButtonProps.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("downloads media, preserves auth headers, and infers media kind", async () => {
  const saveRemoteMedia = vi.fn(async () => ({
    path: "/tmp/file.png",
    contentType: "image/png",
    fileName: "original screenshot.png",
  }));

  const resources = createResources({
    client: mediaClient,
    saveRemoteMedia,
    mediaKindFromMime: () => "image",
  });

  await expect(resources.resolveMattermostMedia([" file-1 "])).resolves.toEqual([
    {
      path: "/tmp/file.png",
      contentType: "image/png",
      fileName: "original screenshot.png",
      kind: "image",
    },
  ]);

  expect(saveRemoteMedia).toHaveBeenCalledWith({
    url: "https://chat.example.com/api/v4/files/file-1",
    requestInit: { headers: { Authorization: "Bearer bot-token" } },
    filePathHint: "file-1",
    maxBytes: 1024,
    ssrfPolicy: { allowedHostnames: ["chat.example.com"] },
    responseHeaderTimeoutMs: 120_000,
    readIdleTimeoutMs: 30_000,
  });
});

it("keeps partial download failures aligned with native media metadata", async () => {
  const saveRemoteMedia = vi
    .fn()
    .mockResolvedValueOnce({ path: "/tmp/file.png", contentType: "image/png" })
    .mockRejectedValueOnce(new Error("download failed"));
  const request = vi.fn(async (requestPath: string) => {
    expect(requestPath).toBe("/files/file-audio/info");
    return { mime_type: "audio/mpeg", name: "private-unavailable-recording.mp3" };
  });
  const resources = createResources({
    client: { ...mediaClient, request },
    saveRemoteMedia,
    mediaKindFromMime: (contentType?: string) =>
      contentType === "audio/mpeg" ? "audio" : contentType === "image/png" ? "image" : null,
  } as unknown as Parameters<typeof createMattermostMonitorResources>[0]);

  await expect(resources.resolveMattermostMedia(["file-image", "file-audio"])).resolves.toEqual([
    { path: "/tmp/file.png", contentType: "image/png", kind: "image" },
    { contentType: "audio/mpeg", fileName: "private-unavailable-recording.mp3", kind: "audio" },
  ]);
  expect(request).toHaveBeenCalledTimes(1);
});

it("rejects unsafe file paths before media download", async () => {
  const saveRemoteMedia = vi.fn();
  const resources = createResources({
    client: { ...mediaClient, token: "test-token" },
    saveRemoteMedia,
  });

  await expect(
    resources.resolveMattermostMedia([
      "../users/me",
      "%2e%2e/users/me",
      "..\\users\\me",
      ".%0a./users/me",
      "%",
    ]),
  ).resolves.toEqual(Array.from({ length: 5 }, () => ({ kind: "unknown" })));

  expect(saveRemoteMedia).not.toHaveBeenCalled();
});

it("times out inbound media downloads when response headers never arrive", async () => {
  const { saveRemoteMedia } = await import("openclaw/plugin-sdk/media-runtime");
  const headerTimeoutMs = 250;
  await withServer(
    () => {},
    async (baseUrl) => {
      const resources = createResources({
        client: { ...mediaClient, baseUrl, apiBaseUrl: `${baseUrl}/api/v4` },
        saveRemoteMedia: (params) =>
          saveRemoteMedia({
            ...params,
            responseHeaderTimeoutMs: headerTimeoutMs,
            readIdleTimeoutMs: 30_000,
            ssrfPolicy: { ...params.ssrfPolicy, dangerouslyAllowPrivateNetwork: true },
          }),
        mediaKindFromMime: (contentType) => (contentType ? "image" : null),
      });
      const started = Date.now();
      await expect(resources.resolveMattermostMedia(["file-stall"])).resolves.toEqual([
        { contentType: undefined, kind: "unknown" },
      ]);
      const elapsedMs = Date.now() - started;
      expect(elapsedMs).toBeGreaterThanOrEqual(headerTimeoutMs - 50);
      expect(elapsedMs).toBeLessThan(headerTimeoutMs + 2_000);
    },
  );
});

it("caches channel and user lookups and falls back to empty picker props", async () => {
  const channel = { id: "chan-1", name: "town-square" };
  const user = { id: "user-1", username: "alice" };
  fetchMattermostChannel.mockResolvedValue({ ...channel });
  fetchMattermostUser.mockResolvedValue({ ...user });
  buildButtonProps.mockReturnValue(undefined);

  const resources = createResources();

  await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual(channel);
  await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual(channel);
  await expect(resources.resolveUserInfo("user-1")).resolves.toEqual(user);
  await expect(resources.resolveUserInfo("user-1")).resolves.toEqual(user);

  expect(fetchMattermostChannel).toHaveBeenCalledTimes(1);
  expect(fetchMattermostUser).toHaveBeenCalledTimes(1);

  await resources.updateModelPickerPost({
    channelId: "chan-1",
    postId: "post-1",
    message: "Pick a model",
  });

  expect(updateMattermostPost).toHaveBeenCalledWith({}, "post-1", {
    message: "Pick a model",
    props: { attachments: [] },
  });
});

it("retries a failed user lookup on the next event instead of caching the failure", async () => {
  fetchMattermostUser
    .mockRejectedValueOnce(new Error("mattermost api unavailable"))
    .mockResolvedValueOnce({ id: "user-1" });
  const resources = createResources();
  await expect(resources.resolveUserInfo("user-1")).resolves.toBeNull();
  await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({ id: "user-1" });
  expect(fetchMattermostUser).toHaveBeenCalledTimes(2);
});

it("bounds the channel cache without refreshing insertion order on reads", async () => {
  fetchMattermostChannel.mockImplementation(async (_client, id: string) => ({ id }));
  const resources = createResources();
  const resolve = resources.resolveChannelInfo;

  for (let index = 0; index < 1000; index += 1) {
    await resolve(`channel-${index}`);
  }
  await resolve("channel-0");
  await resolve("channel-1000");
  await resolve("channel-0");
  await resolve("channel-1000");

  const requestedIds = fetchMattermostChannel.mock.calls.map((call) => call[1]);
  expect(requestedIds.filter((id) => id === "channel-0")).toHaveLength(2);
  expect(requestedIds.filter((id) => id === "channel-1000")).toHaveLength(1);
});

it("proxies typing indicators to the mattermost client helper", async () => {
  const client = {} as never;

  const resources = createResources({ client });

  await resources.sendTypingIndicator("chan-1", "root-1");
  expect(sendMattermostTyping).toHaveBeenCalledWith(client, {
    channelId: "chan-1",
    parentId: "root-1",
  });
});
