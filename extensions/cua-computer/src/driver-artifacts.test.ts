import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { inspectCuaDriverArtifacts } from "./driver-artifact-verification.js";

function writeJson(pathname: string, value: unknown): void {
  fs.writeFileSync(pathname, `${JSON.stringify(value)}\n`, "utf8");
}

function inspect(
  options: {
    platformVersion?: string;
    omitPlatformPackage?: boolean;
    expectedDigest?: string;
    linuxLibc?: "gnu" | "musl";
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cua-artifacts-"));
  onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const version = "0.20.0";
  const nativeFile = "libcua_driver_sdk.so";
  const nativeContents = "accepted native artifact";
  const expectedDigest =
    options.expectedDigest ?? createHash("sha256").update(nativeContents).digest("hex");
  const sdkManifestPath = path.join(root, "sdk-package.json");
  const platformPackageName = "@trycua/cua-driver-linux-x64-gnu";
  const platformManifestPath = path.join(root, "package.json");

  writeJson(sdkManifestPath, { name: "@trycua/cua-driver", version });
  writeJson(platformManifestPath, {
    name: platformPackageName,
    version: options.platformVersion ?? version,
  });
  fs.writeFileSync(path.join(root, nativeFile), nativeContents);

  const packages = new Map<string, string>([["@trycua/cua-driver", sdkManifestPath]]);
  if (!options.omitPlatformPackage) {
    packages.set(platformPackageName, platformManifestPath);
  }
  return inspectCuaDriverArtifacts({
    platform: "linux",
    arch: "x64",
    linuxLibc: options.linuxLibc ?? "gnu",
    pluginManifest: {
      dependencies: { "@trycua/cua-driver": version },
      cuaDriverArtifacts: { "linux-x64-gnu": { files: { [nativeFile]: expectedDigest } } },
    },
    resolvePackageJson: (packageName: string) => packages.get(packageName),
  });
}

describe("CUA Driver artifact verification", () => {
  it("accepts the pinned SDK and native file digest", () => {
    expect(inspect()).toEqual({ ok: true });
  });

  it.each([
    [{ omitPlatformPackage: true }, "PACKAGE_MISSING", "Reinstall OpenClaw on this node host"],
    [{ platformVersion: "0.19.3" }, "VERSION_MISMATCH", "resolved @trycua/cua-driver@0.20.0"],
    [{ expectedDigest: "0".repeat(64) }, "DIGEST_MISMATCH", "do not run or replace"],
    [{ linuxLibc: "musl" }, "PLATFORM_UNSUPPORTED", "glibc-based Linux"],
  ] as const)("diagnoses %j", (options, code, diagnostic) => {
    const result = inspect(options);
    expect(result).toMatchObject({
      ok: false,
      diagnostic: expect.stringMatching(`^COMPUTER_DRIVER_${code}:`),
    });
    expect(result.ok ? "" : result.diagnostic).toContain(diagnostic);
  });

  // ESM-only SDK resolution previously reported an installed package as missing.
  it("resolves the installed SDK package through import conditions", async () => {
    vi.resetModules();
    const artifactVerification = await import("./driver-artifact-verification.js");
    const inspectionSpy = vi.spyOn(artifactVerification, "inspectCuaDriverArtifacts");
    try {
      const { verifyInstalledCuaDriverArtifacts } = await import("./driver-artifacts.js");
      const result = verifyInstalledCuaDriverArtifacts();
      if (process.platform === "linux" || process.platform === "win32") {
        expect(result).toEqual({ ok: true });
      } else if (!result.ok) {
        expect(result.diagnostic).not.toMatch(/^COMPUTER_DRIVER_PACKAGE_MISSING:/);
      }

      // macOS skips digests; still exercise native package resolution through the SDK.
      const inspection = inspectionSpy.mock.lastCall?.[0];
      const resolvePackageJson = inspection?.resolvePackageJson;
      const sdkManifestPath = resolvePackageJson?.("@trycua/cua-driver");
      if (!sdkManifestPath || !resolvePackageJson) {
        throw new Error("Installed CUA Driver SDK resolution was not observed");
      }
      const platformSuffix =
        process.platform === "linux"
          ? `-${inspection?.linuxLibc}`
          : process.platform === "win32"
            ? "-msvc"
            : "";
      const platformPackage = `@trycua/cua-driver-${process.platform}-${process.arch}${platformSuffix}`;
      expect(resolvePackageJson(platformPackage)).toBe(
        createRequire(sdkManifestPath).resolve(`${platformPackage}/package.json`),
      );
    } finally {
      inspectionSpy.mockRestore();
    }
  });
});
