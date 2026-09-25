import { createHash } from "node:crypto";
import { escapeRegExp } from "./regexp.mjs";
import { evaluateStableRollbackDrill } from "./release-publish-gates.mts";
import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "./release-version.mjs";

const STABLE_RELEASE_TAG_RE = /^v(?<version>\d{4}\.\d{1,2}\.\d{1,2})(?:-[1-9]\d*)?$/u;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;
const GIT_SHA_RE = /^[a-f0-9]{40}$/u;
const APPCAST_NEWEST_VERSION_RE =
  /<sparkle:shortVersionString>([^<]+)<\/sparkle:shortVersionString>/u;
const THIN_MAC_RELEASE_MINIMUM = "2026.9.6";

function parseStableReleaseTagDetails(tag) {
  const match = STABLE_RELEASE_TAG_RE.exec(tag);
  if (!match?.groups?.version) {
    throw new Error(`expected a stable release tag, got ${tag}`);
  }
  return {
    baseVersion: match.groups.version,
    tagVersion: tag.slice(1),
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function verifyReleaseEvidenceChecksum({ assetName, assetBytes, checksum }) {
  const entry = /^([a-f0-9]{64}) {2}([^\r\n]+)\r?\n?$/u.exec(checksum);
  if (!entry || entry[2] !== assetName || entry[1] !== sha256(assetBytes)) {
    throw new Error(`Release evidence checksum must bind exactly ${assetName} and its bytes.`);
  }
}

export function parseStableReleaseTag(tag) {
  return parseStableReleaseTagDetails(tag).baseVersion;
}

export function requiresThinMacArtifacts(tag) {
  const { tagVersion } = parseStableReleaseTagDetails(tag);
  return compareReleaseVersions(tagVersion, THIN_MAC_RELEASE_MINIMUM) >= 0;
}

function isStableMainVersionAtLeast(mainVersion, shippedVersion) {
  return (
    parseReleaseVersion(mainVersion)?.channel === "stable" &&
    (compareReleaseVersions(mainVersion, shippedVersion) ?? -1) >= 0
  );
}

// GitHub commit list entries; the first `Refs #NNN` line (or the subject) is the reason.
export function findAppcastWithdrawal(commits, version) {
  const subject = `chore(release): withdraw the ${version} macOS build from the Sparkle feed`;
  for (const entry of commits) {
    const message = entry?.commit?.message ?? "";
    if (message.split("\n", 1)[0].startsWith(subject) && GIT_SHA_RE.test(entry.sha)) {
      return { commit: entry.sha, reason: /^Refs #\d+/mu.exec(message)?.[0] ?? subject };
    }
  }
  return undefined;
}

export function extractStableChangelogSection(changelog, version) {
  const heading = new RegExp(`^## ${escapeRegExp(version)}\\n`, "mu").exec(changelog);
  if (!heading || heading.index === undefined) {
    return null;
  }

  const section = changelog.slice(heading.index);
  const nextHeading = section.slice(heading[0].length).search(/^## /mu);
  return (
    nextHeading === -1 ? section : section.slice(0, heading[0].length + nextHeading)
  ).trimEnd();
}

function readVersion(packageJson, label, errors) {
  const value = packageJson?.version;
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} package.json is missing a version.`);
    return "";
  }
  return value;
}

function readReleaseAssets(release) {
  return Array.isArray(release?.assets)
    ? release.assets.filter((asset) => asset && typeof asset.name === "string")
    : [];
}

function isSha256Hex(value) {
  return typeof value === "string" && value.length === 64 && SHA256_HEX_RE.test(value);
}

function isCanonicalAssetDigest(value) {
  return (
    typeof value === "string" &&
    value.length === 71 &&
    value.startsWith("sha256:") &&
    isSha256Hex(value.slice(7))
  );
}

function readVerifiedAssetNames(assets) {
  return new Set(
    assets.filter((asset) => isCanonicalAssetDigest(asset.digest)).map((asset) => asset.name),
  );
}

export function requiresLinuxUpdaterObservation({ release, existingManifest }) {
  return ["latest.json", `OpenClaw-${release.tagName?.slice(1)}-linux.json`].some((name) => {
    const selectors = readReleaseAssets(release).filter((asset) => asset.name === name);
    const recorded = existingManifest?.githubReleaseAssets?.find((asset) => asset.name === name);
    return (
      selectors.length > 0 &&
      (selectors.length !== 1 ||
        !isCanonicalAssetDigest(selectors[0].digest) ||
        selectors[0].digest !== recorded?.digest)
    );
  });
}

function copyOwnFields(source, ...keys) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(source, key)).map((key) => [key, source[key]]),
  );
}

function recordsEqual(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const expectedEntries = Object.entries(expected);
  return (
    Object.keys(actual).length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => actual[key] === value)
  );
}

function isCloseoutEvidenceAsset(assetName, tag) {
  const releaseVersion = tag.slice(1);
  return (
    assetName === `openclaw-${releaseVersion}-stable-main-closeout.json` ||
    assetName === `openclaw-${releaseVersion}-stable-main-closeout.json.sha256`
  );
}

export function verifyStableMainCloseout(params) {
  const { baseVersion, tagVersion } = parseStableReleaseTagDetails(params.tag);
  const errors = [];
  const mainVersion = readVersion(params.mainPackageJson, "main", errors);
  const tagPackageVersion = readVersion(params.tagPackageJson, "release tag", errors);
  const fallbackCorrection = tagVersion !== baseVersion && tagPackageVersion === baseVersion;
  const version = fallbackCorrection ? baseVersion : tagVersion;

  const fullReleaseValidationRunAttempt = params.fullReleaseValidationRunAttempt ?? "";
  if (!/^[1-9]\d*$/u.test(fullReleaseValidationRunAttempt)) {
    errors.push(
      `full release validation run attempt is invalid: ${fullReleaseValidationRunAttempt || "<missing>"}.`,
    );
  }

  if (mainVersion && !isStableMainVersionAtLeast(mainVersion, version)) {
    errors.push(
      `main package.json version is ${mainVersion}, expected shipped version ${version} or a later stable OpenClaw CalVer.`,
    );
  }
  if (tagPackageVersion && tagPackageVersion !== version) {
    errors.push(
      `release tag package.json version is ${tagPackageVersion}, expected shipped version ${version}.`,
    );
  }

  const mainChangelog =
    params.mainRelease?.section?.trimEnd() ??
    extractStableChangelogSection(params.mainChangelog, version);
  const tagChangelog =
    params.tagRelease?.section?.trimEnd() ??
    extractStableChangelogSection(params.tagChangelog, version);
  if (!mainChangelog) {
    errors.push(`main CHANGELOG.md is missing the ## ${version} section.`);
  }
  if (!tagChangelog) {
    errors.push(`release tag CHANGELOG.md is missing the ## ${version} section.`);
  }
  const mirrored = params.mainRelease?.format === "docs-mirror";
  if (
    mirrored &&
    (!params.mainRelease.record ||
      !params.tagRelease?.record ||
      params.mainRelease.record.trimEnd() !== params.tagRelease.record.trimEnd())
  ) {
    errors.push(
      `main changelog ${version} frozen contribution record does not match the shipped release accounting.`,
    );
  }
  if (!mirrored && mainChangelog && tagChangelog && mainChangelog !== tagChangelog) {
    errors.push(
      `main CHANGELOG.md ## ${version} does not exactly match the shipped release section.`,
    );
  }

  if (params.release?.tagName !== params.tag) {
    errors.push(
      `GitHub release tag is ${String(params.release?.tagName ?? "<missing>")}, expected ${params.tag}.`,
    );
  }
  if (params.release?.isDraft === true) {
    errors.push(`GitHub release ${params.tag} is still a draft.`);
  }
  if (params.release?.isPrerelease === true) {
    errors.push(`GitHub release ${params.tag} is marked as a prerelease.`);
  }

  const macAssetVersion = version;
  const universalMacAssets = [
    `OpenClaw-${macAssetVersion}.zip`,
    `OpenClaw-${macAssetVersion}.dmg`,
    `OpenClaw-${macAssetVersion}.dSYM.zip`,
  ];
  const thinMacVariants = requiresThinMacArtifacts(params.tag) ? ["arm64", "x86_64"] : [];
  const expectedMacAssets = [
    ...universalMacAssets,
    ...thinMacVariants.flatMap((arch) => [
      `OpenClaw-${macAssetVersion}-${arch}.zip`,
      `OpenClaw-${macAssetVersion}-${arch}.dmg`,
      `OpenClaw-${macAssetVersion}-${arch}.dSYM.zip`,
    ]),
  ];
  const platformAssets = {
    macos: expectedMacAssets,
    android: ["OpenClaw-Android-SHA256SUMS.txt", "OpenClaw-Android.apk"],
    windows: [
      "OpenClawCompanion-SHA256SUMS.txt",
      "OpenClawCompanion-Setup-arm64.exe",
      "OpenClawCompanion-Setup-x64.exe",
    ],
  };
  const allowedLateAssets = new Set([
    ...Object.values(platformAssets).flat(),
    `OpenClaw-${tagVersion}-amd64.AppImage`,
    `OpenClaw-${tagVersion}-amd64.deb`,
    "SHA256SUMS.linux-app.txt",
    "latest.json",
  ]);
  const observedAssets = readReleaseAssets(params.release).filter(
    (asset) => !isCloseoutEvidenceAsset(asset.name, params.tag),
  );
  const existingManifest = params.existingManifest;
  let verifiedLinuxSelector = false;
  if (requiresLinuxUpdaterObservation(params)) {
    const observation = params.linuxUpdaterObservation;
    const source =
      typeof observation?.sourceVersion === "string"
        ? parseReleaseVersion(observation.sourceVersion)
        : null;
    const sourceComparison = source ? compareReleaseVersions(source.version, tagVersion) : null;
    const selectors = observedAssets.filter((asset) => asset.name === "latest.json");
    verifiedLinuxSelector =
      selectors.length === 1 &&
      observation?.carrierTag === params.tag &&
      isSha256Hex(observation?.manifestSha256) &&
      selectors[0].digest === `sha256:${observation.manifestSha256}` &&
      source !== null &&
      source.version === observation.sourceVersion &&
      classifyReleaseTrain(source) === "stable" &&
      sourceComparison !== null &&
      sourceComparison <= 0;
    const recordedSelector = existingManifest?.githubReleaseAssets?.find(
      (asset) => asset.name === "latest.json",
    );
    if (
      selectors.length > 0 &&
      (selectors.length !== 1 ||
        !isCanonicalAssetDigest(selectors[0].digest) ||
        selectors[0].digest !== recordedSelector?.digest) &&
      !verifiedLinuxSelector
    ) {
      errors.push(
        "New or changed Linux updater selector requires a validated observation bound to this carrier and asset digest.",
      );
    }
    const immutableName = `OpenClaw-${tagVersion}-linux.json`;
    const immutable = observedAssets.filter((asset) => asset.name === immutableName);
    if (immutable.length > 0) {
      const verified =
        immutable.length === 1 &&
        observation?.carrierTag === params.tag &&
        observation?.immutableManifest?.name === immutableName &&
        isSha256Hex(observation?.immutableManifest?.sha256) &&
        immutable[0].digest === `sha256:${observation.immutableManifest.sha256}`;
      if (verified) {
        allowedLateAssets.add(immutableName);
      } else {
        errors.push(
          "Late immutable Linux metadata requires a validated exact-name and digest observation.",
        );
      }
    }
  }
  const releaseAssets =
    existingManifest?.githubReleaseAssets ??
    observedAssets.map((asset) => ({
      name: asset.name,
      digest: typeof asset.digest === "string" ? asset.digest : null,
    }));
  if (existingManifest) {
    // Keep the publication-time snapshot. Only the independently validated
    // updater selector may change; recorded bundles and evidence are immutable.
    for (const recorded of releaseAssets) {
      const observed = observedAssets.find((asset) => asset.name === recorded.name);
      if (recorded.name === "latest.json" && verifiedLinuxSelector) {
        continue;
      }
      const observedDigest =
        observed && typeof observed.digest === "string" ? observed.digest : null;
      if (!observed || observedDigest !== recorded.digest) {
        errors.push(`Recorded release asset changed or disappeared: ${recorded.name}.`);
      }
    }
    for (const observed of observedAssets) {
      if (
        !releaseAssets.some((asset) => asset.name === observed.name) &&
        !allowedLateAssets.has(observed.name)
      ) {
        errors.push(`Unexpected release asset added after closeout: ${observed.name}.`);
      }
    }
  }
  const verifiedAssetNames = readVerifiedAssetNames(releaseAssets);
  const verifiedObservedAssetNames = readVerifiedAssetNames(observedAssets);
  const macAttachedAtCloseout = expectedMacAssets.every((asset) => verifiedAssetNames.has(asset));
  const macPublished = expectedMacAssets.every((name) => verifiedObservedAssetNames.has(name));
  const appcastVerifiedAtCloseout = existingManifest
    ? existingManifest.appcast === "verified" ||
      (!Object.hasOwn(existingManifest, "appcast") &&
        Object.hasOwn(existingManifest, "appcastSha256"))
    : macAttachedAtCloseout;
  // Fresh closeout must validate the same main snapshot it hashes. Only a
  // pending recorded closeout may use the current feed for late publication.
  const feed = (name) =>
    existingManifest && !appcastVerifiedAtCloseout
      ? (params[`published${name}`] ?? params[`main${name}`])
      : params[`main${name}`];
  const appcast = feed("Appcast");
  const appcastContracts = [
    { name: "main appcast.xml", content: appcast, asset: universalMacAssets[0] },
    ...thinMacVariants.map((arch) => ({
      name: `main appcast-${arch}.xml`,
      content: feed(`${arch === "arm64" ? "Arm64" : "X86_64"}Appcast`),
      asset: `OpenClaw-${macAssetVersion}-${arch}.zip`,
    })),
  ];
  // A deliberately withdrawn macOS build keeps an older newest Sparkle entry;
  // only its explicit withdrawal commit on main replaces the feed contracts.
  const appcastWithdrawnAtCloseout = existingManifest?.appcast === "withdrawn";
  const checksAppcast =
    macPublished &&
    !appcastWithdrawnAtCloseout &&
    (!existingManifest || !appcastVerifiedAtCloseout);
  const newestAppcastVersion = APPCAST_NEWEST_VERSION_RE.exec(appcast ?? "")?.[1];
  const appcastWithdrawal =
    checksAppcast &&
    newestAppcastVersion !== undefined &&
    compareReleaseVersions(newestAppcastVersion, version) === -1
      ? params.findAppcastWithdrawal?.(version)
      : undefined;
  if (checksAppcast && !appcastWithdrawal) {
    for (const contract of appcastContracts) {
      if (!contract.content?.includes(`/releases/download/${params.tag}/${contract.asset}`)) {
        errors.push(`${contract.name} does not point at ${contract.asset} from ${params.tag}.`);
      }
    }
  }
  const appcastState = !macAttachedAtCloseout
    ? "pending"
    : (existingManifest ? appcastWithdrawnAtCloseout : appcastWithdrawal)
      ? "withdrawn"
      : "verified";
  const appPlatforms = Object.fromEntries(
    Object.entries(platformAssets).map(([platform, assets]) => [
      platform,
      platform === "macos" && appcastState === "withdrawn"
        ? "withdrawn"
        : assets.every((asset) => verifiedAssetNames.has(asset))
          ? "attached"
          : "pending",
    ]),
  );
  const apps = Object.values(appPlatforms).every((state) => state === "attached")
    ? "attached"
    : "pending";
  if (existingManifest) {
    if (
      Object.hasOwn(existingManifest, "appPlatforms") &&
      !recordsEqual(existingManifest.appPlatforms, appPlatforms)
    ) {
      errors.push("Recorded app platform states do not match canonical release asset digests.");
    }
    if (Object.hasOwn(existingManifest, "apps") && existingManifest.apps !== apps) {
      errors.push("Recorded aggregate app state does not match canonical release asset digests.");
    }
    if (Object.hasOwn(existingManifest, "appcast") && existingManifest.appcast !== appcastState) {
      errors.push("Recorded appcast state does not match canonical macOS release asset digests.");
    }
    const hasAppcastSha256 = Object.hasOwn(existingManifest, "appcastSha256");
    const hasAppcastWithdrawal = Object.hasOwn(existingManifest, "appcastWithdrawal");
    if (
      hasAppcastSha256 !== (appcastState === "verified") ||
      (hasAppcastSha256 && !isSha256Hex(existingManifest.appcastSha256)) ||
      hasAppcastWithdrawal !== (appcastState === "withdrawn") ||
      (hasAppcastWithdrawal &&
        (!GIT_SHA_RE.test(String(existingManifest.appcastWithdrawal?.commit)) ||
          typeof existingManifest.appcastWithdrawal?.reason !== "string"))
    ) {
      errors.push(
        "Recorded appcast evidence presence or format does not match canonical macOS release asset state.",
      );
    }
  }

  if (
    params.publishRecovery &&
    (!params.allowFailedPublishRecovery ||
      params.publishRecovery.mode !== "split-publication-v1" ||
      params.publishRecovery.releaseTag !== params.tag ||
      params.publishRecovery.sourceSha !== params.releaseTagSha ||
      params.publishRecovery.originalParent?.runId !== params.releasePublishRunId ||
      params.publishRecovery.fullReleaseValidation?.runId !== params.fullReleaseValidationRunId ||
      params.publishRecovery.fullReleaseValidation?.runAttempt !== fullReleaseValidationRunAttempt)
  ) {
    errors.push("Verified publication recovery does not match the closeout identity.");
  }
  if (
    params.existingManifest?.releasePublishRecovery?.mode === "split-publication-v1" &&
    JSON.stringify(params.publishRecovery) !==
      JSON.stringify(params.existingManifest.releasePublishRecovery)
  ) {
    errors.push(
      "Recorded split publication recovery must be independently reverified without changes.",
    );
  }
  errors.push(
    ...evaluateStableRollbackDrill(params)
      .filter((gate) => gate.status === "FAIL")
      .map((gate) => gate.message),
  );

  if (errors.length > 0) {
    return { errors, manifest: null };
  }

  const manifest = {
    version: 2,
    releaseTag: params.tag,
    releaseVersion: version,
    releaseTagSha: params.releaseTagSha,
    mainSha: params.mainSha,
    mainPackageVersion: mainVersion,
    releaseTagPackageVersion: tagPackageVersion,
    // This receipt binds the shipped release. Later approved docs prose may
    // evolve, while the independent frozen contribution record must not.
    changelogSha256: sha256(tagChangelog),
    ...(existingManifest
      ? copyOwnFields(
          existingManifest,
          "apps",
          "appPlatforms",
          "appcast",
          "appcastSha256",
          "appcastWithdrawal",
        )
      : {
          apps,
          appPlatforms,
          appcast: appcastState,
          ...(appcastState === "verified" ? { appcastSha256: sha256(params.mainAppcast) } : {}),
          ...(appcastState === "withdrawn" ? { appcastWithdrawal } : {}),
        }),
    fullReleaseValidationRunId: params.fullReleaseValidationRunId,
    fullReleaseValidationRunAttempt,
    releasePublishRunId: params.releasePublishRunId,
    // Operator waivers that authorized this stable travel into the closeout
    // record; a replay keeps the recorded field set byte-identical.
    ...(existingManifest
      ? copyOwnFields(existingManifest, "stableSoakWaiver", "laneWaiver")
      : {
          ...(params.stableSoakWaiver ? { stableSoakWaiver: params.stableSoakWaiver } : {}),
          ...(params.laneWaiver ? { laneWaiver: params.laneWaiver } : {}),
        }),
    ...(existingManifest
      ? copyOwnFields(existingManifest, "releasePublishRecovery")
      : params.allowFailedPublishRecovery
        ? { releasePublishRecovery: params.publishRecovery ?? { npmDockerVerified: true } }
        : {}),
    rollbackDrill: {
      id: params.rollbackDrillId,
      date: params.rollbackDrillDate,
    },
    githubReleaseAssets: releaseAssets,
  };
  if (existingManifest && JSON.stringify(manifest) !== JSON.stringify(existingManifest)) {
    return {
      errors: ["Recorded closeout manifest does not match the verified release state."],
      manifest: null,
    };
  }
  return { errors, manifest };
}
