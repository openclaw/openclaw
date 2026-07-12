#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AI_PACKAGE_NAME = "@openclaw/ai";
const AI_LOCK_PATH = "node_modules/@openclaw/ai";

type JsonObject = Record<string, unknown>;

type PackageManifest = JsonObject & {
  dependencies?: Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
  name?: string;
  version?: string;
};

type NpmShrinkwrap = JsonObject & {
  lockfileVersion?: number;
  packages?: Record<string, JsonObject>;
};

function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a nonempty string`);
  }
  return value.trim();
}

function registryTarballUrl(packageName: string, version: string): string {
  return `https://registry.npmjs.org/${packageName}/-/${basename(packageName)}-${version}.tgz`;
}

function expectedAiLockEntry(params: {
  aiIntegrity: string;
  aiManifest: PackageManifest;
  aiVersion: string;
}): JsonObject {
  const aiDependencies = params.aiManifest.dependencies ?? {};
  return {
    version: params.aiVersion,
    resolved: registryTarballUrl(AI_PACKAGE_NAME, params.aiVersion),
    integrity: params.aiIntegrity,
    ...(params.aiManifest.license ? { license: params.aiManifest.license } : {}),
    ...(Object.keys(aiDependencies).length > 0 ? { dependencies: aiDependencies } : {}),
    ...(params.aiManifest.engines ? { engines: params.aiManifest.engines } : {}),
  };
}

export function prepareOpenClawNpmShrinkwrap(params: {
  aiIntegrity: string;
  aiManifest: PackageManifest;
  rootManifest: PackageManifest;
  shrinkwrap: NpmShrinkwrap;
}): NpmShrinkwrap {
  const rootVersion = requireString(params.rootManifest.version, "root package version");
  const aiName = requireString(params.aiManifest.name, "AI package name");
  const aiVersion = requireString(params.aiManifest.version, "AI package version");
  if (aiName !== AI_PACKAGE_NAME) {
    throw new Error(`AI package name must be ${AI_PACKAGE_NAME}, found ${aiName}`);
  }
  if (aiVersion !== rootVersion) {
    throw new Error(`AI package version ${aiVersion} does not match OpenClaw ${rootVersion}`);
  }
  if (!params.aiIntegrity.startsWith("sha512-")) {
    throw new Error("AI package integrity must use sha512");
  }
  if (params.shrinkwrap.lockfileVersion !== 3) {
    throw new Error(`npm shrinkwrap lockfileVersion must be 3`);
  }

  const packages = requireObject(params.shrinkwrap.packages, "npm shrinkwrap packages") as Record<
    string,
    JsonObject
  >;
  const rootPackage = requireObject(packages[""], "npm shrinkwrap root package");
  const rootLockVersion = requireString(rootPackage.version, "npm shrinkwrap root version");
  if (rootLockVersion !== rootVersion) {
    throw new Error(
      `npm shrinkwrap root version ${rootLockVersion} does not match OpenClaw ${rootVersion}`,
    );
  }

  const rootDependencies = requireObject(
    rootPackage.dependencies,
    "npm shrinkwrap root dependencies",
  ) as Record<string, unknown>;
  const aiDependencies = params.aiManifest.dependencies ?? {};
  for (const dependencyName of Object.keys(aiDependencies)) {
    if (!packages[`node_modules/${dependencyName}`]) {
      throw new Error(`npm shrinkwrap is missing AI runtime dependency ${dependencyName}`);
    }
  }

  rootDependencies[AI_PACKAGE_NAME] = aiVersion;
  packages[AI_LOCK_PATH] = expectedAiLockEntry({
    aiIntegrity: params.aiIntegrity,
    aiManifest: params.aiManifest,
    aiVersion,
  });
  return params.shrinkwrap;
}

export function assertPreparedOpenClawNpmShrinkwrap(params: {
  aiIntegrity: string;
  aiManifest: PackageManifest;
  rootManifest: PackageManifest;
  shrinkwrap: NpmShrinkwrap;
}): void {
  const expected = prepareOpenClawNpmShrinkwrap({
    ...params,
    shrinkwrap: structuredClone(params.shrinkwrap),
  });
  const actualPackages = requireObject(
    params.shrinkwrap.packages,
    "npm shrinkwrap packages",
  ) as Record<string, JsonObject>;
  const expectedPackages = requireObject(
    expected.packages,
    "expected npm shrinkwrap packages",
  ) as Record<string, JsonObject>;
  const actualRoot = requireObject(actualPackages[""], "npm shrinkwrap root package");
  const expectedRoot = requireObject(expectedPackages[""], "expected npm shrinkwrap root package");
  const actualRootDependencies = requireObject(
    actualRoot.dependencies,
    "npm shrinkwrap root dependencies",
  );
  const expectedRootDependencies = requireObject(
    expectedRoot.dependencies,
    "expected npm shrinkwrap root dependencies",
  );
  if (
    actualRootDependencies[AI_PACKAGE_NAME] !== expectedRootDependencies[AI_PACKAGE_NAME] ||
    JSON.stringify(actualPackages[AI_LOCK_PATH]) !== JSON.stringify(expectedPackages[AI_LOCK_PATH])
  ) {
    throw new Error(
      `prepared OpenClaw npm shrinkwrap does not lock the exact ${AI_PACKAGE_NAME} tarball`,
    );
  }
}

export function readTarballJson(tarballPath: string, entry: string): JsonObject {
  const raw = execFileSync("tar", ["-xOf", tarballPath, entry], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return requireObject(JSON.parse(raw), `${entry} in ${tarballPath}`);
}

export function npmTarballIntegrity(tarballPath: string): string {
  return `sha512-${createHash("sha512").update(readFileSync(tarballPath)).digest("base64")}`;
}

function main(argv = process.argv.slice(2)): void {
  const aiTarballPath = argv[0]?.trim();
  const shrinkwrapPath = resolve(argv[1]?.trim() || "npm-shrinkwrap.json");
  const rootManifestPath = resolve(argv[2]?.trim() || "package.json");
  if (!aiTarballPath || argv.length > 3) {
    throw new Error(
      "Usage: node --import tsx scripts/prepare-openclaw-npm-shrinkwrap.ts <openclaw-ai.tgz> [npm-shrinkwrap.json] [package.json]",
    );
  }

  const prepared = prepareOpenClawNpmShrinkwrap({
    aiIntegrity: npmTarballIntegrity(aiTarballPath),
    aiManifest: readTarballJson(aiTarballPath, "package/package.json") as PackageManifest,
    rootManifest: requireObject(
      JSON.parse(readFileSync(rootManifestPath, "utf8")),
      "root package manifest",
    ) as PackageManifest,
    shrinkwrap: requireObject(
      JSON.parse(readFileSync(shrinkwrapPath, "utf8")),
      "npm shrinkwrap",
    ) as NpmShrinkwrap,
  });
  writeFileSync(shrinkwrapPath, `${JSON.stringify(prepared, null, 2)}\n`);
  console.log(`Prepared ${shrinkwrapPath} for ${AI_PACKAGE_NAME}.`);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint !== null && import.meta.url === entrypoint) {
  main();
}
