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
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalAndroidWearVersionCode,
  resolveAndroidVersion,
  syncAndroidVersioning,
} from "../../../scripts/lib/android-version.ts";

type ReleaseArtifact = {
  releaseName: "play" | "third-party" | "wear";
  kind: "aab" | "apk";
  gradleTasks: string[];
  metadataApkPath?: string;
  sourcePath: string;
  versionCode: number;
};

type CliOptions = {
  artifact: "all" | ReleaseArtifact["releaseName"];
  dryRun: boolean;
  verifyApk?: string;
};

export type AndroidBuildMetadata = {
  commit: string;
  timestamp: string;
};

type ResolveAndroidBuildMetadataOptions = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  readGitCommit?: () => string;
};

const scriptDir = dirname(fileURLToPath(import.meta.url));
const androidDir = join(scriptDir, "..");
const rootDir = join(androidDir, "..", "..");
const releaseOutputDir = join(androidDir, "build", "release-artifacts");
const releaseSigningManifestPath = join(androidDir, "Config", "ReleaseSigning.json");
const fullGitCommitPattern = /^[a-f0-9]{40}$/u;
const isoUtcTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

function normalizeFullGitCommit(raw: string): string {
  const commit = raw.trim().toLowerCase();
  if (!fullGitCommitPattern.test(commit)) {
    throw new Error("Android build metadata requires a full 40-character hexadecimal Git commit");
  }
  return commit;
}

function normalizeIsoUtcTimestamp(raw: string): string {
  const timestamp = raw.trim();
  if (!isoUtcTimestampPattern.test(timestamp)) {
    throw new Error("OPENCLAW_BUILD_TIMESTAMP must be an ISO-8601 UTC timestamp");
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("OPENCLAW_BUILD_TIMESTAMP must be an ISO-8601 UTC timestamp");
  }
  const normalized = parsed.toISOString();
  if (normalized.slice(0, 19) !== timestamp.slice(0, 19)) {
    throw new Error("OPENCLAW_BUILD_TIMESTAMP must be a valid ISO-8601 UTC timestamp");
  }
  return normalized;
}

function readRepositoryCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new Error("Unable to resolve the Android release Git commit");
  }
}

export function resolveAndroidBuildMetadata(
  options: ResolveAndroidBuildMetadataOptions = {},
): AndroidBuildMetadata {
  const env = options.env ?? process.env;
  const explicitCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  let repositoryCommit: string | undefined;
  if (!explicitCommit) {
    try {
      repositoryCommit = (options.readGitCommit ?? readRepositoryCommit)().trim() || undefined;
    } catch {
      // GitHub's ambient SHA is safe only when there is no readable checkout.
    }
  }
  const commitSource = explicitCommit || repositoryCommit || env.GITHUB_SHA?.trim();
  if (!commitSource) {
    throw new Error("Unable to resolve the Android release Git commit");
  }
  const commit = normalizeFullGitCommit(commitSource);

  const configuredTimestamp = env.OPENCLAW_BUILD_TIMESTAMP?.trim();
  const timestamp = configuredTimestamp
    ? normalizeIsoUtcTimestamp(configuredTimestamp)
    : (options.now ?? (() => new Date()))().toISOString();

  return { commit, timestamp };
}

export function androidBuildMetadataGradleArgs(metadata: AndroidBuildMetadata): string[] {
  return [
    `-PopenclawBuildCommit=${metadata.commit}`,
    `-PopenclawBuildTimestamp=${metadata.timestamp}`,
  ];
}

export function verifyAndroidReleaseSource(
  expectedCommit: string,
  options: {
    rootDir?: string;
    runGit?: (args: string[], cwd: string) => string;
  } = {},
): void {
  const cwd = options.rootDir ?? rootDir;
  const runGit =
    options.runGit ??
    ((args: string[], gitCwd: string) =>
      execFileSync("git", args, {
        cwd: gitCwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }));
  let head: string;
  let status: string;
  try {
    head = normalizeFullGitCommit(runGit(["rev-parse", "HEAD"], cwd));
    status = runGit(["status", "--porcelain", "--untracked-files=all"], cwd).trim();
  } catch {
    throw new Error("Android release builds require a readable Git checkout");
  }
  if (head !== expectedCommit) {
    throw new Error(`Android release commit mismatch: metadata ${expectedCommit}, checkout ${head}`);
  }
  if (status) {
    throw new Error("Android release builds require a clean Git checkout");
  }
}

