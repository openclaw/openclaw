import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { stdioCommandExists } from "./mcp-stdio-command-check.js";

describe("stdioCommandExists", () => {
  it("finds a command resolvable on PATH", async () => {
    expect(await stdioCommandExists(process.platform === "win32" ? "cmd" : "sh", undefined, {
      PATH: process.env.PATH ?? "",
    })).toBe(true);
  });

  it("reports a command absent from every PATH entry", async () => {
    const missing = `openclaw-test-missing-command-${randomUUID()}`;
    expect(await stdioCommandExists(missing, undefined, { PATH: process.env.PATH ?? "" })).toBe(
      false,
    );
  });

  it("resolves an absolute path directly without consulting PATH", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stdio-command-check-"));
    try {
      const scriptPath = path.join(tempDir, "runnable.sh");
      await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
      await fs.chmod(scriptPath, 0o755);

      expect(await stdioCommandExists(scriptPath, undefined, undefined)).toBe(true);
      expect(await stdioCommandExists(path.join(tempDir, "missing.sh"), undefined, undefined)).toBe(
        false,
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves a relative path against the provided cwd", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stdio-command-check-cwd-"));
    try {
      const scriptPath = path.join(tempDir, "runnable.sh");
      await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
      await fs.chmod(scriptPath, 0o755);

      expect(await stdioCommandExists("./runnable.sh", tempDir, undefined)).toBe(true);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  // POSIX PATH lookup and directory resolution use literal bytes; only a
  // truly empty PATH segment means "current directory". A directory name
  // with significant trailing whitespace is unusual but valid, and this
  // checker must not silently strip it before searching.
  it.skipIf(process.platform === "win32")(
    "preserves significant trailing whitespace in a PATH entry",
    async () => {
      const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "stdio-command-check-ws-"));
      try {
        const paddedDir = path.join(parentDir, "bin ");
        await fs.mkdir(paddedDir);
        const scriptPath = path.join(paddedDir, "launcher");
        await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
        await fs.chmod(scriptPath, 0o755);

        expect(await stdioCommandExists("launcher", undefined, { PATH: paddedDir })).toBe(true);
      } finally {
        await fs.rm(parentDir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves significant trailing whitespace in cwd",
    async () => {
      const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "stdio-command-check-cwd-ws-"));
      try {
        const paddedDir = path.join(parentDir, "work ");
        await fs.mkdir(paddedDir);
        const scriptPath = path.join(paddedDir, "runnable.sh");
        await fs.writeFile(scriptPath, "#!/bin/sh\nexit 0\n");
        await fs.chmod(scriptPath, 0o755);

        expect(await stdioCommandExists("./runnable.sh", paddedDir, undefined)).toBe(true);
      } finally {
        await fs.rm(parentDir, { recursive: true, force: true });
      }
    },
  );

  // Node's own spawn (via libuv) tries PATHEXT suffixes for an explicit path
  // too, not just PATH-search candidates: an extensionless `C:\Tools\uvx`
  // successfully launches `C:\Tools\uvx.exe`. This must match, or a working
  // Windows launch config trips a false "command not found".
  describe.runIf(process.platform === "win32")("on Windows", () => {
    it("resolves an extensionless absolute path via its .exe suffix", async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "stdio-command-check-win-"));
      try {
        const exePath = path.join(tempDir, "runnable.exe");
        await fs.writeFile(exePath, "");

        expect(
          await stdioCommandExists(path.join(tempDir, "runnable"), undefined, undefined),
        ).toBe(true);
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });
  });
});
