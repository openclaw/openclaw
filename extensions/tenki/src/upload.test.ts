import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalTarball } from "./upload.js";

function makeWorkspace(): string {
  return mkdtempSync(path.join(os.tmpdir(), "openclaw-tenki-upload-"));
}

describe("createLocalTarball", () => {
  it("tars a plain workspace tree", async () => {
    const dir = makeWorkspace();
    mkdirSync(path.join(dir, "nested"));
    writeFileSync(path.join(dir, "nested", "file.txt"), "hello");

    const tarball = await createLocalTarball(dir);
    expect(tarball.length).toBeGreaterThan(0);
    expect(tarball.toString("utf8")).toContain("nested/file.txt");
  });

  it("allows symlinks resolving inside the workspace", async () => {
    const dir = makeWorkspace();
    writeFileSync(path.join(dir, "target.txt"), "inside");
    symlinkSync(path.join(dir, "target.txt"), path.join(dir, "link.txt"));

    await expect(createLocalTarball(dir)).resolves.toBeInstanceOf(Buffer);
  });

  it("refuses symlinks escaping the workspace", async () => {
    const outside = makeWorkspace();
    writeFileSync(path.join(outside, "secret.txt"), "outside");
    const dir = makeWorkspace();
    mkdirSync(path.join(dir, "nested"));
    symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "nested", "escape.txt"));

    await expect(createLocalTarball(dir)).rejects.toThrow(
      /refuses symlink escaping the workspace: nested\/escape\.txt/,
    );
  });

  it("refuses dangling symlinks whose target points outside", async () => {
    const dir = makeWorkspace();
    symlinkSync(path.join(dir, "..", "missing-outside.txt"), path.join(dir, "dangling.txt"));

    await expect(createLocalTarball(dir)).rejects.toThrow(
      /refuses symlink escaping the workspace: dangling\.txt/,
    );
  });

  it("allows dangling symlinks whose target stays inside", async () => {
    const dir = makeWorkspace();
    symlinkSync(path.join(dir, "missing-inside.txt"), path.join(dir, "dangling.txt"));

    await expect(createLocalTarball(dir)).resolves.toBeInstanceOf(Buffer);
  });
});
