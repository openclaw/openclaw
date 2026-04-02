import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMattermostChannel = vi.hoisted(() => vi.fn());
const fetchMattermostPost = vi.hoisted(() => vi.fn());
const fetchMattermostUser = vi.hoisted(() => vi.fn());
const sendMattermostTyping = vi.hoisted(() => vi.fn());
const updateMattermostPost = vi.hoisted(() => vi.fn());
const buildButtonProps = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  fetchMattermostChannel,
  fetchMattermostPost,
  fetchMattermostUser,
  sendMattermostTyping,
  updateMattermostPost,
}));

vi.mock("./interactions.js", () => ({
  buildButtonProps,
}));

const defaultResourceParams = {
  accountId: "default",
  callbackUrl: "https://openclaw.test/callback",
  client: {} as never,
  logger: {},
  mediaMaxBytes: 1024,
  fetchRemoteMedia: vi.fn(),
  saveMediaBuffer: vi.fn(),
  mediaKindFromMime: () => "document" as const,
};

describe("mattermost monitor resources", () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMattermostChannel.mockReset();
    fetchMattermostPost.mockReset();
    fetchMattermostUser.mockReset();
    sendMattermostTyping.mockReset();
    updateMattermostPost.mockReset();
    buildButtonProps.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("downloads media, preserves auth headers, and infers media kind", async () => {
    const fetchRemoteMedia = vi.fn(async () => ({
      buffer: new Uint8Array([1, 2, 3]),
      contentType: "image/png",
    }));
    const saveMediaBuffer = vi.fn(async () => ({
      path: "/tmp/file.png",
      contentType: "image/png",
    }));
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({
      ...defaultResourceParams,
      client: {
        apiBaseUrl: "https://chat.example.com/api/v4",
        baseUrl: "https://chat.example.com",
        token: "bot-token",
      } as never,
      fetchRemoteMedia,
      saveMediaBuffer,
      mediaKindFromMime: () => "image",
    });

    await expect(resources.resolveMattermostMedia([" file-1 "])).resolves.toEqual([
      {
        path: "/tmp/file.png",
        contentType: "image/png",
        kind: "image",
      },
    ]);

    expect(fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://chat.example.com/api/v4/files/file-1",
      requestInit: {
        headers: {
          Authorization: "Bearer bot-token",
        },
      },
      filePathHint: "file-1",
      maxBytes: 1024,
      ssrfPolicy: { allowedHostnames: ["chat.example.com"] },
    });
  });

  it("caches channel and user lookups and falls back to empty picker props", async () => {
    fetchMattermostChannel.mockResolvedValue({ id: "chan-1", name: "town-square" });
    fetchMattermostUser.mockResolvedValue({ id: "user-1", username: "alice" });
    buildButtonProps.mockReturnValue(undefined);
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({ ...defaultResourceParams });

    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "town-square",
    });
    await expect(resources.resolveChannelInfo("chan-1")).resolves.toEqual({
      id: "chan-1",
      name: "town-square",
    });
    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "alice",
    });
    await expect(resources.resolveUserInfo("user-1")).resolves.toEqual({
      id: "user-1",
      username: "alice",
    });

    expect(fetchMattermostChannel).toHaveBeenCalledTimes(1);
    expect(fetchMattermostUser).toHaveBeenCalledTimes(1);

    await resources.updateModelPickerPost({
      channelId: "chan-1",
      postId: "post-1",
      message: "Pick a model",
    });

    expect(updateMattermostPost).toHaveBeenCalledWith(
      {},
      "post-1",
      expect.objectContaining({
        message: "Pick a model",
        props: { attachments: [] },
      }),
    );
  });

  // These tests use fake timers to control `node:timers/promises` sleep().
  // vi.advanceTimersByTimeAsync must advance past each delay in the retry
  // sequence (500ms, then 1500ms) for the promise to resolve.

  it("refetchPostFileIds returns file_ids on first retry when REST has them", async () => {
    fetchMattermostPost.mockResolvedValue({
      id: "post-1",
      file_ids: ["f1", "f2"],
      message: "hello",
    });
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({ ...defaultResourceParams });

    const promise = resources.refetchPostFileIds("post-1");
    // first attempt fires at 500ms
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual(["f1", "f2"]);
    expect(fetchMattermostPost).toHaveBeenCalledTimes(1);
  });

  it("refetchPostFileIds retries when first attempt returns empty file_ids", async () => {
    fetchMattermostPost
      .mockResolvedValueOnce({ id: "post-1", file_ids: [], message: "hello" })
      .mockResolvedValueOnce({ id: "post-1", file_ids: ["f1"], message: "hello" });
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({ ...defaultResourceParams });

    const promise = resources.refetchPostFileIds("post-1");
    // first attempt at 500ms returns empty, second at 500+1500=2000ms
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual(["f1"]);
    expect(fetchMattermostPost).toHaveBeenCalledTimes(2);
  });

  it("refetchPostFileIds continues retrying after transient REST errors", async () => {
    fetchMattermostPost
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ id: "post-1", file_ids: ["f1"], message: "hello" });
    const debugSpy = vi.fn();
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({
      ...defaultResourceParams,
      logger: { debug: debugSpy },
    });

    const promise = resources.refetchPostFileIds("post-1");
    // first attempt at 500ms fails, second at 500+1500=2000ms succeeds
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual(["f1"]);
    expect(debugSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to re-fetch post post-1"),
    );
    expect(fetchMattermostPost).toHaveBeenCalledTimes(2);
  });

  it("refetchPostFileIds returns empty array when all retries fail", async () => {
    fetchMattermostPost.mockRejectedValue(new Error("network error"));
    const debugSpy = vi.fn();
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({
      ...defaultResourceParams,
      logger: { debug: debugSpy },
    });

    const promise = resources.refetchPostFileIds("post-1");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual([]);
    expect(debugSpy).toHaveBeenCalledTimes(2);
  });

  it("refetchPostFileIds returns empty array after all retries exhausted", async () => {
    fetchMattermostPost.mockResolvedValue({
      id: "post-1",
      file_ids: null,
      message: "text only",
    });
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({ ...defaultResourceParams });

    const promise = resources.refetchPostFileIds("post-1");
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toEqual([]);
    expect(fetchMattermostPost).toHaveBeenCalledTimes(2);
  });

  it("proxies typing indicators to the mattermost client helper", async () => {
    const client = {} as never;
    const { createMattermostMonitorResources } = await import("./monitor-resources.js");

    const resources = createMattermostMonitorResources({
      ...defaultResourceParams,
      client,
    });

    await resources.sendTypingIndicator("chan-1", "root-1");
    expect(sendMattermostTyping).toHaveBeenCalledWith(client, {
      channelId: "chan-1",
      parentId: "root-1",
    });
  });
});
