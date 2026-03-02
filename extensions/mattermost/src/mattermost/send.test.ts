import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import type { MattermostSendOpts } from "./send.js";

const uploadMattermostFile = vi.fn();
const createMattermostPost = vi.fn();
const createMattermostClient = vi.fn(() => "mock-client");
const normalizeMattermostBaseUrl = vi.fn((url: string) => url);
const loadWebMedia = vi.fn();

vi.mock("./client.js", () => ({
  createMattermostClient: (...args: unknown[]) => createMattermostClient(...args),
  normalizeMattermostBaseUrl: (url: string) => normalizeMattermostBaseUrl(url),
  uploadMattermostFile: (...args: unknown[]) => uploadMattermostFile(...args),
  fetchMattermostMe: vi.fn(),
  fetchMattermostUserByUsername: vi.fn(),
  createMattermostDirectChannel: vi.fn(),
  createMattermostPost: (...args: unknown[]) => createMattermostPost(...args),
}));

vi.mock("./accounts.js", () => ({
  resolveMattermostAccount: () => ({
    accountId: "default",
    botToken: "test-bot-token",
    baseUrl: "https://chat.example.com",
    enabled: true,
    config: {},
  }),
}));

describe("sendMessageMattermost", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    setMattermostRuntime({
      media: {
        loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
      },
      config: {
        loadConfig: () => ({
          channels: {
            mattermost: {
              enabled: true,
              botToken: "test-bot-token",
              baseUrl: "https://chat.example.com",
            },
          },
        }),
      },
      logging: {
        getChildLogger: () => ({ debug: vi.fn() }),
        shouldLogVerbose: () => false,
      },
      channel: {
        text: {
          resolveMarkdownTableMode: () => "text",
          convertMarkdownTables: (text: string) => text,
        },
        activity: {
          record: vi.fn(),
        },
      },
    } as any);
  });

  it("passes mediaLocalRoots to loadWebMedia", async () => {
    const mediaLocalRoots = ["/home/user/.openclaw/workspace-server"];
    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/png",
      fileName: "screenshot.png",
    });
    uploadMattermostFile.mockResolvedValueOnce({ id: "file-1" });
    createMattermostPost.mockResolvedValueOnce({ id: "post-1" });

    const { sendMessageMattermost } = await import("./send.js");
    await sendMessageMattermost("channel:general", "check this", {
      mediaUrl: "/home/user/.openclaw/workspace-server/screenshot.png",
      mediaLocalRoots,
    } satisfies MattermostSendOpts);

    expect(loadWebMedia).toHaveBeenCalledWith(
      "/home/user/.openclaw/workspace-server/screenshot.png",
      { localRoots: mediaLocalRoots },
    );
  });

  it("calls loadWebMedia without localRoots when mediaLocalRoots is omitted", async () => {
    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("img"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });
    uploadMattermostFile.mockResolvedValueOnce({ id: "file-2" });
    createMattermostPost.mockResolvedValueOnce({ id: "post-2" });

    const { sendMessageMattermost } = await import("./send.js");
    await sendMessageMattermost("channel:general", "photo", {
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(loadWebMedia).toHaveBeenCalledWith("https://example.com/photo.jpg", {
      localRoots: undefined,
    });
  });
});
