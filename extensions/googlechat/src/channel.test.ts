import { describe, expect, it, vi } from "vitest";
import {
  createDirectoryTestRuntime,
  expectDirectorySurface,
} from "../../../test/helpers/extensions/directory.ts";
import type { OpenClawConfig, PluginRuntime } from "../runtime-api.js";

const uploadGoogleChatAttachmentMock = vi.hoisted(() => vi.fn());
const sendGoogleChatMessageMock = vi.hoisted(() => vi.fn());

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    sendGoogleChatMessage: sendGoogleChatMessageMock,
    uploadGoogleChatAttachment: uploadGoogleChatAttachmentMock,
  };
});

import { googlechatPlugin } from "./channel.js";
import { setGoogleChatRuntime } from "./runtime.js";

function createGoogleChatCfg(): OpenClawConfig {
  return {
    channels: {
      googlechat: {
        enabled: true,
        serviceAccount: {
          type: "service_account",
          client_email: "bot@example.com",
          private_key: "test-key", // pragma: allowlist secret
          token_uri: "https://oauth2.googleapis.com/token",
        },
      },
    },
  };
}

function setupRuntimeMediaMocks(params: { loadFileName: string; loadBytes: string }) {
  const loadWebMedia = vi.fn(async () => ({
    buffer: Buffer.from(params.loadBytes),
    fileName: params.loadFileName,
    contentType: "image/png",
  }));
  const fetchRemoteMedia = vi.fn(async () => ({
    buffer: Buffer.from("remote-bytes"),
    fileName: "remote.png",
    contentType: "image/png",
  }));

  setGoogleChatRuntime({
    media: { loadWebMedia },
    channel: {
      media: { fetchRemoteMedia },
      text: { chunkMarkdownText: (text: string) => [text] },
    },
  } as unknown as PluginRuntime);

  return { loadWebMedia, fetchRemoteMedia };
}

describe("googlechatPlugin outbound sendMedia", () => {
  it("loads local media with mediaLocalRoots via runtime media loader", async () => {
    const { loadWebMedia, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadFileName: "image.png",
      loadBytes: "image-bytes",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-1",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-1",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatPlugin.outbound?.sendMedia?.({
      cfg,
      to: "spaces/AAA",
      text: "caption",
      mediaUrl: "/tmp/workspace/image.png",
      mediaLocalRoots: ["/tmp/workspace"],
      accountId: "default",
    });

    expect(loadWebMedia).toHaveBeenCalledWith(
      "/tmp/workspace/image.png",
      expect.objectContaining({
        localRoots: ["/tmp/workspace"],
      }),
    );
    expect(fetchRemoteMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        filename: "image.png",
        contentType: "image/png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toEqual({
      channel: "googlechat",
      messageId: "spaces/AAA/messages/msg-1",
      chatId: "spaces/AAA",
    });
  });

  it("keeps remote URL media fetch on fetchRemoteMedia with maxBytes cap", async () => {
    const { loadWebMedia, fetchRemoteMedia } = setupRuntimeMediaMocks({
      loadFileName: "unused.png",
      loadBytes: "should-not-be-used",
    });

    uploadGoogleChatAttachmentMock.mockResolvedValue({
      attachmentUploadToken: "token-2",
    });
    sendGoogleChatMessageMock.mockResolvedValue({
      messageName: "spaces/AAA/messages/msg-2",
    });

    const cfg = createGoogleChatCfg();

    const result = await googlechatPlugin.outbound?.sendMedia?.({
      cfg,
      to: "spaces/AAA",
      text: "caption",
      mediaUrl: "https://example.com/image.png",
      accountId: "default",
    });

    expect(fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com/image.png",
        maxBytes: 20 * 1024 * 1024,
      }),
    );
    expect(loadWebMedia).not.toHaveBeenCalled();
    expect(uploadGoogleChatAttachmentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        filename: "remote.png",
        contentType: "image/png",
      }),
    );
    expect(sendGoogleChatMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        space: "spaces/AAA",
        text: "caption",
      }),
    );
    expect(result).toEqual({
      channel: "googlechat",
      messageId: "spaces/AAA/messages/msg-2",
      chatId: "spaces/AAA",
    });
  });
});

describe("googlechat directory", () => {
  const runtimeEnv = createDirectoryTestRuntime() as never;

  it("lists peers and groups from config", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: { allowFrom: ["users/alice", "googlechat:bob"] },
          groups: {
            "spaces/AAA": {},
            "spaces/BBB": {},
          },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "users/alice" },
        { kind: "user", id: "bob" },
      ]),
    );

    await expect(
      directory.listGroups({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "group", id: "spaces/AAA" },
        { kind: "group", id: "spaces/BBB" },
      ]),
    );
  });

  it("normalizes spaced provider-prefixed dm allowlist entries", async () => {
    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: { allowFrom: [" users/alice ", " googlechat:user:Bob@Example.com "] },
        },
      },
    } as unknown as OpenClawConfig;

    const directory = expectDirectorySurface(googlechatPlugin.directory);

    await expect(
      directory.listPeers({
        cfg,
        accountId: undefined,
        query: undefined,
        limit: undefined,
        runtime: runtimeEnv,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { kind: "user", id: "users/alice" },
        { kind: "user", id: "users/bob@example.com" },
      ]),
    );
  });
});

describe("googlechatPlugin security", () => {
  it("normalizes prefixed DM allowlist entries to lowercase user ids", () => {
    const security = googlechatPlugin.security;
    if (!security) {
      throw new Error("googlechat security unavailable");
    }
    const resolveDmPolicy = security.resolveDmPolicy;
    const normalizeAllowEntry = googlechatPlugin.pairing?.normalizeAllowEntry;
    expect(resolveDmPolicy).toBeTypeOf("function");
    expect(normalizeAllowEntry).toBeTypeOf("function");

    const cfg = {
      channels: {
        googlechat: {
          serviceAccount: { client_email: "bot@example.com" },
          dm: {
            policy: "allowlist",
            allowFrom: ["  googlechat:user:Bob@Example.com  "],
          },
        },
      },
    } as OpenClawConfig;

    const account = googlechatPlugin.config.resolveAccount(cfg, "default");
    const resolved = resolveDmPolicy!({ cfg, account });
    if (!resolved) {
      throw new Error("googlechat resolveDmPolicy returned null");
    }

    expect(resolved.policy).toBe("allowlist");
    expect(resolved.allowFrom).toEqual(["  googlechat:user:Bob@Example.com  "]);
    expect(resolved.normalizeEntry?.("  googlechat:user:Bob@Example.com  ")).toBe(
      "bob@example.com",
    );
    expect(normalizeAllowEntry!("  users/Alice@Example.com  ")).toBe("alice@example.com");
  });
});
