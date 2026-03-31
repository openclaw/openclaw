import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getHomeDir, resolveQQBotLocalMediaPath } from "./platform.js";

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
});
