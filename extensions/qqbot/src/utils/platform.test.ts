import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveQQBotLocalMediaPath } from "./platform.js";

describe("qqbot local media path remapping", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("remaps missing workspace media paths to the real media directory", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const mediaFile = path.join(
      tempHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      "example.png",
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");

    const missingWorkspacePath = path.join(
      tempHome,
      ".openclaw",
      "workspace",
      "qqbot",
      "downloads",
      "example.png",
    );

    expect(resolveQQBotLocalMediaPath(missingWorkspacePath)).toBe(mediaFile);
  });

  it("leaves existing media paths unchanged", () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "qqbot-home-"));
    vi.spyOn(os, "homedir").mockReturnValue(tempHome);

    const mediaFile = path.join(
      tempHome,
      ".openclaw",
      "media",
      "qqbot",
      "downloads",
      "existing.png",
    );
    fs.mkdirSync(path.dirname(mediaFile), { recursive: true });
    fs.writeFileSync(mediaFile, "image", "utf8");

    expect(resolveQQBotLocalMediaPath(mediaFile)).toBe(mediaFile);
  });
});
