import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";

it("stages the pinned offline platform matrix and refuses a corrupt or missing cache", () => {
  const fixture = mkdtempSync(path.join(tmpdir(), "Beam release assets "));
  try {
    const plugin = path.join(fixture, "extensions", "beam");
    const built = path.join(fixture, "dist", "extensions", "beam");
    const cache = path.join(fixture, "cache");
    const scripts = path.join(plugin, "scripts");
    for (const dir of [built, scripts, cache]) {
      mkdirSync(dir, { recursive: true });
    }
    const script = path.join(scripts, "package-cleaners.mjs");
    copyFileSync(new URL("./package-cleaners.mjs", import.meta.url), script);
    const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
    const entries = ["darwin", "linux", "win32"].flatMap((platform) =>
      ["arm64", "x64"].map((arch) => {
        const target = `${platform}-${arch}`;
        const raw = Buffer.from(`native ${target}`);
        const compressed = gzipSync(raw);
        const archive = `beam-clean_1.2.3_${platform}_${arch}.gz`;
        writeFileSync(path.join(cache, archive), compressed);
        return [
          target,
          {
            archive,
            bytes: compressed.length,
            sha256: digest(compressed),
            executableBytes: raw.length,
            executableSha256: digest(raw),
          },
        ] as const;
      }),
    );
    writeFileSync(
      path.join(plugin, "package.json"),
      JSON.stringify({
        beamNativeRelease: {
          version: "1.2.3",
          protocol: 1,
          platforms: Object.fromEntries(entries),
        },
      }),
    );
    const stage = () =>
      spawnSync(process.execPath, [script, "--offline", "--cache", cache], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 10_000,
      });
    const prepared = stage();
    expect(prepared.status, prepared.stderr).toBe(0);
    for (const [target, pin] of entries) {
      const filename = target.startsWith("win32-") ? "beam-clean.exe" : "beam-clean";
      expect(digest(readFileSync(path.join(built, "native", target, filename)))).toBe(
        pin.executableSha256,
      );
    }
    const stale = path.join(built, "native", entries[0]![0], "old-cleaner");
    writeFileSync(stale, "previous release");
    expect(stage()).toMatchObject({ status: 1, stderr: expect.stringContaining("old-cleaner") });
    rmSync(stale);
    const first = entries[0]![1];
    const archive = path.join(cache, first.archive);
    writeFileSync(archive, Buffer.alloc(first.bytes));
    expect(stage()).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("failed verification"),
    });
    rmSync(archive);
    expect(stage()).toMatchObject({
      status: 1,
      stderr: expect.stringContaining("Missing offline Beam asset"),
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
