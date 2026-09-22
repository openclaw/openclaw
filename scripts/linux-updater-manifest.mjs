#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isRecord } from "./lib/record-shared.mjs";
import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "./lib/release-version.mjs";
import {
  verifyReleaseToolingIdentity,
  verifyReleaseWorkflowRun,
} from "./release-tooling-identity.mjs";

function gh(args) {
  return execFileSync("gh", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
}

function releaseVersion(tag) {
  const version =
    typeof tag === "string" && tag.startsWith("v") ? parseReleaseVersion(tag.slice(1)) : null;
  return version && tag === `v${version.version}` ? version : null;
}

function regularStable(tag) {
  const version = releaseVersion(tag);
  return version && classifyReleaseTrain(version) === "stable";
}

function readRelease(repository, tag, optional = false) {
  let raw;
  try {
    raw = gh(
      tag
        ? [
            "release",
            "view",
            tag,
            "--repo",
            repository,
            "--json",
            "tagName,isDraft,isPrerelease,assets",
          ]
        : [
            "api",
            `repos/${repository}/releases/latest`,
            "--jq",
            "{tagName: .tag_name, isDraft: .draft, isPrerelease: .prerelease, assets: .assets}",
          ],
    );
  } catch (error) {
    if (optional && /release not found|HTTP 404/iu.test(String(error.stderr ?? ""))) {
      return null;
    }
    throw error;
  }
  const release = JSON.parse(raw.toString("utf8"));
  if (
    !isRecord(release) ||
    typeof release.tagName !== "string" ||
    typeof release.isDraft !== "boolean" ||
    typeof release.isPrerelease !== "boolean" ||
    !Array.isArray(release.assets) ||
    !release.assets.every((asset) => isRecord(asset) && typeof asset.name === "string") ||
    (tag && release.tagName !== tag)
  ) {
    throw new Error("GitHub returned invalid release metadata.");
  }
  return release;
}

function publicStable(release) {
  return release && regularStable(release.tagName) && !release.isDraft && !release.isPrerelease;
}

function downloadAsset(repository, tag, name = "latest.json") {
  return gh(["release", "download", tag, "--repo", repository, "--pattern", name, "--output", "-"]);
}

function verifyManifestSource(repository, manifest, allowDraftTag) {
  const source = readRelease(repository, manifest.sourceTag);
  const assets = source.assets.filter((asset) => asset.name === manifest.assetName);
  if (
    (!publicStable(source) &&
      !(
        source.tagName === allowDraftTag &&
        regularStable(source.tagName) &&
        !source.isPrerelease
      )) ||
    assets.length !== 1 ||
    assets[0].state !== "uploaded" ||
    !Number.isSafeInteger(assets[0].size) ||
    assets[0].size <= 0
  ) {
    throw new Error(
      `Linux manifest source ${manifest.sourceTag} must have its published AppImage.`,
    );
  }
}

function readManifest(repository, carrier, allowDraftTag, name = "latest.json") {
  const assets = carrier.assets.filter((asset) => asset.name === name);
  if (assets.length === 0) {
    return null;
  }
  if (assets.length !== 1) {
    throw new Error(`Release ${carrier.tagName} has ambiguous Linux manifests.`);
  }
  const bytes = downloadAsset(repository, carrier.tagName, name);
  const value = JSON.parse(bytes.toString("utf8"));
  const version = isRecord(value) ? value.version : undefined;
  if (typeof version !== "string") {
    throw new Error(`Release ${carrier.tagName} has no canonical Linux updater version.`);
  }
  const sourceTag = `v${version}`;
  const platform = isRecord(value?.platforms) ? value.platforms["linux-x86_64"] : undefined;
  const assetName = `OpenClaw-${version}-amd64.AppImage`;
  const url = `https://github.com/${repository}/releases/download/${sourceTag}/${assetName}`;
  const canonicalChannel =
    carrier.tagName === "linux-stable" && !carrier.isDraft && carrier.isPrerelease;
  if (
    !regularStable(sourceTag) ||
    (!canonicalChannel &&
      (!regularStable(carrier.tagName) ||
        compareReleaseVersions(version, carrier.tagName.slice(1)) > 0)) ||
    (name !== "latest.json" &&
      (name !== `OpenClaw-${version}-linux.json` || carrier.tagName !== sourceTag)) ||
    !isRecord(platform) ||
    Object.keys(value.platforms).length !== 1 ||
    typeof platform.signature !== "string" ||
    platform.signature.length === 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(platform.signature) ||
    platform.url !== url
  ) {
    throw new Error(`Release ${carrier.tagName} has a noncanonical Linux updater manifest.`);
  }
  const manifest = { bytes, version, sourceTag, assetName, value };
  verifyManifestSource(repository, manifest, allowDraftTag);
  return manifest;
}

function readImmutableManifest(repository, source) {
  const name = `OpenClaw-${source.tagName.slice(1)}-linux.json`;
  const manifest = readManifest(repository, source, undefined, name);
  if (!manifest) {
    return null;
  }
  const current = JSON.parse(
    gh(["api", `repos/${repository}/releases/tags/${source.tagName}`]).toString("utf8"),
  );
  if (
    !isRecord(current) ||
    current.tag_name !== source.tagName ||
    current.draft !== false ||
    current.prerelease !== false ||
    !Number.isSafeInteger(current.id) ||
    current.id < 1 ||
    !Array.isArray(current.assets) ||
    !current.assets.every((entry) => isRecord(entry) && typeof entry.name === "string")
  ) {
    throw new Error("GitHub returned invalid immutable Linux release identity.");
  }
  const proof = manifest.value.linuxPublication;
  const expected = [
    manifest.assetName,
    `OpenClaw-${manifest.version}-amd64.deb`,
    "SHA256SUMS.linux-app.txt",
    ...(proof?.assets?.length === 6
      ? [
          `OpenClaw-${manifest.version}-darwin-aarch64.dmg`,
          `OpenClaw-${manifest.version}-darwin-aarch64.app.tar.gz`,
          `OpenClaw-${manifest.version}-windows-x86_64.exe`,
        ]
      : []),
  ];
  const metadata = current.assets.filter((entry) => entry.name === name);
  if (
    !publicStable(source) ||
    !isRecord(proof) ||
    proof.schemaVersion !== 1 ||
    !["sourceSha", "toolingSha", "channelSha"].every((key) => /^[a-f0-9]{40}$/u.test(proof[key])) ||
    !/^[a-f0-9]{64}$/u.test(proof.publicKeySha256) ||
    !Number.isSafeInteger(proof.releaseId) ||
    proof.releaseId < 1 ||
    proof.releaseId !== current.id ||
    !Array.isArray(proof.assets) ||
    proof.assets.length !== expected.length ||
    !expected.every(
      (assetName) => proof.assets.filter((entry) => entry.name === assetName).length === 1,
    ) ||
    metadata.length !== 1 ||
    metadata[0].state !== "uploaded" ||
    metadata[0].size !== manifest.bytes.length ||
    metadata[0].digest !== `sha256:${hash(manifest.bytes)}`
  ) {
    throw new Error("Immutable Linux publication identity or metadata digest is invalid.");
  }
  for (const entry of proof.assets) {
    const matches = current.assets.filter((asset) => asset.name === entry.name);
    if (
      !Number.isSafeInteger(entry.id) ||
      entry.id < 1 ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 1 ||
      !/^[a-f0-9]{64}$/u.test(entry.sha256) ||
      matches.length !== 1 ||
      matches[0].id !== entry.id ||
      matches[0].state !== "uploaded" ||
      matches[0].size !== entry.size ||
      matches[0].digest !== `sha256:${entry.sha256}`
    ) {
      throw new Error("Immutable Linux publication differs from its public asset inventory.");
    }
  }
  const sourceSha = gh(["api", `repos/${repository}/commits/${source.tagName}`, "--jq", ".sha"])
    .toString("utf8")
    .trim();
  if (sourceSha !== proof.sourceSha) {
    throw new Error("Immutable Linux publication source changed.");
  }
  inspectLinuxSourceAssets(repository, source, manifest);
  return manifest;
}

function verifyAuthority(options) {
  const runId = process.env.GITHUB_RUN_ID ?? "";
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? "";
  const prepared = Boolean(options["publication-request"]);
  const workflowPath = prepared
    ? ".github/workflows/openclaw-release-promote.yml"
    : ".github/workflows/openclaw-release-publish.yml";
  const common = { repository: options.repository, workflowSha: process.env.GITHUB_WORKFLOW_SHA };

  if (!prepared) {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error("Actions event payload is required for Linux manifest publication.");
    }
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (event?.inputs?.tag !== options.tag || event?.inputs?.npm_dist_tag !== "latest") {
      throw new Error("Actions release inputs differ from the Linux manifest operation.");
    }
  }
  let parent = {};
  if (prepared) {
    const request = JSON.parse(readFileSync(options["publication-request"], "utf8"));
    if (
      request.repository !== options.repository ||
      request.inputs?.tag !== options.tag ||
      (options["source-sha"] && request.sourceSha !== options["source-sha"])
    ) {
      throw new Error("Publication request differs from the Linux manifest operation.");
    }
    parent = {
      releasePublishRunId: String(request.releaseRunId ?? ""),
      releasePublishRunAttempt: String(request.releaseRunAttempt ?? ""),
      releasePublishRef: request.tooling?.ref,
      releasePublishFullRef: request.tooling?.fullRef,
      releasePublishParentStatePolicy: "active-or-success",
    };
  }
  if (options["source-sha"]) {
    const actual = gh(["api", `repos/${options.repository}/commits/${options.tag}`, "--jq", ".sha"])
      .toString("utf8")
      .trim();
    if (actual !== options["source-sha"]) {
      throw new Error(`Release tag ${options.tag} moved before Linux manifest publication.`);
    }
  }
  const identity = verifyReleaseToolingIdentity({
    repository: options.repository,
    workflowRef: process.env.GITHUB_REF_NAME,
    workflowFullRef: process.env.GITHUB_REF,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
    ...parent,
  });
  verifyReleaseWorkflowRun({
    ...common,
    runId,
    runAttempt,
    workflowPath,
    workflowEvent: "workflow_dispatch",
    workflowRef: process.env.GITHUB_REF_NAME,
    workflowFullRef: process.env.GITHUB_REF,
    runStatePolicy: "active",
  });
  return identity;
}

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function uploadManifest(options, destination, current, candidate, latest, record) {
  const candidatePath = join(options.output, "latest.json");
  writeFileSync(candidatePath, candidate.bytes, { flag: "wx" });
  if (current) {
    writeFileSync(join(options.output, "previous.json"), current.bytes, { flag: "wx" });
  }
  record({
    state: "prepared",
    destinationTag: destination.tagName,
    sourceTag: candidate.sourceTag,
    version: candidate.version,
    manifestSha256: hash(candidate.bytes),
    previousManifestSha256: current ? hash(current.bytes) : null,
  });

  // Callers share one publication concurrency group; these rereads also catch
  // manual release changes before this writer replaces the carried manifest.
  const liveLatest = readRelease(options.repository);
  if (liveLatest.tagName !== latest.tagName) {
    throw new Error("GitHub latest changed before Linux manifest publication.");
  }
  const liveDestination =
    destination.tagName === liveLatest.tagName
      ? liveLatest
      : readRelease(options.repository, destination.tagName);
  if (!publicStable(liveLatest) || liveDestination.isPrerelease) {
    throw new Error("Release eligibility changed before Linux manifest publication.");
  }
  const liveManifest = readManifest(
    options.repository,
    liveDestination,
    options.command === "carry" ? destination.tagName : undefined,
  );
  if (
    Boolean(current) !== Boolean(liveManifest) ||
    (current && !current.bytes.equals(liveManifest.bytes))
  ) {
    throw new Error("Destination Linux manifest changed before publication.");
  }
  verifyManifestSource(options.repository, candidate);
  record({ state: "uploading" });
  verifyAuthority(options);

  let uploadError;
  try {
    gh([
      "release",
      "upload",
      destination.tagName,
      candidatePath,
      "--repo",
      options.repository,
      "--clobber",
    ]);
  } catch (error) {
    uploadError = error;
  }
  // A failed command may have uploaded successfully. Reconcile exact bytes
  // once; never repeat an uncertain write or rebuild the signed bundle.
  let remote;
  try {
    remote = downloadAsset(options.repository, destination.tagName);
  } catch (error) {
    throw new Error(
      "Linux manifest upload could not be reconciled; inspect retained evidence before retrying.",
      {
        cause: error,
      },
    );
  }
  if (!remote.equals(candidate.bytes)) {
    throw new Error(
      "Linux manifest upload readback differs; inspect retained evidence before retrying.",
      {
        cause: uploadError,
      },
    );
  }
  record({ state: uploadError ? "reconciled" : "uploaded" });
}

