import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectCuaDriverArtifacts } from "./driver-artifact-verification.js";

const temporaryDirectories: string[] = [];

function writeJson(pathname: string, value: unknown): void {
  fs.writeFileSync(pathname, `${JSON.stringify(value)}\n`, "utf8");
}

function createArtifactFixture(
  options: {
    platformVersion?: string;
    omitPlatformPackage?: boolean;
    expectedDigest?: string;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cua-artifacts-"));
  temporaryDirectories.push(root);
  const platformKey = "linux-x64-gnu";
  const acceptedVersion = "0.20.0";
  const nativeFile = "libcua_driver_sdk.so";
  const nativeContents = "accepted native artifact";
  const expectedDigest =
    options.expectedDigest ?? createHash("sha256").update(nativeContents).digest("hex");
  const sdkManifestPath = path.join(root, "sdk-package.json");
  const platformPackageName = `@trycua/cua-driver-${platformKey}`;
  const platformDir = path.join(root, "platform");
  const platformManifestPath = path.join(platformDir, "package.json");

  fs.mkdirSync(platformDir);
  const pluginManifest = {
    dependencies: { "@trycua/cua-driver": acceptedVersion },
    cuaDriverArtifacts: { [platformKey]: { files: { [nativeFile]: expectedDigest } } },
  };
  writeJson(sdkManifestPath, {
    name: "@trycua/cua-driver",
    version: acceptedVersion,
  });
  writeJson(platformManifestPath, {
    name: platformPackageName,
    version: options.platformVersion ?? acceptedVersion,
  });
  fs.writeFileSync(path.join(platformDir, nativeFile), nativeContents);

  const packages = new Map<string, string>([["@trycua/cua-driver", sdkManifestPath]]);
  if (!options.omitPlatformPackage) {
    packages.set(platformPackageName, platformManifestPath);
  }
  return {
    pluginManifest,
    resolvePackageJson: (packageName: string) => packages.get(packageName),
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("CUA Driver artifact verification", () => {
  const inspect = (
    options: Parameters<typeof createArtifactFixture>[0] = {},
    linuxLibc: "gnu" | "musl" = "gnu",
  ) =>
    inspectCuaDriverArtifacts({
      platform: "linux",
      arch: "x64",
      linuxLibc,
      ...createArtifactFixture(options),
    });

  it("accepts the pinned SDK and native file digest", () => {
    expect(inspect()).toEqual({
      ok: true,
      applicable: true,
      version: "0.20.0",
      platformPackage: "@trycua/cua-driver-linux-x64-gnu",
    });
  });

  it.each([
    {
      name: "missing native package",
      options: { omitPlatformPackage: true },
      code: "COMPUTER_DRIVER_PACKAGE_MISSING",
      diagnostic: "Reinstall OpenClaw on this node host",
    },
    {
      name: "SDK and platform version skew",
      options: { platformVersion: "0.19.3" },
      code: "COMPUTER_DRIVER_VERSION_MISMATCH",
      diagnostic: "resolved @trycua/cua-driver@0.20.0",
    },
    {
      name: "native digest mismatch",
      options: { expectedDigest: "0".repeat(64) },
      code: "COMPUTER_DRIVER_DIGEST_MISMATCH",
      diagnostic: "do not run or replace",
    },
  ])("diagnoses $name", ({ options, code, diagnostic }) => {
    const result = inspect(options);
    expect(result).toMatchObject({ ok: false, code });
    expect(result.ok ? "" : result.diagnostic).toContain(diagnostic);
  });

  it("rejects Linux hosts without a published glibc package", () => {
    const result = inspect({}, "musl");
    expect(result).toMatchObject({ ok: false, code: "COMPUTER_DRIVER_PLATFORM_UNSUPPORTED" });
    expect(result.ok ? "" : result.diagnostic).toContain("glibc-based Linux");
  });
});

describe("verifyInstalledCuaDriverArtifacts (real resolution)", () => {
  // Regression: the CUA Driver SDK is ESM-only, so require-condition resolution
  // threw PATH_NOT_EXPORTED and every real install reported
  // COMPUTER_DRIVER_PACKAGE_MISSING even with the packages present.
  it("resolves the installed SDK package through import conditions", async () => {
    vi.resetModules();
    const artifactVerification = await import("./driver-artifact-verification.js");
    const inspect = vi.spyOn(artifactVerification, "inspectCuaDriverArtifacts");
    try {
      const { verifyInstalledCuaDriverArtifacts } = await import("./driver-artifacts.js");
      const result = verifyInstalledCuaDriverArtifacts();
      if (process.platform === "linux" || process.platform === "win32") {
        expect(result).toMatchObject({ ok: true, applicable: true });
      } else if (!result.ok) {
        // Other hosts are out of the fulfiller's scope but must never report a
        // missing package for an installed SDK.
        expect(result.code).not.toBe("COMPUTER_DRIVER_PACKAGE_MISSING");
      }

      // macOS does not verify native digests, but must still exercise the real
      // dependency owner used by Linux/Windows isolated installs.
      const inspection = inspect.mock.lastCall?.[0];
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
      inspect.mockRestore();
    }
  });
});
