import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { root } from "openclaw/plugin-sdk/file-access-runtime";
import packageManifest from "../package.json" with { type: "json" };

export type BeamNativeRelease = {
  version: string;
  protocol: number;
  platforms: Readonly<Record<string, { executableBytes: number; executableSha256: string }>>;
};

const installed: typeof packageManifest & { beamNativeRelease?: BeamNativeRelease } =
  packageManifest;

/** Verification belongs to this plugin instance; registration alone never opens a native asset. */
export function createBeamExecutableResolver(
  pluginRoot: string,
  options: {
    release?: BeamNativeRelease;
    platform?: NodeJS.Platform;
    arch?: string;
  } = {},
): () => Promise<string> {
  let verified: Promise<string> | undefined;
  async function resolve() {
    const release = options.release ?? installed.beamNativeRelease;
    const platform = options.platform ?? process.platform;
    const target = `${platform}-${options.arch ?? process.arch}`;
    if (!release || release.protocol !== 1) {
      throw new Error(
        "This OpenClaw build does not include a compatible Beam cleaner. Install a distribution with native Beam support to mirror sessions.",
      );
    }
    const pin = release.platforms[target];
    if (!pin) {
      throw new Error(
        `Beam outbound cleaning is unavailable on ${target}. Use Beam on a supported sender.`,
      );
    }
    try {
      const packageRoot = await root(pluginRoot);
      const filename = platform === "win32" ? "beam-clean.exe" : "beam-clean";
      // Package managers can hardlink installed files. The release pin authenticates their bytes.
      const { buffer, realPath } = await packageRoot.read(`native/${target}/${filename}`, {
        hardlinks: "allow",
        symlinks: "reject",
        maxBytes: pin.executableBytes,
      });
      if (
        buffer.length !== pin.executableBytes ||
        createHash("sha256").update(buffer).digest("hex") !== pin.executableSha256
      ) {
        throw new Error("Native Beam cleaner checksum mismatch");
      }
      await access(realPath, constants.X_OK);
      return realPath;
    } catch (cause) {
      throw new Error(
        `The packaged Beam ${release.version} cleaner for ${target} is missing or failed verification. Reinstall OpenClaw to restore outbound mirroring.`,
        { cause },
      );
    }
  }
  return () => (verified ??= resolve());
}
