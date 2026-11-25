import assert from "node:assert/strict";
import { hash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { inspectCuaDriverArtifacts } from "./driver-artifact-verification.js";

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
  const expectedDigest = options.expectedDigest ?? hash("sha256", nativeContents);
  const packages = new Map<string, string>();
  const addPackage = (name: string, packageVersion: string) => {
    const pathname = path.join(root, `${packages.size}.json`);
    fs.writeFileSync(pathname, JSON.stringify({ name, version: packageVersion }));
    packages.set(name, pathname);
  };
  addPackage("@trycua/cua-driver", version);
  if (!options.omitPlatformPackage) {
    addPackage("@trycua/cua-driver-linux-x64-gnu", options.platformVersion ?? version);
  }
  fs.writeFileSync(path.join(root, nativeFile), nativeContents);
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
  onTestFinished(() => inspectionSpy.mockRestore());
  const { verifyInstalledCuaDriverArtifacts } = await import("./driver-artifacts.js");
  expect(verifyInstalledCuaDriverArtifacts()).toEqual({ ok: true });

  // macOS skips digests; still exercise native package resolution through the SDK.
  const { resolvePackageJson, linuxLibc } = inspectionSpy.mock.lastCall![0];
  const sdkManifestPath = resolvePackageJson("@trycua/cua-driver");
  assert(sdkManifestPath, "Installed CUA Driver SDK resolution was not observed");
  const suffixes: Partial<Record<NodeJS.Platform, string>> = {
    linux: `-${linuxLibc}`,
    win32: "-msvc",
  };
  const platformPackage = `@trycua/cua-driver-${process.platform}-${process.arch}${suffixes[process.platform] ?? ""}`;
  expect(resolvePackageJson(platformPackage)).toBe(
    createRequire(sdkManifestPath).resolve(`${platformPackage}/package.json`),
  );
});
