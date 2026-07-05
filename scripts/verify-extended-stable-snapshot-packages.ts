#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertExtendedStableReleaseVersion } from "./lib/extended-stable-plugin-acceptance.js";
import { verifyNpmPackage } from "./lib/npm-package-readback.js";
import { collectExtendedStableSnapshotPluginPackages } from "./lib/plugin-npm-release.js";

type SnapshotReadback = {
  packageName: string;
  version: string;
  npmIntegrity: string;
  installVerified: true;
};

function readRootVersion(rootDir: string): string {
  const value: unknown = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Root package.json must be an object.");
  }
  const version = (value as { version?: unknown }).version;
  if (typeof version !== "string") {
    throw new Error("Root package.json version must be a string.");
  }
  return assertExtendedStableReleaseVersion(version);
}

function installExactSnapshot(
  packageNames: string[],
  releaseVersion: string,
  snapshotVersion: string,
): void {
  const installDir = mkdtempSync(join(tmpdir(), "openclaw-extended-stable-snapshot-"));
  try {
    writeFileSync(join(installDir, "package.json"), '{"private":true}\n');
    writeFileSync(join(installDir, ".npmrc"), "");
    const specs = [
      `openclaw@${releaseVersion}`,
      ...packageNames.map((packageName) => `${packageName}@${snapshotVersion}`),
    ];
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--registry=https://registry.npmjs.org/",
        ...specs,
      ],
      { cwd: installDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const installedCore = JSON.parse(
      readFileSync(join(installDir, "node_modules", "openclaw", "package.json"), "utf8"),
    ) as { version?: unknown };
    if (installedCore.version !== releaseVersion) {
      throw new Error(
        `openclaw clean install resolved ${String(installedCore.version)}; expected ${releaseVersion}.`,
      );
    }
    for (const packageName of packageNames) {
      const installed = JSON.parse(
        readFileSync(
          join(installDir, "node_modules", ...packageName.split("/"), "package.json"),
          "utf8",
        ),
      ) as { version?: unknown };
      if (installed.version !== snapshotVersion) {
        throw new Error(
          `${packageName} clean install resolved ${String(installed.version)}; expected ${snapshotVersion}.`,
        );
      }
    }
  } finally {
    rmSync(installDir, { force: true, recursive: true });
  }
}

export async function verifyExtendedStableSnapshotPackages(
  rootDir = resolve("."),
  dependencies: {
    verifyPackage?: typeof verifyNpmPackage;
    installPackages?: (
      packageNames: string[],
      releaseVersion: string,
      snapshotVersion: string,
    ) => void;
  } = {},
): Promise<SnapshotReadback[]> {
  const releaseVersion = readRootVersion(rootDir);
  const snapshotVersion = `${releaseVersion.split(".").slice(0, 2).join(".")}.33`;
  const packageNames = collectExtendedStableSnapshotPluginPackages(rootDir).map(
    (plugin) => plugin.packageName,
  );
  const verifyPackage = dependencies.verifyPackage ?? verifyNpmPackage;
  const readbacks = [];
  for (const packageName of packageNames) {
    const readback = await verifyPackage(packageName, snapshotVersion);
    if (!readback.integrity?.startsWith("sha512-")) {
      throw new Error(`${packageName}@${snapshotVersion} npm integrity must be sha512.`);
    }
    readbacks.push({
      packageName,
      version: snapshotVersion,
      npmIntegrity: readback.integrity,
      installVerified: true as const,
    });
  }
  (dependencies.installPackages ?? installExactSnapshot)(
    packageNames,
    releaseVersion,
    snapshotVersion,
  );
  return readbacks;
}

function requiredArg(argv: string[], flag: string): string {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1]?.trim() : "";
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} is required.`);
  }
  return value;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const output = requiredArg(process.argv.slice(2), "--output");
  const readbacks = await verifyExtendedStableSnapshotPackages();
  writeFileSync(output, `${JSON.stringify(readbacks, null, 2)}\n`);
}
