import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createBeamExecutableResolver, type BeamNativeRelease } from "./executable.js";

const content = Buffer.from("packaged Beam executable");
const pin = {
  executableBytes: content.length,
  executableSha256: createHash("sha256").update(content).digest("hex"),
};
const release: BeamNativeRelease = {
  version: "1.2.3",
  protocol: 1,
  platforms: { "linux-x64": pin, "win32-arm64": pin },
};

it.each([
  ["linux", "x64", "beam-clean"],
  ["win32", "arm64", "beam-clean.exe"],
] as const)("verifies the installed %s-%s executable once", async (platform, arch, name) => {
  const dir = await mkdtemp(path.join(tmpdir(), "beam installed "));
  try {
    const bin = path.join(dir, "native", `${platform}-${arch}`, name);
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, content, { mode: 0o755 });
    const resolve = createBeamExecutableResolver(dir, { platform, arch, release });
    const first = resolve();
    expect(resolve()).toBe(first);
    expect(await first).toBe(await realpath(bin));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

it("reports an unsupported platform without opening a native asset", async () => {
  const resolve = createBeamExecutableResolver("", { platform: "aix", arch: "ppc64", release });
  await expect(resolve()).rejects.toThrow("unavailable on aix-ppc64");
});

it("refuses missing and altered executables at the correct installation path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "beam checksum "));
  try {
    const opts = { platform: "linux", arch: "x64", release } as const;
    await expect(createBeamExecutableResolver(dir, opts)()).rejects.toThrow("Reinstall OpenClaw");
    const bin = path.join(dir, "native", "linux-x64", "beam-clean");
    await mkdir(path.dirname(bin), { recursive: true });
    await writeFile(bin, Buffer.alloc(content.length), { mode: 0o755 });
    await expect(createBeamExecutableResolver(dir, opts)()).rejects.toThrow("failed verification");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
