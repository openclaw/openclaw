import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createBeamExecutableResolver } from "./executable.js";

const content = Buffer.from("packaged Beam executable");
const release = {
  version: "1.2.3",
  platforms: {
    "linux-x64": { executableSha256: createHash("sha256").update(content).digest("hex") },
    "win32-arm64": { executableSha256: createHash("sha256").update(content).digest("hex") },
  },
};

it.each([
  ["linux", "x64", "beam"],
  ["win32", "arm64", "beam.exe"],
] as const)("verifies the installed %s-%s executable once", async (platform, arch, name) => {
  const dir = await mkdtemp(path.join(tmpdir(), "beam installed "));
  try {
    const bin = path.join(dir, "bin", name);
    await mkdir(path.dirname(bin));
    await writeFile(bin, content, { mode: 0o755 });
    const resolvePackage = vi.fn(() => path.join(dir, "package.json"));
    const resolve = createBeamExecutableResolver({ platform, arch, resolvePackage, release });
    const [first, second] = await Promise.all([resolve(), resolve()]);
    expect(first).toBe(second);
    expect(path.basename(first)).toBe(name);
    expect(resolvePackage).toHaveBeenCalledExactlyOnceWith(
      `@openclaw/beam-${platform}-${arch}/package.json`,
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

it("refuses an unsupported host before package lookup", async () => {
  const resolvePackage = vi.fn();
  const resolve = createBeamExecutableResolver({
    platform: "aix",
    arch: "ppc64",
    resolvePackage,
    release,
  });
  await expect(resolve()).rejects.toThrow("unavailable on aix-ppc64");
  expect(resolvePackage).not.toHaveBeenCalled();
});

it("reports a missing optional package", async () => {
  const resolve = createBeamExecutableResolver({
    platform: "linux",
    arch: "x64",
    release,
    resolvePackage: () => {
      throw new Error("package missing");
    },
  });
  await expect(resolve()).rejects.toThrow("Reinstall OpenClaw with optional dependencies enabled");
});

it("rejects different bytes even when the package name matches", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "beam checksum "));
  try {
    await mkdir(path.join(dir, "bin"));
    await writeFile(path.join(dir, "bin", "beam"), "other bytes", { mode: 0o755 });
    const resolve = createBeamExecutableResolver({
      platform: "linux",
      arch: "x64",
      resolvePackage: () => path.join(dir, "package.json"),
      release,
    });
    await expect(resolve()).rejects.toThrow("failed verification");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
