import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getHomeDir,
  getQQBotDataDir,
  getQQBotDataPath,
  resolveQQBotLocalMediaPath,
  resolveQQBotPayloadLocalFilePath,
} from "./platform.js";

describe("QQBot data directory with QQBOT_DATA_DIR", () => {
  const createdPaths: string[] = [];
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.QQBOT_DATA_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDataDir === undefined) {
      delete process.env.QQBOT_DATA_DIR;
    } else {
      process.env.QQBOT_DATA_DIR = originalDataDir;
    }
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("uses QQBOT_DATA_DIR when set", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-data-"));
    createdPaths.push(customDir);
    process.env.QQBOT_DATA_DIR = customDir;

    const dataDir = getQQBotDataDir();
    expect(dataDir).toBe(customDir);
    expect(fs.existsSync(dataDir)).toBe(true);
  });

  it("uses QQBOT_DATA_DIR with subpaths", () => {
    const customDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-custom-data-"));
    createdPaths.push(customDir);
    process.env.QQBOT_DATA_DIR = customDir;

    const sessionsDir = getQQBotDataDir("sessions", "test");
    expect(sessionsDir).toBe(path.join(customDir, "sessions", "test"));
    expect(fs.existsSync(sessionsDir)).toBe(true);
  });

  it("falls back to ~/.openclaw/qqbot when QQBOT_DATA_DIR is not set", () => {
    delete process.env.QQBOT_DATA_DIR;
    const homeDir = getHomeDir();
    const expectedDir = path.join(homeDir, ".openclaw", "qqbot");

    const dataDir = getQQBotDataDir();
    expect(dataDir).toBe(expectedDir);
  });

  it("expands tilde in QQBOT_DATA_DIR", () => {
    const homeDir = getHomeDir();
    const customDir = path.join(homeDir, "custom-qqbot-data");
    process.env.QQBOT_DATA_DIR = "~/custom-qqbot-data";

    const dataDir = getQQBotDataPath();
    expect(dataDir).toBe(customDir);
  });

  it("returns path without creating when using getQQBotDataPath", () => {
    const customDir = path.join(os.tmpdir(), "qqbot-not-created-yet");
    process.env.QQBOT_DATA_DIR = customDir;

    const dataPath = getQQBotDataPath("not-created", "subdir");
    expect(dataPath).toBe(path.join(customDir, "not-created", "subdir"));
    expect(fs.existsSync(dataPath)).toBe(false);
  });
});

describe("qqbot local media path remapping", () => {
  const createdPaths: string[] = [];

  function createOpenClawTestRoot() {
    const actualHome = getHomeDir();
    const openclawDir = path.join(actualHome, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const testRoot = fs.mkdtempSync(path.join(openclawDir, "qqbot-platform-test-"));
    createdPaths.push(testRoot);
    return { actualHome, testRootName: path.basename(testRoot) };
  }

  function createQqbotMediaFile(fileName: string) {
    const { actualHome, testRootName } = createOpenClawTestRoot();
    const mediaFile = path.join(
      actualHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      testRootName,
      fileName,
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));
    return { actualHome, testRootName, mediaFile };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("remaps missing workspace media paths to the real media directory", () => {
    const { actualHome, testRootName, mediaFile } = createQqbotMediaFile("example.png");

    const missingWorkspacePath = path.join(
      actualHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      testRootName,
      "example.png",
    );

    expect(resolveQQBotLocalMediaPath(missingWorkspacePath)).toBe(mediaFile);
  });

  it("leaves existing media paths unchanged", () => {
    const { mediaFile } = createQqbotMediaFile("existing.png");

    expect(resolveQQBotLocalMediaPath(mediaFile)).toBe(mediaFile);
  });

  it("blocks structured payload files outside QQ Bot storage", () => {
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-platform-outside-"));
    createdPaths.push(outsideRoot);

    const outsideFile = path.join(outsideRoot, "secret.txt");
    fs.writeFileSync(outsideFile, "secret", "utf8");

    expect(resolveQQBotPayloadLocalFilePath(outsideFile)).toBeNull();
  });

  it("blocks structured payload paths that escape QQ Bot media via '..'", () => {
    const escapedPath = path.join(
      getHomeDir(),
      ".openclaw",
      "media",
      "qqbot",
      "..",
      "..",
      "qqbot-escape.txt",
    );

    expect(resolveQQBotPayloadLocalFilePath(escapedPath)).toBeNull();
  });

  it("allows structured payload files inside the QQ Bot media directory", () => {
    const { mediaFile } = createQqbotMediaFile("allowed.png");

    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(fs.realpathSync(mediaFile));
  });

  it("allows structured payload files inside sibling OpenClaw media subdirectories", () => {
    // Core helpers such as `saveMediaBuffer(..., "outbound", ...)` place framework
    // attachments under sibling directories of `media/qqbot/`. The plugin must
    // trust the shared `~/.openclaw/media` root so auto-routed sends can access
    // those files without the path-outside-storage guard firing.
    const actualHome = getHomeDir();
    const outboundDir = path.join(actualHome, ".openclaw", "media", "outbound");
    fs.mkdirSync(outboundDir, { recursive: true });
    const outboundFile = fs.mkdtempSync(path.join(outboundDir, "qqbot-outbound-"));
    const mediaFile = path.join(outboundFile, "tts.mp3");
    fs.writeFileSync(mediaFile, "audio", "utf8");
    createdPaths.push(outboundFile);

    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(fs.realpathSync(mediaFile));
  });

  it("blocks structured payload files inside the QQ Bot data directory", () => {
    const { actualHome, testRootName } = createOpenClawTestRoot();

    const dataFile = path.join(
      actualHome,
      ".openclaw",
      "qqbot",
      "sessions",
      testRootName,
      "session.json",
    );
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, "{}", "utf8");
    createdPaths.push(path.dirname(dataFile));

    expect(resolveQQBotPayloadLocalFilePath(dataFile)).toBeNull();
  });

  it("allows legacy workspace paths when they remap into QQ Bot media storage", () => {
    const { actualHome, testRootName, mediaFile } = createQqbotMediaFile("legacy.png");

    const missingWorkspacePath = path.join(
      actualHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      testRootName,
      "legacy.png",
    );

    expect(resolveQQBotPayloadLocalFilePath(missingWorkspacePath)).toBe(fs.realpathSync(mediaFile));
  });
});
