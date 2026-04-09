import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveQQBotLocalMediaPath, resolveQQBotPayloadLocalFilePath } from "./platform.js";

describe("qqbot local media path remapping", () => {
  const createdPaths: string[] = [];
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  function createStateRoot() {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-state-"));
    process.env.OPENCLAW_STATE_DIR = stateRoot;
    createdPaths.push(stateRoot);
    return stateRoot;
  }

  function createOpenClawTestRoot() {
    const stateRoot = createStateRoot();
    const testRoot = fs.mkdtempSync(path.join(stateRoot, "qqbot-platform-test-"));
    return { stateRoot, testRootName: path.basename(testRoot) };
  }

  function createQqbotMediaFile(fileName: string) {
    const { stateRoot, testRootName } = createOpenClawTestRoot();
    const mediaFile = path.join(stateRoot, "media", "qqbot", "downloads", testRootName, fileName);
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));
    return { stateRoot, testRootName, mediaFile };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("remaps missing workspace media paths to the real media directory", () => {
    const { stateRoot, testRootName, mediaFile } = createQqbotMediaFile("example.png");

    const missingWorkspacePath = path.join(
      stateRoot,
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
    const stateRoot = createStateRoot();
    const escapedPath = path.join(stateRoot, "media", "qqbot", "..", "..", "qqbot-escape.txt");

    expect(resolveQQBotPayloadLocalFilePath(escapedPath)).toBeNull();
  });

  it("allows structured payload files inside the QQ Bot media directory", () => {
    const { mediaFile } = createQqbotMediaFile("allowed.png");

    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(mediaFile);
  });

  it("blocks structured payload files inside the QQ Bot data directory", () => {
    const { stateRoot, testRootName } = createOpenClawTestRoot();

    const dataFile = path.join(stateRoot, "qqbot", "sessions", testRootName, "session.json");
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, "{}", "utf8");
    createdPaths.push(path.dirname(dataFile));

    expect(resolveQQBotPayloadLocalFilePath(dataFile)).toBeNull();
  });

  it("allows legacy workspace paths when they remap into QQ Bot media storage", () => {
    const { stateRoot, testRootName, mediaFile } = createQqbotMediaFile("legacy.png");

    const missingWorkspacePath = path.join(
      stateRoot,
      "workspace",
      "qqbot",
      "downloads",
      testRootName,
      "legacy.png",
    );

    expect(resolveQQBotPayloadLocalFilePath(missingWorkspacePath)).toBe(mediaFile);
  });

  it("uses OPENCLAW_STATE_DIR for QQ Bot storage roots", () => {
    const stateRoot = createStateRoot();

    const mediaFile = path.join(stateRoot, "media", "qqbot", "downloads", "override.png");
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));

    const missingWorkspacePath = path.join(
      stateRoot,
      "workspace",
      "qqbot",
      "downloads",
      "override.png",
    );

    expect(resolveQQBotLocalMediaPath(missingWorkspacePath)).toBe(mediaFile);
  });
});
