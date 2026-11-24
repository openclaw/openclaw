import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import packageManifest from "../package.json" with { type: "json" };

export type BeamNativeRelease = {
  version: string;
  platforms: Readonly<Record<string, { executableSha256: string }>>;
};

const installed: typeof packageManifest & { beamNativeRelease?: BeamNativeRelease } =
  packageManifest;
export const resolveBeamExecutable = createBeamExecutableResolver({
  release: installed.beamNativeRelease,
  resolvePackage: createRequire(import.meta.url).resolve,
  platform: process.platform,
  arch: process.arch,
});

/** Verify the packaged cleaner once per installation. Receive and catalog reads never call this. */
export function createBeamExecutableResolver(params: {
  release: BeamNativeRelease | undefined;
  resolvePackage: (name: string) => string;
  platform: NodeJS.Platform;
  arch: string;
}): () => Promise<string> {
  let executable: Promise<string> | undefined;
  async function resolve() {
    const { release } = params;
    if (!release) {
      throw new Error(
        "This OpenClaw build does not include a pinned Beam cleaner. Install a distribution with native Beam support to mirror sessions.",
      );
    }
    const target = `${params.platform}-${params.arch}`;
    const pin = release.platforms[target];
    if (!pin) {
      throw new Error(
        `Beam outbound cleaning is unavailable on ${target}. Use Beam on a supported sender.`,
      );
    }
    const packageName = `@openclaw/beam-${target}`;
    let packageDir: string;
    try {
      packageDir = dirname(params.resolvePackage(`${packageName}/package.json`));
    } catch (cause) {
      throw new Error(
        `Beam outbound cleaning requires ${packageName}@${release.version}. Reinstall OpenClaw with optional dependencies enabled.`,
        { cause },
      );
    }

    const filename = params.platform === "win32" ? "bin/beam.exe" : "bin/beam";
    // pnpm can hardlink the installed bytes. The OpenClaw pin authenticates their content.
    try {
      const fsRoot = await root(packageDir);
      const { buffer, realPath } = await fsRoot.read(filename, {
        hardlinks: "allow",
        symlinks: "reject",
        maxBytes: 64 * 1024 * 1024,
      });
      if (createHash("sha256").update(buffer).digest("hex") !== pin.executableSha256) {
        throw new Error("SHA-256 mismatch");
      }
      await access(realPath, constants.X_OK);
      return realPath;
    } catch (cause) {
      throw new Error(
        `The Beam outbound cleaner in ${packageName}@${release.version} failed verification. Reinstall OpenClaw before mirroring.`,
        { cause },
      );
    }
  }
  return () => (executable ??= resolve());
}