function parseArgs(argv: string[]): CliOptions {
  let artifact: CliOptions["artifact"] = "all";
  let dryRun = false;
  let verifyApk: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--artifact": {
        const value = argv[index + 1];
        if (value !== "all" && value !== "play" && value !== "third-party" && value !== "wear") {
          throw new Error("--artifact must be one of: all, play, third-party, wear");
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
            "Usage: bun apps/android/scripts/build-release-artifacts.ts [--artifact all|play|third-party|wear] [--dry-run] [--verify-apk PATH]",
            "",
            "Builds signed Phone and Wear release artifacts from apps/android/version.json.",
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

function releaseArtifacts(
  versionName: string,
  phoneVersionCode: number,
  wearVersionCode: number,
): ReleaseArtifact[] {
  return [
    {
      releaseName: "play",
      kind: "aab",
      gradleTasks: [":app:bundlePlayRelease"],
      sourcePath: join(
        androidDir,
        "app",
        "build",
        "outputs",
        "bundle",
        "playRelease",
        "app-play-release.aab",
      ),
      versionCode: phoneVersionCode,
    },
    {
      releaseName: "third-party",
      kind: "apk",
      gradleTasks: [":app:assembleThirdPartyRelease"],
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
      versionCode: phoneVersionCode,
    },
    {
      releaseName: "wear",
      kind: "aab",
      gradleTasks: [":wear:bundleRelease", ":wear:assembleRelease"],
      metadataApkPath: join(
        androidDir,
        "wear",
        "build",
        "outputs",
        "apk",
        "release",
        "OpenClaw-WearOS-release.apk",
      ),
      sourcePath: join(
        androidDir,
        "wear",
        "build",
        "outputs",
        "bundle",
        "release",
        "wear-release.aab",
      ),
      versionCode: wearVersionCode,
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

export function isVerifiedJarSignatureOutput(output: string): boolean {
  return /^jar verified\.$/mu.test(output) && !/^jar is unsigned\./mu.test(output);
}

function verifyAabSignature(path: string): void {
  let output: string;
  try {
    output = execFileSync(
      "jarsigner",
      ["-J-Duser.language=en", "-J-Duser.country=US", "-verify", "-verbose", "-certs", path],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error(`jarsigner verification failed for ${path}`);
  }
  if (!isVerifiedJarSignatureOutput(output)) {
    throw new Error(`AAB is not signed by a verified JAR signer: ${path}`);
  }
}

function resolveApkSignerFromSdk(sdkRoot: string | undefined): string | null {
  if (!sdkRoot) {
    return null;
  }

  const buildToolsDir = join(sdkRoot, "build-tools");
  if (!existsSync(buildToolsDir)) {
    return null;
  }

  const executableName = process.platform === "win32" ? "apksigner.bat" : "apksigner";
  return (
    readdirSync(buildToolsDir)
    .toSorted((left, right) => right.localeCompare(left))
      .map((version) => join(buildToolsDir, version, executableName))
      .find((candidate) => existsSync(candidate)) ?? null
  );
}

function resolveApkSigner(): string {
  const sdkApkSigner =
    resolveApkSignerFromSdk(process.env.ANDROID_HOME) ??
    resolveApkSignerFromSdk(process.env.ANDROID_SDK_ROOT);
  if (sdkApkSigner) {
    return sdkApkSigner;
  }

  const executableName = process.platform === "win32" ? "apksigner.bat" : "apksigner";
  for (const pathDir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(pathDir, executableName);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("Missing apksigner. Install Android SDK build-tools or put apksigner on PATH.");
}

function resolveApkAnalyzerFromSdk(sdkRoot: string | undefined): string | null {
  if (!sdkRoot) {
    return null;
  }

  const commandLineToolsDir = join(sdkRoot, "cmdline-tools");
  if (!existsSync(commandLineToolsDir)) {
    return null;
  }

  const executableName = process.platform === "win32" ? "apkanalyzer.bat" : "apkanalyzer";
  return (
    readdirSync(commandLineToolsDir)
    .toSorted((left, right) => {
      if (left === "latest") {
        return -1;
      }
      if (right === "latest") {
        return 1;
      }
      return right.localeCompare(left);
    })
      .map((version) => join(commandLineToolsDir, version, "bin", executableName))
      .find((candidate) => existsSync(candidate)) ?? null
  );
}

function resolveApkAnalyzer(): string {
  const sdkApkAnalyzer =
    resolveApkAnalyzerFromSdk(process.env.ANDROID_HOME) ??
    resolveApkAnalyzerFromSdk(process.env.ANDROID_SDK_ROOT);
  if (sdkApkAnalyzer) {
    return sdkApkAnalyzer;
  }

  const executableName = process.platform === "win32" ? "apkanalyzer.bat" : "apkanalyzer";
  for (const pathDir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(pathDir, executableName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Missing apkanalyzer. Install Android SDK command-line tools or put it on PATH.");
}

function verifyApkSignature(path: string, expectedCertificateSha256: string): void {
  const apkSigner = resolveApkSigner();
  let output: string;
  try {
    output = execFileSync(apkSigner, ["verify", "--print-certs", path], {
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "inherit"],
    });
  } catch {
    throw new Error(`apksigner verification failed for ${path}`);
  }

  const fingerprints: string[] = [];
  for (const match of output.matchAll(
    /^Signer #[0-9]+ certificate SHA-256 digest: ([a-fA-F0-9:]+)$/gmu,
  )) {
    const fingerprint = match[1];
    if (!fingerprint) {
      throw new Error(`Malformed SHA-256 signing certificate output for ${path}`);
    }
    fingerprints.push(fingerprint.replaceAll(":", "").toLowerCase());
  }
  if (fingerprints.length !== 1 || !/^[a-f0-9]{64}$/u.test(fingerprints[0] ?? "")) {
    throw new Error(`Expected exactly one SHA-256 signing certificate for ${path}`);
  }
  if (fingerprints[0] !== expectedCertificateSha256) {
    throw new Error(
      `APK signing certificate mismatch for ${path}: expected ${expectedCertificateSha256}, got ${fingerprints[0]}`,
    );
  }
}

function readApkManifestValue(path: string, verb: string): string {
  const apkAnalyzer = resolveApkAnalyzer();
  try {
    return execFileSync(apkAnalyzer, ["manifest", verb, path], {
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "inherit"],
    }).trim();
  } catch {
    throw new Error(`apkanalyzer manifest ${verb} failed for ${path}`);
  }
}

function verifyApkManifest(
  path: string,
  expected: { applicationId: string; versionCode: number; versionName: string },
): void {
  const actualApplicationId = readApkManifestValue(path, "application-id");
  const actualVersionName = readApkManifestValue(path, "version-name");
  const actualVersionCode = readApkManifestValue(path, "version-code");
  if (actualApplicationId !== expected.applicationId) {
    throw new Error(
      `APK application ID mismatch for ${path}: expected ${expected.applicationId}, got ${actualApplicationId}`,
    );
  }
  if (actualVersionName !== expected.versionName) {
    throw new Error(
      `APK versionName mismatch for ${path}: expected ${expected.versionName}, got ${actualVersionName}`,
    );
  }
  if (actualVersionCode !== expected.versionCode.toString()) {
    throw new Error(
      `APK versionCode mismatch for ${path}: expected ${expected.versionCode}, got ${actualVersionCode}`,
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
  versionName: string,
): void {
  if (artifact.kind === "aab") {
    verifyAabSignature(outputPath);
  } else {
    verifyApkSignature(outputPath, expectedCertificateSha256);
  }

  const metadataApkPath = artifact.metadataApkPath ?? (artifact.kind === "apk" ? outputPath : null);
  if (metadataApkPath) {
    if (metadataApkPath !== outputPath) {
      verifyApkSignature(metadataApkPath, expectedCertificateSha256);
    }
    verifyApkManifest(metadataApkPath, {
      applicationId: "ai.openclaw.app",
      versionCode: artifact.versionCode,
      versionName,
    });
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
  const wearVersionCode = canonicalAndroidWearVersionCode(
    version.versionCode,
    version.canonicalVersion,
  );
  const buildMetadata = resolveAndroidBuildMetadata();
  const artifacts = releaseArtifacts(
    version.canonicalVersion,
    version.versionCode,
    wearVersionCode,
  ).filter((artifact) => options.artifact === "all" || artifact.releaseName === options.artifact);

  console.log(`Android versionName: ${version.canonicalVersion}`);
  console.log(`Android versionCode: ${version.versionCode}`);
  console.log(`Android Wear versionCode: ${wearVersionCode}`);
  console.log(`Android build commit: ${buildMetadata.commit}`);
  console.log(`Android build timestamp: ${buildMetadata.timestamp}`);
  for (const artifact of artifacts) {
    console.log(`Release artifact: ${artifact.releaseName} ${artifact.kind}`);
    for (const gradleTask of artifact.gradleTasks) {
      console.log(`Gradle task: ${gradleTask}`);
    }
  }

  if (options.dryRun) {
    console.log("Dry run complete. No Gradle tasks were executed.");
    return;
  }

  verifyAndroidReleaseSource(buildMetadata.commit);
  mkdirSync(releaseOutputDir, { recursive: true });
  execFileSync(
    "./gradlew",
    [
      ...androidBuildMetadataGradleArgs(buildMetadata),
      ...artifacts.flatMap((artifact) => artifact.gradleTasks),
    ],
    {
      cwd: androidDir,
      stdio: "inherit",
    },
  );

  for (const artifact of artifacts) {
    const outputPath = join(
      releaseOutputDir,
      `openclaw-${version.canonicalVersion}-${artifact.releaseName}-release.${artifact.kind}`,
    );

    copyArtifact(artifact.sourcePath, outputPath);
    verifyArtifactSignature(
      artifact,
      outputPath,
      expectedCertificateSha256,
      version.canonicalVersion,
    );
    const hash = writeSha256File(outputPath);

    console.log(`Signed ${artifact.kind.toUpperCase()} (${artifact.releaseName}): ${outputPath}`);
    console.log(`SHA-256 (${artifact.releaseName}): ${hash}`);
  }
}

const isMain = process.argv[1] ? resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;
if (isMain) {
  main();
}