function carry(options, record) {
  const target = readRelease(options.repository, options.tag);
  if (target.isPrerelease) {
    throw new Error("Cannot carry the stable Linux manifest into a prerelease.");
  }
  const current = readManifest(options.repository, target, target.tagName);
  const latest = readRelease(options.repository, undefined, true);
  const previous = publicStable(latest) ? readManifest(options.repository, latest) : null;
  if (!previous || (current && compareReleaseVersions(current.version, previous.version) >= 0)) {
    record({
      state: current ? "unchanged" : "pending",
      reason: current
        ? "Target already has the newest usable Linux manifest."
        : "No previous Linux manifest is available.",
    });
    return;
  }
  if (compareReleaseVersions(previous.version, options.tag.slice(1)) > 0) {
    throw new Error("Cannot carry a Linux version newer than the target release.");
  }
  uploadManifest(options, target, current, previous, latest, record);
}

function inspectLinuxSourceAssets(repository, source, manifest) {
  const version = source.tagName.slice(1);
  const appimage = `OpenClaw-${version}-amd64.AppImage`;
  const deb = `OpenClaw-${version}-amd64.deb`;
  const checksumsName = "SHA256SUMS.linux-app.txt";
  const nativeAssets = source.assets.filter(
    (asset) =>
      asset.name === checksumsName ||
      (asset.name.startsWith(`OpenClaw-${version}-`) && /\.(?:AppImage|deb)$/u.test(asset.name)),
  );
  if (nativeAssets.length === 0 && (!manifest || manifest.sourceTag !== source.tagName)) {
    return null;
  }
  if (
    !publicStable(source) ||
    !manifest ||
    manifest.sourceTag !== source.tagName ||
    nativeAssets.length !== 3 ||
    ![appimage, deb, checksumsName].every((name) =>
      nativeAssets.some((asset) => asset.name === name),
    )
  ) {
    throw new Error(
      "Linux release assets are partial or inconsistent; inspect them before requesting another build.",
    );
  }
  const checksumBytes = downloadAsset(repository, source.tagName, checksumsName);
  const checksums = new Map();
  for (const line of checksumBytes.toString("utf8").trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64}) [ *](?:\.\/)?([A-Za-z0-9._-]+)$/u.exec(line);
    if (!match || checksums.has(match[2])) {
      throw new Error("Linux release checksums are malformed or duplicated.");
    }
    checksums.set(match[2], match[1]);
  }
  for (const name of [appimage, deb]) {
    const asset = nativeAssets.find((entry) => entry.name === name);
    if (!checksums.has(name) || asset.digest !== `sha256:${checksums.get(name)}`) {
      throw new Error(`Linux release checksum for ${name} differs from its GitHub asset digest.`);
    }
  }
  return { checksumBytes, checksumsName };
}

