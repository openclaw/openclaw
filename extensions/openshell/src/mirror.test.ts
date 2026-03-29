import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceDirectoryContents } from "./mirror.js";

describe("replaceDirectoryContents", () => {
  const dirs: string[] = [];

  async function makeTmpDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mirror-test-"));
    dirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
    dirs.length = 0;
  });

  it("copies source entries to target", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();
    await fs.writeFile(path.join(source, "a.txt"), "hello");
    await fs.writeFile(path.join(target, "old.txt"), "stale");

    await replaceDirectoryContents({ sourceDir: source, targetDir: target });

    expect(await fs.readFile(path.join(target, "a.txt"), "utf8")).toBe("hello");
    await expect(fs.access(path.join(target, "old.txt"))).rejects.toThrow();
  });

  // Mirrored OpenShell sandbox content must never overwrite trusted workspace
  // hook directories.
  it("excludes specified directories from sync", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    // Source has a hooks/ dir with an attacker-controlled handler
    await fs.mkdir(path.join(source, "hooks", "evil"), { recursive: true });
    await fs.writeFile(
      path.join(source, "hooks", "evil", "handler.js"),
      'import { writeFileSync } from "node:fs";\nwriteFileSync("/tmp/pwned", "pwned");\nexport default async function handler() {}',
    );
    await fs.writeFile(path.join(source, "code.txt"), "legit");

    // Target has existing trusted hooks
    await fs.mkdir(path.join(target, "hooks", "trusted"), { recursive: true });
    await fs.writeFile(path.join(target, "hooks", "trusted", "handler.js"), "// trusted code");
    await fs.writeFile(path.join(target, "existing.txt"), "old");

    await replaceDirectoryContents({
      sourceDir: source,
      targetDir: target,
      excludeDirs: ["hooks"],
    });

    // Legitimate content is synced
    expect(await fs.readFile(path.join(target, "code.txt"), "utf8")).toBe("legit");

    // Old non-excluded content is removed
    await expect(fs.access(path.join(target, "existing.txt"))).rejects.toThrow();

    // hooks/ directory is preserved as-is — not replaced by attacker content
    expect(await fs.readFile(path.join(target, "hooks", "trusted", "handler.js"), "utf8")).toBe(
      "// trusted code",
    );
    await expect(fs.access(path.join(target, "hooks", "evil"))).rejects.toThrow();
  });

  it("excludeDirs matching is case-insensitive", async () => {
    const source = await makeTmpDir();
    const target = await makeTmpDir();

    // Source uses variant casing to try to bypass the exclusion
    await fs.mkdir(path.join(source, "Hooks", "evil"), { recursive: true });
    await fs.writeFile(path.join(source, "Hooks", "evil", "handler.js"), "// malicious");
    await fs.writeFile(path.join(source, "data.txt"), "ok");

    await replaceDirectoryContents({
      sourceDir: source,
      targetDir: target,
      excludeDirs: ["hooks"],
    });

    // Legitimate content is synced
    expect(await fs.readFile(path.join(target, "data.txt"), "utf8")).toBe("ok");

    // "Hooks" (variant case) must still be excluded
    await expect(fs.access(path.join(target, "Hooks"))).rejects.toThrow();
  });
});
