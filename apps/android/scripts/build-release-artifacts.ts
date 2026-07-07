#!/usr/bin/env bun
/**
 * Android release helper that builds signed release artifacts from the pinned
 * version metadata, verifies signatures, and writes SHA-256 checksum files.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAndroidVersion, syncAndroidVersioning } from "../../../scripts/lib/android-version.ts";

type ReleaseArtifact = {
  flavorName: "play" | "third-party";
  kind: "aab" | "apk";
  gradleTask: string;
  sourcePath: string;
};

type CliOptions = {
  artifact: "all" | ReleaseArtifact["flavorName"];
  dryRun: boolean;
  verifyApk?: string;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, "..");
const rootDir = join(androidDir, "..", "..");
const releaseOutputDir = join(androidDir, "build", "release-artifacts");
const releaseSigningManifestPath = join(androidDir, "Config", "ReleaseSigning.json");

function parseArgs(argv: string[]): CliOptions {
  let artifact: CliOptions["artifact"] = "all";
  let dryRun = false;
  let verifyApk: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--artifact": {
        const value = argv[index + 1];
        if (value !== "all" && value !== "play" && value !== "third-party") {
          throw new Error("--artifact must be one of: all, play, third-party");
        }
        artifact = value;
        index += 1;
        break;
      }
      case "--dry-run": {
        dryRun = true;
        break;
      }
      case "--verify-apk": {
        const value = argv[index + 1];
        if (!value || value.startsWith("-")) {
          throw new Error("Missing value for --verify-apk");
        }
        verifyApk = value;
        index += 1;
        break;
      }
      case "-h":
      case "--help": {
        console.log(
          [
            "Usage: bun apps/android/scripts/build-release-artifacts.ts [--artifact all|play|third-party] [--dry-run] [--verify-apk PATH]",
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

  if (verifyApk && (artifact !== "all" || dryRun)) {
    throw new Error("--verify-apk cannot be combined with --artifact or --dry-run");
  }

  return { artifact, dryRun, verifyApk };
}

function pinnedApkCertificateSha256(): string {
  const manifest = JSON.parse(readFileSync(releaseSigningManifestPath, "utf8")) as {
    apkCertificateSha256?: unknown;
  };
  const fingerprint = manifest.apkCertificateSha256;
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(fingerprint)) {
    throw new Error("ReleaseSigning.json must pin apkCertificateSha256 as 64 lowercase hex digits");
  }
  return fingerprint;
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

function sha256Hex(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSha256File(path: string): string {
  const hash = sha256Hex(path);
  const checksumPath = `${path}.sha256`;
  writeFileSync(checksumPath, `${hash}  ${basename(path)}\n`);
  return hash;
}

function verifyAabSignature(path: string): void {
  execFileSync("jarsigner", ["-verify", path], { stdio: "ignore" });
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

function resolveApkSigner(): string {
  const sdkApkSigner =
    resolveApkSignerFromSdk(process.env.ANDROID_HOME) ??
    resolveApkSignerFromSdk(process.env.ANDROID_SDK_ROOT);
  if (sdkApkSigner) {
    return sdkApkSigner;
  }

  for (const pathDir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(pathDir, "apksigner");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("Missing apksigner. Install Android SDK build-tools or put apksigner on PATH.");
}

function verifyApkSignature(path: string, expectedCertificateSha256: string): void {
  const apkSigner = resolveApkSigner();
  let output: string;
  try {
    output = execFileSync(apkSigner, ["verify", "--print-certs", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    throw new Error(`apksigner verification failed for ${path}`);
  }

  const fingerprints = Array.from(
    output.matchAll(/^Signer #[0-9]+ certificate SHA-256 digest: ([a-fA-F0-9:]+)$/gmu),
    (match) => match[1].replaceAll(":", "").toLowerCase(),
  );
  if (fingerprints.length !== 1 || !/^[a-f0-9]{64}$/u.test(fingerprints[0] ?? "")) {
    throw new Error(`Expected exactly one SHA-256 signing certificate for ${path}`);
  }
  if (fingerprints[0] !== expectedCertificateSha256) {
    throw new Error(
      `APK signing certificate mismatch for ${path}: expected ${expectedCertificateSha256}, got ${fingerprints[0]}`,
    );
  }
}

function copyArtifact(sourcePath: string, destinationPath: string): void {
  if (!existsSync(sourcePath)) {
    throw new Error(`Signed release artifact missing at ${sourcePath}`);
  }

  copyFileSync(sourcePath, destinationPath);
}

function verifyArtifactSignature(
  artifact: ReleaseArtifact,
  outputPath: string,
  expectedCertificateSha256: string,
): void {
  if (artifact.kind === "aab") {
    verifyAabSignature(outputPath);
  } else {
    verifyApkSignature(outputPath, expectedCertificateSha256);
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const expectedCertificateSha256 = pinnedApkCertificateSha256();
  if (options.verifyApk) {
    verifyApkSignature(options.verifyApk, expectedCertificateSha256);
    console.log(`Verified pinned APK signing certificate: ${options.verifyApk}`);
    return;
  }

  syncAndroidVersioning({ mode: "check", rootDir });
  const version = resolveAndroidVersion(rootDir);
  const artifacts = releaseArtifacts(version.canonicalVersion).filter(
    (artifact) => options.artifact === "all" || artifact.flavorName === options.artifact,
  );

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

  mkdirSync(releaseOutputDir, { recursive: true });
  execFileSync("./gradlew", artifacts.map((artifact) => artifact.gradleTask), {
    cwd: androidDir,
    stdio: "inherit",
  });

  for (const artifact of artifacts) {
    const outputPath = join(
      releaseOutputDir,
      `openclaw-${version.canonicalVersion}-${artifact.flavorName}-release.${artifact.kind}`,
    );

    copyArtifact(artifact.sourcePath, outputPath);
    verifyArtifactSignature(artifact, outputPath, expectedCertificateSha256);
    const hash = writeSha256File(outputPath);

    console.log(`Signed ${artifact.kind.toUpperCase()} (${artifact.flavorName}): ${outputPath}`);
    console.log(`SHA-256 (${artifact.flavorName}): ${hash}`);
  }
}

main();
