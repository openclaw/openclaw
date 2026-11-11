import fs from "node:fs/promises";
import path from "node:path";
import { pluginSecretRefSetup } from "openclaw/plugin-sdk/secret-ref-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createTrustedNodeFixture } from "./trusted-node.test-support.js";

const { resolveTrustedExecutablePath } = pluginSecretRefSetup;

describe("1Password CLI owner trust", () => {
  it("copies the Node fixture without mutating the installed runtime", async () => {
    await withTempDir("openclaw-op-path-", async (tempDir) => {
      const before = await fs.stat(process.execPath);
      const fixture = createTrustedNodeFixture(tempDir);
      const [sourceAfter, fixtureStat] = await Promise.all([
        fs.stat(process.execPath),
        fs.stat(fixture),
      ]);
      expect(sourceAfter.mode).toBe(before.mode);
      expect([fixtureStat.dev, fixtureStat.ino]).not.toEqual([sourceAfter.dev, sourceAfter.ino]);
    });
  });

  it("requires generic executable paths to be absolute", async () => {
    await expect(resolveTrustedExecutablePath("taskkill.exe")).rejects.toThrow(
      "Executable path must be absolute",
    );
  });

  it.runIf(process.platform !== "win32")(
    "canonicalizes an intentional executable symlink before trust validation",
    async () => {
      await withTempDir("openclaw-op-path-", async (tempDir) => {
        const executable = path.join(tempDir, "op-real");
        const symlink = path.join(tempDir, "op");
        const interpreter = createTrustedNodeFixture(tempDir);
        await fs.writeFile(executable, `#!${interpreter}\nprocess.exit(0);\n`, {
          mode: 0o700,
        });
        await fs.symlink(executable, symlink);
        await expect(resolveTrustedExecutablePath(symlink)).resolves.toBe(
          await fs.realpath(executable),
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")("rejects env-indirected script interpreters", async () => {
    await withTempDir("openclaw-op-path-", async (tempDir) => {
      const executable = path.join(tempDir, "op");
      await fs.writeFile(executable, "#!/usr/bin/env node\nprocess.exit(0);\n", { mode: 0o700 });
      await expect(resolveTrustedExecutablePath(executable)).rejects.toThrow(/env indirection/);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects non-canonical script interpreter aliases",
    async () => {
      await withTempDir("openclaw-op-path-", async (tempDir) => {
        const executable = path.join(tempDir, "op");
        const canonicalInterpreter = createTrustedNodeFixture(tempDir);
        const alias = path.join(tempDir, "node-alias");
        await fs.symlink(canonicalInterpreter, alias);
        await fs.writeFile(executable, `#!${alias}\nprocess.exit(0);\n`, { mode: 0o700 });
        await expect(resolveTrustedExecutablePath(executable)).rejects.toThrow(
          /must be fully resolved/,
        );
      });
    },
  );
});
