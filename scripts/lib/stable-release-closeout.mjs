import { createHash } from "node:crypto";
import {
  canonicalJson,
  releasePolicySha256,
  sha256Hex,
  validateArtifactDescriptor,
  validatePostpublishEvidence,
  validatePublishManifest,
} from "./release-policy-evidence.mjs";
import { validateStrictPublishPolicy } from "./release-version-policy.mjs";
import { stableReleaseLinesSha256, validateStableReleaseLines } from "./stable-release-lines.mjs";

const STABLE_RELEASE_TAG_RE = /^v(?<version>\d{4}\.\d{1,2}\.\d{1,2})(?:-[1-9]\d*)?$/u;
const MAX_ROLLBACK_DRILL_AGE_MS = 90 * 24 * 60 * 60 * 1000;

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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function strictFailure(error) {
  return {
    errors: [error instanceof Error ? error.message : String(error)],
    manifest: null,
  };
}

export function parseStableReleaseTag(tag) {
  return parseStableReleaseTagDetails(tag).baseVersion;
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

function readSelectedAppcastRelease(appcast) {
  const item = /<item\b[^>]*>([\s\S]*?)<\/item>/iu.exec(appcast)?.[1] ?? null;
  if (item === null) {
    return null;
  }
  const version =
    /<sparkle:shortVersionString>\s*([^<]+?)\s*<\/sparkle:shortVersionString>/iu.exec(item)?.[1] ??
    null;
  const enclosure = /<enclosure\b[^>]*\burl=(['"])(.*?)\1/iu.exec(item)?.[2] ?? null;
  return { version, enclosure };
}

function isCloseoutEvidenceAsset(assetName, tag) {
  const releaseVersion = tag.slice(1);
  return (
    assetName === `openclaw-${releaseVersion}-stable-main-closeout.json` ||
    assetName === `openclaw-${releaseVersion}-stable-main-closeout.json.sha256`
  );
}

function parseRollbackDrillDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? parsed.getTime()
    : null;
}

function verifyRollbackDrill(params, errors) {
  if (!params.rollbackDrillId?.trim()) {
    errors.push("rollback drill id is required.");
  }

  const drillDateMs = parseRollbackDrillDate(params.rollbackDrillDate);
  if (drillDateMs === null) {
    errors.push(`rollback drill date is invalid: ${params.rollbackDrillDate ?? "<missing>"}.`);
    return;
  }

  const ageMs = params.nowMs - drillDateMs;
  if (ageMs < 0) {
    errors.push(`rollback drill date is in the future: ${params.rollbackDrillDate}.`);
  } else if (!params.allowStaleRollbackDrill && ageMs > MAX_ROLLBACK_DRILL_AGE_MS) {
    errors.push(
      `rollback drill is older than 90 days: ${params.rollbackDrillDate}. Run the private rollback drill before stable closeout.`,
    );
  }
}

export function verifyStableMainCloseout(params) {
  const { baseVersion, tagVersion } = parseStableReleaseTagDetails(params.tag);
  const errors = [];
  const mainVersion = readVersion(params.mainPackageJson, "main", errors);
  const tagPackageVersion = readVersion(params.tagPackageJson, "release tag", errors);
  const fallbackCorrection =
    tagVersion !== baseVersion && mainVersion === baseVersion && tagPackageVersion === baseVersion;
  const version = fallbackCorrection ? baseVersion : tagVersion;

  if (mainVersion && mainVersion !== version) {
    errors.push(
      `main package.json version is ${mainVersion}, expected shipped version ${version}.`,
    );
  }
  if (tagPackageVersion && tagPackageVersion !== version) {
    errors.push(
      `release tag package.json version is ${tagPackageVersion}, expected shipped version ${version}.`,
    );
  }

  const mainChangelog = extractStableChangelogSection(params.mainChangelog, version);
  const tagChangelog = extractStableChangelogSection(params.tagChangelog, version);
  if (!mainChangelog) {
    errors.push(`main CHANGELOG.md is missing the ## ${version} section.`);
  }
  if (!tagChangelog) {
    errors.push(`release tag CHANGELOG.md is missing the ## ${version} section.`);
  }
  if (mainChangelog && tagChangelog && mainChangelog !== tagChangelog) {
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
  const expectedMacAssets = [
    `OpenClaw-${macAssetVersion}.zip`,
    `OpenClaw-${macAssetVersion}.dmg`,
    `OpenClaw-${macAssetVersion}.dSYM.zip`,
  ];
  const assetNames = new Set(readReleaseAssets(params.release).map((asset) => asset.name));
  const missingMacAssets = expectedMacAssets.filter((asset) => !assetNames.has(asset));
  if (missingMacAssets.length > 0) {
    errors.push(
      `GitHub release ${params.tag} is missing required macOS asset(s): ${missingMacAssets.join(", ")}.`,
    );
  } else {
    const macZip = expectedMacAssets[0];
    if (!params.mainAppcast.includes(`/releases/download/${params.tag}/${macZip}`)) {
      errors.push(`main appcast.xml does not point at ${macZip} from ${params.tag}.`);
    }
  }

  verifyRollbackDrill(params, errors);

  if (errors.length > 0) {
    return { errors, manifest: null };
  }

  return {
    errors,
    manifest: {
      version: 1,
      releaseTag: params.tag,
      releaseVersion: version,
      releaseTagSha: params.releaseTagSha,
      mainSha: params.mainSha,
      mainPackageVersion: mainVersion,
      releaseTagPackageVersion: tagPackageVersion,
      changelogSha256: sha256(mainChangelog),
      appcastSha256: sha256(params.mainAppcast),
      fullReleaseValidationRunId: params.fullReleaseValidationRunId,
      releasePublishRunId: params.releasePublishRunId,
      rollbackDrill: {
        id: params.rollbackDrillId,
        date: params.rollbackDrillDate,
      },
      githubReleaseAssets: readReleaseAssets(params.release)
        .filter((asset) => !isCloseoutEvidenceAsset(asset.name, params.tag))
        .map((asset) => ({
          name: asset.name,
          digest: typeof asset.digest === "string" ? asset.digest : null,
        })),
    },
  };
}

function matchingStableLine(metadata, version) {
  const [year, month] = version.split(".");
  return metadata.lines.find((line) => line.month === `${year}.${Number(month)}`) ?? null;
}

function verifyStableLineCandidate(metadata, policy, releaseClass, errors) {
  const line = matchingStableLine(metadata, policy.releaseVersion);
  if (line === null) {
    errors.push(`stable lines metadata does not contain ${policy.releaseVersion}.`);
    return null;
  }
  const selectedRef = `refs/heads/${line.branch}`;
  if (selectedRef !== policy.authorizedSourceRef) {
    errors.push(
      `metadata-selected stable ref ${selectedRef} does not match release policy ${policy.authorizedSourceRef}.`,
    );
  }

  const patch = Number(policy.releaseVersion.split(".")[2]);
  if (releaseClass === "stable-base") {
    if (
      patch !== 33 ||
      line.baseVersion !== policy.releaseVersion ||
      line.status !== "planned" ||
      line.publishedVersions.length !== 0
    ) {
      errors.push(
        `stable-base ${policy.releaseVersion} requires the matching unrecorded planned .33 line.`,
      );
    }
  } else {
    const expectedPatch = 33 + line.publishedVersions.length;
    if (
      line.status !== "active" ||
      line.publishedVersions.length === 0 ||
      patch !== expectedPatch ||
      line.publishedVersions.includes(policy.releaseVersion)
    ) {
      errors.push(
        `stable-patch ${policy.releaseVersion} must be the next unrecorded patch on the matching active line.`,
      );
    }
  }
  return line;
}

function verifyStrictDescriptors(params, publishManifest, postpublish, errors) {
  const publishDescriptor = validateArtifactDescriptor(
    params.publishDescriptor,
    "publishDescriptor",
  );
  const postpublishDescriptor = validateArtifactDescriptor(
    params.postpublishDescriptor,
    "postpublishDescriptor",
  );
  const expectedPublishArtifact = `release-publish-manifest-${publishDescriptor.runId}-${publishDescriptor.runAttempt}`;
  if (publishDescriptor.artifactName !== expectedPublishArtifact) {
    errors.push(`publish descriptor artifactName must be ${expectedPublishArtifact}.`);
  }
  if (publishDescriptor.payloadSha256 !== sha256Hex(params.publishManifestBytes)) {
    errors.push("publish descriptor payload digest does not match publish manifest bytes.");
  }
  if (
    publishDescriptor.runId !== publishManifest.execution.runId ||
    publishDescriptor.runAttempt !== publishManifest.execution.runAttempt
  ) {
    errors.push("publish descriptor run does not match publish execution.");
  }

  const expectedPostpublishArtifact = `openclaw-release-postpublish-evidence-v${publishManifest.releasePolicy.releaseVersion}`;
  if (postpublishDescriptor.artifactName !== expectedPostpublishArtifact) {
    errors.push(`postpublish descriptor artifactName must be ${expectedPostpublishArtifact}.`);
  }
  if (postpublishDescriptor.payloadSha256 !== sha256Hex(params.postpublishEvidenceBytes)) {
    errors.push("postpublish descriptor payload digest does not match postpublish evidence bytes.");
  }
  if (
    postpublishDescriptor.runId !== postpublish.releasePublishRunId ||
    postpublishDescriptor.runAttempt !== postpublish.releasePublishRunAttempt
  ) {
    errors.push("postpublish descriptor run does not match postpublish evidence.");
  }
  if (!sameJson(postpublish.publishManifest, publishDescriptor)) {
    errors.push("postpublish publishManifest descriptor does not match publish descriptor.");
  }
  return { publishDescriptor, postpublishDescriptor };
}

/**
 * Builds the strict v2 closeout. Identity and selector checks intentionally
 * finish before release assets or rollback state are inspected.
 */
export function verifyStrictStableMainCloseout(params) {
  let publishManifest;
  let postpublish;
  let metadata;
  let strictPolicy;
  let descriptors;
  const errors = [];
  try {
    publishManifest = validatePublishManifest(params.publishManifest);
    postpublish = validatePostpublishEvidence(params.postpublishEvidence);
    strictPolicy = validateStrictPublishPolicy({
      version: publishManifest.releasePolicy.releaseVersion,
      releaseSelector: publishManifest.releasePolicy.releaseSelector,
    });
    descriptors = verifyStrictDescriptors(params, publishManifest, postpublish, errors);
  } catch (error) {
    return strictFailure(error);
  }

  const policy = publishManifest.releasePolicy;
  const stablePolicyRejected =
    policy.policyMode !== "strict" ||
    (strictPolicy.releaseClass !== "stable-base" && strictPolicy.releaseClass !== "stable-patch") ||
    policy.releaseClass !== strictPolicy.releaseClass ||
    policy.releaseSelector !== "stable" ||
    policy.publishEligible !== true;
  if (stablePolicyRejected) {
    errors.push(
      "strict stable closeout requires a publishable stable-base or stable-patch policy with selector stable.",
    );
    return { errors, manifest: null };
  }
  try {
    metadata = validateStableReleaseLines(params.stableLines);
  } catch (error) {
    return strictFailure(error);
  }
  if (params.tag !== `v${policy.releaseVersion}`) {
    errors.push(
      `release tag ${params.tag} does not match release policy ${policy.releaseVersion}.`,
    );
  }
  if (params.policyMainSha !== policy.policySource.sha) {
    errors.push("policy-main SHA does not match releasePolicy.policySource.sha.");
  }
  if (params.stableSourceSha !== publishManifest.target.authorizedSourceTipSha) {
    errors.push("stable-source SHA does not match the recorded authorized source tip.");
  }
  if (params.releaseTagSha !== publishManifest.target.targetSha) {
    errors.push("release-tag SHA does not match the recorded publish target.");
  }
  if (
    publishManifest.target.targetRef !== `refs/tags/${params.tag}` ||
    publishManifest.target.releaseTag !== params.tag
  ) {
    errors.push("publish target ref and tag do not match the requested release tag.");
  }
  if (policy.policySource.blobs.stableLinesSha256 !== stableReleaseLinesSha256(metadata)) {
    errors.push("stable lines bytes do not match the release policy digest.");
  }
  verifyStableLineCandidate(metadata, policy, strictPolicy.releaseClass, errors);

  if (!sameJson(postpublish.releasePolicy, policy)) {
    errors.push("postpublish releasePolicy does not match publish releasePolicy.");
  }
  const policyDigest = releasePolicySha256(policy);
  if (
    publishManifest.releasePolicySha256 !== policyDigest ||
    postpublish.releasePolicySha256 !== policyDigest
  ) {
    errors.push("publish or postpublish releasePolicySha256 does not match policy bytes.");
  }
  if (
    postpublish.releaseVersion !== policy.releaseVersion ||
    postpublish.releaseTag !== params.tag
  ) {
    errors.push("postpublish release identity does not match release policy.");
  }
  if (!sameJson(postpublish.changelogEvidence, publishManifest.changelogEvidence)) {
    errors.push("postpublish changelogEvidence does not match publish changelogEvidence.");
  }
  if (
    params.fullReleaseValidationRunId !== publishManifest.fullValidation.runId ||
    params.releasePublishRunId !== publishManifest.execution.runId ||
    params.releasePublishRunId !== postpublish.releasePublishRunId
  ) {
    errors.push("closeout workflow run IDs do not match publish and postpublish evidence.");
  }

  if (errors.length > 0) {
    return { errors, manifest: null };
  }

  const stableSourceVersion = readVersion(params.stableSourcePackageJson, "stable source", errors);
  const releaseTagVersion = readVersion(params.tagPackageJson, "release tag", errors);
  if (stableSourceVersion !== policy.releaseVersion) {
    errors.push(
      `stable source package.json version is ${stableSourceVersion}, expected ${policy.releaseVersion}.`,
    );
  }
  if (releaseTagVersion !== policy.releaseVersion) {
    errors.push(
      `release tag package.json version is ${releaseTagVersion}, expected ${policy.releaseVersion}.`,
    );
  }

  const stableSection = extractStableChangelogSection(
    params.stableSourceChangelog,
    policy.releaseVersion,
  );
  const tagSection = extractStableChangelogSection(params.tagChangelog, policy.releaseVersion);
  if (stableSection === null || tagSection === null) {
    errors.push(`stable source and release tag must contain ## ${policy.releaseVersion}.`);
  } else if (stableSection !== tagSection) {
    errors.push("stable source and release tag changelog sections do not exactly match.");
  }
  const changelogDigest = stableSection === null ? null : sha256Hex(stableSection);
  const changelogEvidence = publishManifest.changelogEvidence;
  if (
    changelogDigest !== null &&
    (changelogEvidence.tag !== params.tag ||
      changelogEvidence.sectionHeading !== `## ${policy.releaseVersion}` ||
      changelogEvidence.sectionSha256 !== changelogDigest)
  ) {
    errors.push("publish changelogEvidence does not match independently extracted bytes.");
  }

  if (params.release?.tagName !== params.tag) {
    errors.push(`GitHub release tag does not match ${params.tag}.`);
  }
  if (params.release?.isDraft === true || params.release?.isPrerelease === true) {
    errors.push(`GitHub release ${params.tag} must be a published final release.`);
  }
  const expectedMacAssets = [
    `OpenClaw-${policy.releaseVersion}.zip`,
    `OpenClaw-${policy.releaseVersion}.dmg`,
    `OpenClaw-${policy.releaseVersion}.dSYM.zip`,
  ];
  const releaseAssets = readReleaseAssets(params.release);
  const assetNames = new Set(releaseAssets.map((asset) => asset.name));
  const missingMacAssets = expectedMacAssets.filter((name) => !assetNames.has(name));
  if (missingMacAssets.length > 0) {
    errors.push(
      `GitHub release ${params.tag} is missing required macOS asset(s): ${missingMacAssets.join(", ")}.`,
    );
  } else {
    const selectedAppcastRelease = readSelectedAppcastRelease(params.policyMainAppcast);
    const expectedEnclosure = `https://github.com/openclaw/openclaw/releases/download/${params.tag}/${expectedMacAssets[0]}`;
    if (
      selectedAppcastRelease?.version !== policy.releaseVersion ||
      selectedAppcastRelease.enclosure !== expectedEnclosure
    ) {
      errors.push(`policy-main appcast.xml does not select ${params.tag} as its leading item.`);
    }
  }
  verifyRollbackDrill(params, errors);

  if (errors.length > 0 || changelogDigest === null) {
    return { errors, manifest: null };
  }

  return {
    errors: [],
    manifest: {
      version: 2,
      releaseTag: params.tag,
      releaseVersion: policy.releaseVersion,
      policyMainSha: params.policyMainSha,
      stableSourceSha: params.stableSourceSha,
      stableSourcePackageVersion: stableSourceVersion,
      releaseTagSha: params.releaseTagSha,
      releaseTagPackageVersion: releaseTagVersion,
      changelogSha256: changelogDigest,
      appcastSha256: sha256Hex(params.policyMainAppcast),
      fullReleaseValidationRunId: params.fullReleaseValidationRunId,
      releasePublishRunId: params.releasePublishRunId,
      rollbackDrill: {
        id: params.rollbackDrillId,
        date: params.rollbackDrillDate,
      },
      githubReleaseAssets: releaseAssets
        .filter((asset) => !isCloseoutEvidenceAsset(asset.name, params.tag))
        .map((asset) => ({
          name: asset.name,
          digest: typeof asset.digest === "string" ? asset.digest : null,
        })),
      releasePolicy: policy,
      releasePolicySha256: policyDigest,
      publishManifest: descriptors.publishDescriptor,
      postpublishEvidence: descriptors.postpublishDescriptor,
      changelogEvidence,
    },
  };
}
