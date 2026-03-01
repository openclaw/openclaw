import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setMattermostRuntime } from "../runtime.js";
import { sendMessageMattermost } from "./send.js";

const clientMocks = vi.hoisted(() => ({
  createMattermostClient: vi.fn(() => ({ request: vi.fn() })),
  createMattermostDirectChannel: vi.fn(async () => ({ id: "dm-1" })),
  createMattermostPost: vi.fn(async () => ({ id: "post-1" })),
  fetchMattermostMe: vi.fn(async () => ({ id: "bot-1" })),
  fetchMattermostUserByUsername: vi.fn(async () => ({ id: "user-1" })),
  normalizeMattermostBaseUrl: vi.fn((value: string | undefined) => value?.trim() || undefined),
  uploadMattermostFile: vi.fn(async () => ({ id: "file-1" })),
}));
const loadWebMedia = vi.fn(async () => ({
  buffer: Buffer.from("img"),
  contentType: "image/png",
  fileName: "image.png",
}));

vi.mock("./client.js", () => ({
  createMattermostClient: clientMocks.createMattermostClient,
  createMattermostDirectChannel: clientMocks.createMattermostDirectChannel,
  createMattermostPost: clientMocks.createMattermostPost,
  fetchMattermostMe: clientMocks.fetchMattermostMe,
  fetchMattermostUserByUsername: clientMocks.fetchMattermostUserByUsername,
  normalizeMattermostBaseUrl: clientMocks.normalizeMattermostBaseUrl,
  uploadMattermostFile: clientMocks.uploadMattermostFile,
}));

const { createMattermostPost, uploadMattermostFile } = clientMocks;

describe("sendMessageMattermost media local roots", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          enabled: true,
          botToken: "cfg-token",
          baseUrl: "https://chat.example.com",
        },
      },
    };

    setMattermostRuntime({
      config: {
        loadConfig: () => cfg,
      },
      logging: {
        getChildLogger: () => ({ debug: vi.fn() }),
        shouldLogVerbose: () => false,
      },
      media: {
        loadWebMedia,
      },
      channel: {
        text: {
          resolveMarkdownTableMode: () => "off",
          convertMarkdownTables: (message: string) => message,
        },
        activity: {
          record: vi.fn(),
        },
      },
    } as unknown as PluginRuntime);
  });

  it("passes mediaLocalRoots into loadWebMedia", async () => {
    await sendMessageMattermost("channel:ch-123", "hello", {
      mediaUrl: "/tmp/workspace-agent/image.png",
      mediaLocalRoots: ["/tmp/workspace-agent"],
    });

    expect(loadWebMedia).toHaveBeenCalledWith("/tmp/workspace-agent/image.png", {
      localRoots: ["/tmp/workspace-agent"],
    });
    expect(uploadMattermostFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: "ch-123",
      }),
    );

    expect(createMattermostPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        channelId: "ch-123",
        fileIds: ["file-1"],
      }),
    );
  });
});