export function inspectLinuxUpdaterManifest({ repository, carrierTag }) {
  const carrier = readRelease(repository, carrierTag);
  const immutable = readImmutableManifest(repository, carrier);
  const manifest = readManifest(repository, carrier);
  if (!manifest) {
    return immutable
      ? {
          carrierTag,
          immutableManifest: {
            name: `OpenClaw-${immutable.version}-linux.json`,
            sha256: hash(immutable.bytes),
          },
        }
      : null;
  }
  const source = readRelease(repository, manifest.sourceTag);
  const publication = inspectLinuxSourceAssets(repository, source, manifest);
  const currentCarrier = readRelease(repository, carrierTag);
  const selectors = currentCarrier.assets.filter((asset) => asset.name === "latest.json");
  const manifestSha256 = hash(manifest.bytes);
  if (
    !publicStable(currentCarrier) ||
    !publication ||
    selectors.length !== 1 ||
    selectors[0].state !== "uploaded" ||
    !Number.isSafeInteger(selectors[0].size) ||
    selectors[0].size <= 0 ||
    selectors[0].digest !== `sha256:${manifestSha256}`
  ) {
    throw new Error("Linux updater observation does not match the published carrier asset digest.");
  }
  return {
    carrierTag,
    manifestSha256,
    sourceVersion: manifest.version,
    ...(immutable
      ? {
          immutableManifest: {
            name: `OpenClaw-${immutable.version}-linux.json`,
            sha256: hash(immutable.bytes),
          },
        }
      : {}),
  };
}

