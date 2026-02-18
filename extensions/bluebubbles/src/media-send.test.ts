import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendBlueBubblesMedia } from "./media-send.js";
import { setBlueBubblesRuntime } from "./runtime.js";

const sendBlueBubblesAttachmentMock = vi.hoisted(() => vi.fn());
const sendMessageBlueBubblesMock = vi.hoisted(() => vi.fn());
const resolveBlueBubblesMessageIdMock = vi.hoisted(() => vi.fn((id: string) => id));

vi.mock("./attachments.js", () => ({
  sendBlueBubblesAttachment: sendBlueBubblesAttachmentMock,
}));

vi.mock("./send.js", () => ({
  sendMessageBlueBubbles: sendMessageBlueBubblesMock,
}));

vi.mock("./monitor.js", () => ({
  resolveBlueBubblesMessageId: resolveBlueBubblesMessageIdMock,
}));

type RuntimeMocks = {
  detectMime: ReturnType<typeof vi.fn>;
  fetchRemoteMedia: ReturnType<typeof vi.fn>;
};

let runtimeMocks: RuntimeMocks;
const tempDirs: string[] = [];

function createMockRuntime(): { runtime: PluginRuntime; mocks: RuntimeMocks } {
  const detectMime = vi.fn().mockResolvedValue("text/plain");
  const fetchRemoteMedia = vi.fn().mockResolvedValue({
    buffer: new Uint8Array([1, 2, 3]),
    contentType: "image/png",
    fileName: "remote.png",
  });
  return {
    runtime: {
      version: "1.0.0",
      media: {
        detectMime,
      },
      channel: {
        media: {
          fetchRemoteMedia,
        },
      },
    } as unknown as PluginRuntime,
    mocks: { detectMime, fetchRemoteMedia },
  };
}

function createConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      bluebubbles: {
        ...overrides,
      },
    },
  } as unknown as OpenClawConfig;
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-bb-media-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  const runtime = createMockRuntime();
  runtimeMocks = runtime.mocks;
  setBlueBubblesRuntime(runtime.runtime);
  sendBlueBubblesAttachmentMock.mockReset();
  sendBlueBubblesAttachmentMock.mockResolvedValue({ messageId: "msg-1" });
  sendMessageBlueBubblesMock.mockReset();
  sendMessageBlueBubblesMock.mockResolvedValue({ messageId: "msg-caption" });
  resolveBlueBubblesMessageIdMock.mockClear();
});

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("sendBlueBubblesMedia local-path hardening", () => {
  it("rejects local paths when mediaLocalRoots is not configured", async () => {
    await expect(
      sendBlueBubblesMedia({
        cfg: createConfig(),
        to: "chat:123",
        mediaPath: "/etc/passwd",
      }),
    ).rejects.toThrow(/mediaLocalRoots/i);

    expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
  });

  it("rejects local paths outside configured mediaLocalRoots", async () => {
    const allowedRoot = await makeTempDir();
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "outside.txt");
    await fs.writeFile(outsideFile, "not allowed", "utf8");

    await expect(
      sendBlueBubblesMedia({
        cfg: createConfig({ mediaLocalRoots: [allowedRoot] }),
        to: "chat:123",
        mediaPath: outsideFile,
      }),
    ).rejects.toThrow(/not under any configured mediaLocalRoots/i);

    expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
  });

  it("allows local paths that are explicitly configured", async () => {
    const allowedRoot = await makeTempDir();
    const allowedFile = path.join(allowedRoot, "allowed.txt");
    await fs.writeFile(allowedFile, "allowed", "utf8");

    const result = await sendBlueBubblesMedia({
      cfg: createConfig({ mediaLocalRoots: [allowedRoot] }),
      to: "chat:123",
      mediaPath: allowedFile,
    });

    expect(result).toEqual({ messageId: "msg-1" });
    expect(sendBlueBubblesAttachmentMock).toHaveBeenCalledTimes(1);
    expect(sendBlueBubblesAttachmentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        filename: "allowed.txt",
        contentType: "text/plain",
      }),
    );
    expect(runtimeMocks.detectMime).toHaveBeenCalled();
  });

  it("allows file:// media paths and file:// local roots", async () => {
    const allowedRoot = await makeTempDir();
    const allowedFile = path.join(allowedRoot, "allowed.txt");
    await fs.writeFile(allowedFile, "allowed", "utf8");

    const result = await sendBlueBubblesMedia({
      cfg: createConfig({ mediaLocalRoots: [pathToFileURL(allowedRoot).toString()] }),
      to: "chat:123",
      mediaPath: pathToFileURL(allowedFile).toString(),
    });

    expect(result).toEqual({ messageId: "msg-1" });
    expect(sendBlueBubblesAttachmentMock).toHaveBeenCalledTimes(1);
    expect(sendBlueBubblesAttachmentMock.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        filename: "allowed.txt",
      }),
    );
  });

  it("uses account-specific mediaLocalRoots over top-level roots", async () => {
    const baseRoot = await makeTempDir();
    const accountRoot = await makeTempDir();
    const baseFile = path.join(baseRoot, "base.txt");
    const accountFile = path.join(accountRoot, "account.txt");
    await fs.writeFile(baseFile, "base", "utf8");
    await fs.writeFile(accountFile, "account", "utf8");

    const cfg = createConfig({
      mediaLocalRoots: [baseRoot],
      accounts: {
        work: {
          mediaLocalRoots: [accountRoot],
        },
      },
    });

    await expect(
      sendBlueBubblesMedia({
        cfg,
        to: "chat:123",
        accountId: "work",
        mediaPath: baseFile,
      }),
    ).rejects.toThrow(/not under any configured mediaLocalRoots/i);

    const result = await sendBlueBubblesMedia({
      cfg,
      to: "chat:123",
      accountId: "work",
      mediaPath: accountFile,
    });

    expect(result).toEqual({ messageId: "msg-1" });
  });

  it("rejects symlink escapes under an allowed root", async () => {
    const allowedRoot = await makeTempDir();
    const outsideDir = await makeTempDir();
    const outsideFile = path.join(outsideDir, "secret.txt");
    const linkPath = path.join(allowedRoot, "link.txt");
    await fs.writeFile(outsideFile, "secret", "utf8");

    try {
      await fs.symlink(outsideFile, linkPath);
    } catch {
      // Some environments disallow symlink creation; skip without failing the suite.
      return;
    }

    await expect(
      sendBlueBubblesMedia({
        cfg: createConfig({ mediaLocalRoots: [allowedRoot] }),
        to: "chat:123",
        mediaPath: linkPath,
      }),
    ).rejects.toThrow(/not under any configured mediaLocalRoots/i);

    expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
  });

  it("rejects relative mediaLocalRoots entries", async () => {
    const allowedRoot = await makeTempDir();
    const allowedFile = path.join(allowedRoot, "allowed.txt");
    const relativeRoot = path.relative(process.cwd(), allowedRoot);
    await fs.writeFile(allowedFile, "allowed", "utf8");

    await expect(
      sendBlueBubblesMedia({
        cfg: createConfig({ mediaLocalRoots: [relativeRoot] }),
        to: "chat:123",
        mediaPath: allowedFile,
      }),
    ).rejects.toThrow(/must be absolute paths/i);

    expect(sendBlueBubblesAttachmentMock).not.toHaveBeenCalled();
  });

  it("keeps remote URL flow unchanged", async () => {
    await sendBlueBubblesMedia({
      cfg: createConfig(),
      to: "chat:123",
      mediaUrl: "https://example.com/file.png",
    });

    expect(runtimeMocks.fetchRemoteMedia).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://example.com/file.png" }),
    );
    expect(sendBlueBubblesAttachmentMock).toHaveBeenCalledTimes(1);
  });
});
