import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runExec: vi.fn() }));
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runExec: mocks.runExec }));

import { probeObsidianCli } from "./obsidian.js";

const isWindows = process.platform === "win32";
const commandName = isWindows ? "obsidian.CMD" : "obsidian";

describe("Obsidian CLI filesystem discovery", () => {
  let root: string;
  let first: string;
  let second: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-obsidian-discovery-"));
    first = path.join(root, "first");
    second = path.join(root, "second");
    await fs.mkdir(first);
    await fs.mkdir(second);
    vi.stubEnv("PATH", [first, second].join(path.delimiter));
    if (isWindows) {
      vi.stubEnv("PATHEXT", ".CMD;.EXE");
    }
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try {
      expect(mocks.runExec).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  async function executable(directory: string, name = commandName) {
    const filename = path.join(directory, name);
    await fs.writeFile(filename, isWindows ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    return filename;
  }

  it("does not report a same-named directory as an installed CLI", async () => {
    await fs.mkdir(path.join(first, commandName));
    await expect(probeObsidianCli()).resolves.toEqual({ available: false, command: null });
  });

  it("continues past a directory to a later executable on PATH", async () => {
    await fs.mkdir(path.join(first, commandName));
    const command = await executable(second);
    await expect(probeObsidianCli()).resolves.toEqual({ available: true, command });
  });

  it("preserves PATH precedence for actual files", async () => {
    const command = await executable(first);
    await executable(second);
    await expect(probeObsidianCli()).resolves.toEqual({ available: true, command });
  });

  it("reports an empty PATH as unavailable", async () => {
    vi.stubEnv("PATH", "");
    await expect(probeObsidianCli()).resolves.toEqual({ available: false, command: null });
  });

  it.skipIf(isWindows)("skips a non-executable file", async () => {
    await fs.writeFile(path.join(first, commandName), "not executable\n", { mode: 0o644 });
    const command = await executable(second);
    await expect(probeObsidianCli()).resolves.toEqual({ available: true, command });
  });

  it.skipIf(isWindows)("retains symlinks to executable regular files", async () => {
    const target = await executable(second, "obsidian-target");
    const command = path.join(first, commandName);
    await fs.symlink(target, command);
    await expect(probeObsidianCli()).resolves.toEqual({ available: true, command });
  });

  it.skipIf(isWindows)("skips symlinks to directories", async () => {
    await fs.symlink(second, path.join(first, commandName));
    const command = await executable(second);
    await expect(probeObsidianCli()).resolves.toEqual({ available: true, command });
  });

  it.skipIf(isWindows)("skips dangling symlinks", async () => {
    await fs.symlink(path.join(root, "missing"), path.join(first, commandName));
    const command = await executable(second);
    await expect(probeObsidianCli()).resolves.toEqual({ available: true, command });
  });

  it.skipIf(!isWindows)("preserves PATHEXT precedence", async () => {
    const command = await executable(first, "obsidian.CMD");
    await executable(first, "obsidian.EXE");
    await expect(probeObsidianCli()).resolves.toEqual({ available: true, command });
  });
});