function status(options, record) {
  const source = readRelease(options.repository, options.tag);
  const immutable = readImmutableManifest(options.repository, source);
  const manifest = immutable ?? readManifest(options.repository, source);
  const publication = inspectLinuxSourceAssets(options.repository, source, manifest);
  if (!publication) {
    record({
      state: "pending",
      assetsComplete: false,
      reason: "No Linux bundles have been published for this tag.",
    });
    return;
  }
  const version = options.tag.slice(1);
  const channel = readRelease(options.repository, "linux-stable", true);
  const canonical = channel ? readManifest(options.repository, channel) : null;
  if (canonical) {
    const canonicalSource = readRelease(options.repository, canonical.sourceTag);
    const published = readImmutableManifest(options.repository, canonicalSource);
    const channelSha = gh([
      "api",
      `repos/${options.repository}/commits/linux-stable`,
      "--jq",
      ".sha",
    ])
      .toString("utf8")
      .trim();
    if (
      !published ||
      !published.bytes.equals(canonical.bytes) ||
      published.value.linuxPublication.channelSha !== channelSha
    ) {
      throw new Error("Canonical Linux metadata differs from its immutable publication.");
    }
  }
  const needsChannelPublication =
    !immutable || !canonical || compareReleaseVersions(canonical.version, version) < 0;
  if (
    immutable &&
    canonical &&
    canonical.version === version &&
    !canonical.bytes.equals(immutable.bytes)
  ) {
    throw new Error("Same-version canonical Linux metadata conflicts with immutable publication.");
  }
  const latest = readRelease(options.repository, undefined, true);
  let needsUpdaterPublication = false;
  if (publicStable(latest) && compareReleaseVersions(version, latest.tagName.slice(1)) <= 0) {
    const current = readManifest(options.repository, latest);
    const selected = canonical ?? manifest;
    needsUpdaterPublication =
      !current ||
      compareReleaseVersions(current.version, selected.version) < 0 ||
      (current.version === selected.version && !current.bytes.equals(selected.bytes));
  }
  writeFileSync(join(options.output, "latest.json"), manifest.bytes, { flag: "wx" });
  writeFileSync(join(options.output, publication.checksumsName), publication.checksumBytes, {
    flag: "wx",
  });
  record({
    state: "published",
    assetsComplete: true,
    version,
    manifestSha256: hash(manifest.bytes),
    needsUpdaterPublication,
    needsChannelPublication,
  });
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(
      ["tag", "repository", "output", "publication-request", "source-sha"].map((name) => [
        name,
        { type: "string" },
      ]),
    ),
  });
  if (
    positionals.length !== 1 ||
    !["carry", "status"].includes(positionals[0]) ||
    !values.output ||
    !values.repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(values.repository) ||
    !releaseVersion(values.tag) ||
    (values["source-sha"] && !/^[a-f0-9]{40}$/u.test(values["source-sha"]))
  ) {
    throw new Error(
      "Usage: linux-updater-manifest.mjs <carry|status> --tag vYYYY.M.PATCH --repository owner/repo --output DIR [--publication-request FILE] [--source-sha SHA]",
    );
  }
  const options = { ...values, output: resolve(values.output), command: positionals[0] };
  mkdirSync(options.output, { recursive: true });
  const evidencePath = join(options.output, "evidence.json");
  const evidence = {
    command: options.command,
    repository: options.repository,
    tag: options.tag,
    state: "checking",
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  const record = (update) => {
    Object.assign(evidence, update);
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  };
  try {
    if (!regularStable(options.tag)) {
      record({
        state: "skipped",
        reason: "Only regular stable releases use this Linux update channel.",
      });
    } else if (options.command === "carry") {
      carry(options, record);
    } else if (options.command === "status") {
      status(options, record);
    }
  } catch (error) {
    record({ state: "failed", error: error.message });
    throw error;
  }
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    console.error(`linux-updater-manifest: ${error.message}`);
    process.exitCode = 1;
  }
}
