import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectRemoteHostFromCliPath } from "./remote-host.js";

describe("detectRemoteHostFromCliPath", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })),
    );
  });

  it("uses the system home when HOME is blank", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-imessage-home-"));
    tempDirs.push(home);
    vi.stubEnv("HOME", "");
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const wrapperDir = path.join(home, ".openclaw");
    const wrapperPath = path.join(wrapperDir, "imsg-remote");
    await fs.mkdir(wrapperDir, { recursive: true });
    await fs.writeFile(wrapperPath, '#!/bin/sh\nexec ssh user@example.test imsg "$@"\n', "utf8");

    await expect(detectRemoteHostFromCliPath("~/.openclaw/imsg-remote")).resolves.toBe(
      "user@example.test",
    );
  });
});
