#!/usr/bin/env bun
/**
 * Android release helper that builds signed release artifacts from the pinned
 * version metadata, verifies signatures, and writes SHA-256 checksum files.
 */

import { $ } from "bun";
import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAndroidVersion, syncAndroidVersioning } from "../../../scripts/lib/android-version.ts";

type ReleaseArtifact = {
  flavorName: "play" | "third-party";
  kind: "aab" | "apk";
  gradleTask: string;
  sourcePath: string;
};

type CliOptions = {
  dryRun: boolean;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, "..");
const rootDir = join(androidDir, "..", "..");
const releaseOutputDir = join(androidDir, "build", "release-artifacts");

function parseArgs(argv: string[]): CliOptions {
  let dryRun = false;

  for (const arg of argv) {
    switch (arg) {
      case "--dry-run": {
        dryRun = true;
        break;
      }
      case "-h":
      case "--help": {
        console.log(
          [
            "Usage: bun apps/android/scripts/build-release-artifacts.ts [--dry-run]",
            "",
            "Builds the signed Play AAB and third-party APK from apps/android/version.json.",
          ].join("\n"),
        );
        process.exit(0);
      }
      default: {
        throw new Error(`Unknown argument: ${arg}`);
      }
    }
  }

  return { dryRun };
}

function releaseArtifacts(versionName: string): ReleaseArtifact[] {
  return [
    {
      flavorName: "play",
      kind: "aab",
      gradleTask: ":app:bundlePlayRelease",
      sourcePath: join(
        androidDir,
        "app",
        "build",
        "outputs",
        "bundle",
        "playRelease",
        "app-play-release.aab",
      ),
    },
    {
      flavorName: "third-party",
      kind: "apk",
      gradleTask: ":app:assembleThirdPartyRelease",
      sourcePath: join(
        androidDir,
        "app",
        "build",
        "outputs",
        "apk",
        "thirdParty",
        "release",
        `openclaw-${versionName}-thirdParty-release.apk`,
      ),
    },
  ];
}

async function sha256Hex(path: string): Promise<string> {
  const buffer = await Bun.file(path).arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function writeSha256File(path: string): Promise<string> {
  const hash = await sha256Hex(path);
  const checksumPath = `${path}.sha256`;
  await Bun.write(checksumPath, `${hash}  ${basename(path)}\n`);
  return hash;
}

async function verifyAabSignature(path: string): Promise<void> {
  await $`jarsigner -verify ${path}`.quiet();
}

function resolveApkSignerFromSdk(sdkRoot: string | undefined): string | null {
  if (!sdkRoot) {
    return null;
  }

  const buildToolsDir = join(sdkRoot, "build-tools");
  if (!existsSync(buildToolsDir)) {
    return null;
  }

  const candidates = readdirSync(buildToolsDir)
    .toSorted((left, right) => right.localeCompare(left))
    .map((version) => join(buildToolsDir, version, "apksigner"))
    .filter((candidate) => existsSync(candidate));

  return candidates[0] ?? null;
}

async function resolveApkSigner(): Promise<string> {
  const sdkApkSigner =
    resolveApkSignerFromSdk(Bun.env.ANDROID_HOME) ??
    resolveApkSignerFromSdk(Bun.env.ANDROID_SDK_ROOT);
  if (sdkApkSigner) {
    return sdkApkSigner;
  }

  try {
    return (await $`command -v apksigner`.text()).trim();
  } catch {
    throw new Error(
      "Missing apksigner. Install Android SDK build-tools or put apksigner on PATH.",
    );
  }
}

async function verifyApkSignature(path: string): Promise<void> {
  const apkSigner = await resolveApkSigner();
  const apkSignerProcess = Bun.spawn([apkSigner, "verify", path], {
    stdout: "ignore",
    stderr: "inherit",
  });
  const exitCode = await apkSignerProcess.exited;
  if (exitCode !== 0) {
    throw new Error(`apksigner verification failed for ${path}`);
  }
}

async function copyArtifact(sourcePath: string, destinationPath: string): Promise<void> {
  const sourceFile = Bun.file(sourcePath);
  if (!(await sourceFile.exists())) {
    throw new Error(`Signed release artifact missing at ${sourcePath}`);
  }

  await Bun.write(destinationPath, sourceFile);
}

async function verifyArtifactSignature(artifact: ReleaseArtifact, outputPath: string): Promise<void> {
  if (artifact.kind === "aab") {
    await verifyAabSignature(outputPath);
  } else {
    await verifyApkSignature(outputPath);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  syncAndroidVersioning({ mode: "check", rootDir });
  const version = resolveAndroidVersion(rootDir);
  const artifacts = releaseArtifacts(version.canonicalVersion);

  console.log(`Android versionName: ${version.canonicalVersion}`);
  console.log(`Android versionCode: ${version.versionCode}`);
  for (const artifact of artifacts) {
    console.log(`Release artifact: ${artifact.flavorName} ${artifact.kind}`);
    console.log(`Gradle task: ${artifact.gradleTask}`);
  }

  if (options.dryRun) {
    console.log("Dry run complete. No Gradle tasks were executed.");
    return;
  }

  await $`mkdir -p ${releaseOutputDir}`;
  await $`./gradlew ${artifacts.map((artifact) => artifact.gradleTask)}`.cwd(androidDir);

  for (const artifact of artifacts) {
    const outputPath = join(
      releaseOutputDir,
      `openclaw-${version.canonicalVersion}-${artifact.flavorName}-release.${artifact.kind}`,
    );

    await copyArtifact(artifact.sourcePath, outputPath);
    await verifyArtifactSignature(artifact, outputPath);
    const hash = await writeSha256File(outputPath);

    console.log(`Signed ${artifact.kind.toUpperCase()} (${artifact.flavorName}): ${outputPath}`);
    console.log(`SHA-256 (${artifact.flavorName}): ${hash}`);
  }
}

await main();
