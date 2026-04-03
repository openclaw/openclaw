import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getHomeDir,
  resolveQQBotLocalMediaPath,
  resolveQQBotPayloadLocalFilePath,
} from "./platform.js";

describe("qqbot local media path remapping", () => {
  const createdPaths: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const target of createdPaths.splice(0)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it("remaps missing workspace media paths to the real media directory", () => {
    const actualHome = getHomeDir();
    const openclawDir = path.join(actualHome, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const testRoot = fs.mkdtempSync(path.join(openclawDir, "qqbot-platform-test-"));
    createdPaths.push(testRoot);

    const mediaFile = path.join(
      actualHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      path.basename(testRoot),
      "example.png",
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));

    const missingWorkspacePath = path.join(
      actualHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      path.basename(testRoot),
      "example.png",
    );

    expect(resolveQQBotLocalMediaPath(missingWorkspacePath)).toBe(mediaFile);
  });

  it("leaves existing media paths unchanged", () => {
    const actualHome = getHomeDir();
    const openclawDir = path.join(actualHome, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const testRoot = fs.mkdtempSync(path.join(openclawDir, "qqbot-platform-test-"));
    createdPaths.push(testRoot);

    const mediaFile = path.join(
      actualHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      path.basename(testRoot),
      "existing.png",
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));

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
    const actualHome = getHomeDir();
    const openclawDir = path.join(actualHome, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const testRoot = fs.mkdtempSync(path.join(openclawDir, "qqbot-platform-test-"));
    createdPaths.push(testRoot);

    const mediaFile = path.join(
      actualHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      path.basename(testRoot),
      "allowed.png",
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));

    expect(resolveQQBotPayloadLocalFilePath(mediaFile)).toBe(mediaFile);
  });

  it("blocks structured payload files inside the QQ Bot data directory", () => {
    const actualHome = getHomeDir();
    const openclawDir = path.join(actualHome, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const testRoot = fs.mkdtempSync(path.join(openclawDir, "qqbot-platform-test-"));
    createdPaths.push(testRoot);

    const dataFile = path.join(
      actualHome,
      ".openclaw",
      "qqbot",
      "sessions",
      path.basename(testRoot),
      "session.json",
    );
    fs.mkdirSync(path.dirname(dataFile), { recursive: true });
    fs.writeFileSync(dataFile, "{}", "utf8");
    createdPaths.push(path.dirname(dataFile));

    expect(resolveQQBotPayloadLocalFilePath(dataFile)).toBeNull();
  });

  it("allows legacy workspace paths when they remap into QQ Bot media storage", () => {
    const actualHome = getHomeDir();
    const openclawDir = path.join(actualHome, ".openclaw");
    fs.mkdirSync(openclawDir, { recursive: true });
    const testRoot = fs.mkdtempSync(path.join(openclawDir, "qqbot-platform-test-"));
    createdPaths.push(testRoot);

    const mediaFile = path.join(
      actualHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      path.basename(testRoot),
      "legacy.png",
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");
    createdPaths.push(path.dirname(mediaFile));

    const missingWorkspacePath = path.join(
      actualHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      path.basename(testRoot),
      "legacy.png",
    );

    expect(resolveQQBotPayloadLocalFilePath(missingWorkspacePath)).toBe(mediaFile);
  });
});
