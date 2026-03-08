import type { OpenClawConfig } from "openclaw/plugin-sdk/googlechat";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleChatAccount } from "./accounts.js";
import { googlechatMessageActions } from "./actions.js";
import { sendGoogleChatMessage, uploadGoogleChatAttachment } from "./api.js";
import { resolveGoogleChatOutboundSpace } from "./targets.js";

const runtimeMocks = vi.hoisted(() => ({
  fetchRemoteMedia: vi.fn(),
  loadWebMedia: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/googlechat", () => ({
  createActionGate: vi.fn(() => () => true),
  extractToolSend: vi.fn(),
  jsonResult: (value: unknown) => value,
  readNumberParam: vi.fn(),
  readReactionParams: vi.fn(),
  readStringParam: (
    params: Record<string, unknown>,
    key: string,
    options?: { required?: boolean; trim?: boolean; allowEmpty?: boolean },
  ) => {
    const raw = params[key];
    if (typeof raw !== "string") {
      if (options?.required) {
        throw new Error(`${key} is required`);
      }
      return undefined;
    }
    const value = options?.trim === false ? raw : raw.trim();
    if (!options?.allowEmpty && value.length === 0) {
      if (options?.required) {
        throw new Error(`${key} is required`);
      }
      return undefined;
    }
    return value;
  },
}));

vi.mock("./accounts.js", () => ({
  listEnabledGoogleChatAccounts: vi.fn(),
  resolveGoogleChatAccount: vi.fn(),
}));

vi.mock("./api.js", () => ({
  createGoogleChatReaction: vi.fn(),
  deleteGoogleChatReaction: vi.fn(),
  listGoogleChatReactions: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  uploadGoogleChatAttachment: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime: vi.fn(() => ({
    channel: {
      media: { fetchRemoteMedia: runtimeMocks.fetchRemoteMedia },
    },
    media: {
      loadWebMedia: runtimeMocks.loadWebMedia,
    },
  })),
}));

vi.mock("./targets.js", () => ({
  resolveGoogleChatOutboundSpace: vi.fn(),
}));

describe("googlechatMessageActions", () => {
  const handleAction = googlechatMessageActions.handleAction!;

  const cfg = {
    channels: {
      googlechat: {
        serviceAccount: { type: "service_account" },
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveGoogleChatAccount).mockReturnValue({
      accountId: "default",
      config: { mediaMaxMb: 20 },
      credentialSource: "inline",
    } as never);
    vi.mocked(resolveGoogleChatOutboundSpace).mockResolvedValue("spaces/AAA");
    vi.mocked(uploadGoogleChatAttachment).mockResolvedValue({
      attachmentUploadToken: "upload-token",
    } as never);
    vi.mocked(sendGoogleChatMessage).mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    } as never);
  });

  it("loads local media with mediaLocalRoots for send actions", async () => {
    runtimeMocks.loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("file-bytes"),
      fileName: "test.md",
      contentType: "text/markdown",
    });

    const result = await handleAction({
      channel: "googlechat",
      action: "send",
      cfg,
      accountId: "default",
      mediaLocalRoots: ["/tmp/workspace"],
      params: {
        to: "spaces/AAA",
        message: "hello",
        media: "/tmp/workspace/test.md",
      },
    });

    expect(runtimeMocks.loadWebMedia).toHaveBeenCalledWith("/tmp/workspace/test.md", {
      maxBytes: 20 * 1024 * 1024,
      localRoots: ["/tmp/workspace"],
    });
    expect(runtimeMocks.fetchRemoteMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachment).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "test.md",
        contentType: "text/markdown",
        buffer: Buffer.from("file-bytes"),
      }),
    );
    expect(sendGoogleChatMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "hello",
        attachments: [{ attachmentUploadToken: "upload-token", contentName: "test.md" }],
      }),
    );
    expect(result).toMatchObject({ ok: true, to: "spaces/AAA" });
  });

  it("keeps remote URL sends on fetchRemoteMedia", async () => {
    runtimeMocks.fetchRemoteMedia.mockResolvedValueOnce({
      buffer: Buffer.from("remote-bytes"),
      fileName: "remote.png",
      contentType: "image/png",
    });

    await handleAction({
      channel: "googlechat",
      action: "send",
      cfg,
      accountId: "default",
      params: {
        to: "spaces/AAA",
        message: "hello",
        media: "https://example.com/remote.png",
      },
    });

    expect(runtimeMocks.fetchRemoteMedia).toHaveBeenCalledWith({
      url: "https://example.com/remote.png",
      maxBytes: 20 * 1024 * 1024,
    });
    expect(runtimeMocks.loadWebMedia).not.toHaveBeenCalled();
  });
});
