import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHomeDir, getQQBotMediaDir, resolveQQBotLocalMediaPath } from "./platform.js";

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

    expect(resolveQQBotLocalMediaPath(mediaFile)).toBe(mediaFile);
  });

  it("blocks existing files outside QQ Bot-owned roots", () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-outside-"));
    createdPaths.push(outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret", "utf8");

    expect(() => resolveQQBotLocalMediaPath(outsideFile)).toThrow(
      "Local media path is outside allowed roots",
    );
  });

  it("allows files under the preferred OpenClaw temp root", () => {
    const tmpRoot = resolvePreferredOpenClawTmpDir();
    fs.mkdirSync(tmpRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tmpRoot, "qqbot-platform-test-"));
    createdPaths.push(tempDir);
    const tempFile = path.join(tempDir, "voice.mp3");
    fs.writeFileSync(tempFile, "audio", "utf8");

    expect(resolveQQBotLocalMediaPath(tempFile)).toBe(tempFile);
  });

  it("blocks symlink escapes from QQ Bot media roots", () => {
    if (process.platform === "win32") {
      return;
    }

    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-symlink-outside-"));
    createdPaths.push(outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret", "utf8");

    const mediaDir = fs.mkdtempSync(path.join(getQQBotMediaDir("downloads"), "symlink-test-"));
    createdPaths.push(mediaDir);
    const symlinkPath = path.join(mediaDir, "linked-secret.txt");
    fs.symlinkSync(outsideFile, symlinkPath);

    expect(() => resolveQQBotLocalMediaPath(symlinkPath)).toThrow(
      "Local media path is outside allowed roots",
    );
  });
});
