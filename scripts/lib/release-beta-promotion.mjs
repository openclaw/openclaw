// A beta-to-final delta can reuse product proof, never publication artifacts.
import { isReleaseChangelogPath } from "./release-changelog.mjs";
import { parseReleaseVersion } from "./release-version.mjs";

export const BETA_FINAL_EVIDENCE_REUSE_POLICY = "stable-qualified-beta-final-v1";

export function isBetaPromotionPath(path, version) {
  return (
    path === "package.json" ||
    /^(?:extensions\/[a-z0-9-]+|packages\/(?:ai|gateway-client|gateway-protocol))\/package.json$/u.test(
      path,
    ) ||
    path === "scripts/lib/official-external-channel-catalog.json" ||
    path === "docs/plugins/plugin-inventory.md" ||
    path === "docs/plugins/reference.md" ||
    /^docs\/plugins\/reference\/[a-z0-9-]+\.md$/u.test(path) ||
    isReleaseChangelogPath(path, { version })
  );
}

export function classifyBetaPromotionComparison(
  comparison,
  {
    baseSha,
    targetSha,
    version,
    readSourceFile,
    readSourceFiles,
    rootManifest,
    targetCoveragePolicy,
  },
) {
  if (
    rootManifest?.releaseProfile !== "stable" ||
    rootManifest.runReleaseSoak !== "true" ||
    rootManifest.controls?.performanceBlocking !== true
  ) {
    throw new Error(
      "beta-to-final reuse requires stable qualification, soak and blocking performance",
    );
  }
  if (targetCoveragePolicy !== "npm-stable-v1") {
    throw new Error(
      "beta-to-final reuse requires final npm-stable-v1 coverage and native publication gates",
    );
  }
  const target = parseReleaseVersion(version ?? "");
  const files = comparison?.files;
  // GitHub's compare endpoint caps changed files at 300. A larger cut falls
  // back to fresh qualification rather than trusting an incomplete delta.
  if (
    target?.channel !== "stable" ||
    target.correctionNumber !== undefined ||
    target.patch >= 33 ||
    comparison?.status !== "ahead" ||
    comparison?.merge_base_commit?.sha !== baseSha ||
    !Array.isArray(files) ||
    files.length >= 300 ||
    !files.some((file) => file.filename === "package.json") ||
    new Set(files.map((file) => file.filename)).size !== files.length ||
    typeof readSourceFile !== "function"
  ) {
    throw new Error("beta-to-final reuse requires a complete same-base version-only descendant");
  }
  const headSha = targetSha;
  if (!/^[a-f0-9]{40}$/u.test(headSha ?? "")) {
    throw new Error("beta-to-final comparison omitted its exact head commit");
  }
  const sourcePackage = readSourceFile(baseSha, "package.json");
  const sourceVersion = JSON.parse(sourcePackage).version;
  const source = parseReleaseVersion(sourceVersion ?? "");
  if (source?.channel !== "beta" || source.baseVersion !== version) {
    throw new Error("beta-to-final reuse requires the corresponding beta package version");
  }
  if (rootManifest.validationInputs?.targetVersion !== sourceVersion) {
    throw new Error("beta-to-final evidence versions differ from their source packages");
  }
  for (const file of files) {
    const path = file.filename;
    const notes = isReleaseChangelogPath(path, { version });
    if (
      !isBetaPromotionPath(path, version) ||
      file.previous_filename ||
      !(notes ? ["added", "modified"] : ["modified"]).includes(file.status)
    ) {
      throw new Error("beta-to-final reuse contains a product change: " + path);
    }
  }
  const requests = files
    .filter((file) => !isReleaseChangelogPath(file.filename, { version }))
    .flatMap((file) => [baseSha, headSha].map((sha) => ({ sha, path: file.filename })));
  const sources = readSourceFiles?.(requests);
  for (const file of files) {
    const path = file.filename;
    if (isReleaseChangelogPath(path, { version })) {
      continue;
    }
    const before = sources
      ? sources.get(baseSha + ":" + path)
      : path === "package.json"
        ? sourcePackage
        : readSourceFile(baseSha, path);
    const after = sources ? sources.get(headSha + ":" + path) : readSourceFile(headSha, path);
    if (path.endsWith("/package.json") || path === "package.json") {
      const expected = JSON.parse(before);
      const actual = JSON.parse(after);
      if (expected.version !== sourceVersion || actual.version !== version) {
        throw new Error("beta-to-final package version mismatch: " + path);
      }
      expected.version = version;
      // These are the alignment fields owned by sync-plugin-versions.ts.
      for (const [object, key] of [
        [expected.devDependencies, "openclaw"],
        [expected.peerDependencies, "openclaw"],
        [expected.openclaw?.compat, "pluginApi"],
      ]) {
        if (object?.[key] === ">=" + sourceVersion) {
          object[key] = ">=" + version;
        }
      }
      if (expected.openclaw?.build?.openclawVersion === sourceVersion) {
        expected.openclaw.build.openclawVersion = version;
      }
      // Conditional exports/imports resolve in declaration order. Keep all key
      // order intact while ignoring JSON whitespace, not package semantics.
      if (JSON.stringify(expected) !== JSON.stringify(actual)) {
        throw new Error("beta-to-final package contains non-version changes: " + path);
      }
    } else if (path === "scripts/lib/official-external-channel-catalog.json") {
      const expected = JSON.parse(before);
      for (const entry of expected.entries) {
        // The generator carries install specs and host compatibility floors
        // through unchanged; only aligned official package versions move.
        if (entry.source === "official" && entry.version === sourceVersion) {
          entry.version = version;
        }
      }
      if (JSON.stringify(expected) !== JSON.stringify(JSON.parse(after))) {
        throw new Error("beta-to-final catalog contains non-version changes: " + path);
      }
    } else if (before.replaceAll(sourceVersion, version) !== after) {
      throw new Error("beta-to-final generated metadata contains non-version changes: " + path);
    }
  }
  return {
    changedPaths: files.map((file) => file.filename),
    policy: BETA_FINAL_EVIDENCE_REUSE_POLICY,
  };
}

// Called only for this policy after authenticating each original admission.
// Lane choices, baselines, package roster and coverage stay exact. Only
// candidate version, its derived coverage label and the beta/latest selector vary.
export function promotionValidationInputs(inputs) {
  const result = { ...inputs, targetVersion: "<promoted-version>" };
  if (["", "npm-stable-v1"].includes(result.coveragePolicy)) {
    delete result.coveragePolicy;
  }
  if (result.publicationSelectionJson) {
    result.publicationSelectionJson = JSON.stringify(
      promotionSelection(JSON.parse(result.publicationSelectionJson)),
    );
  }
  return result;
}

export function promotionSelection(selection) {
  return selection && ["beta", "latest"].includes(selection.npmDistTag)
    ? { ...selection, npmDistTag: "<promoted-selector>" }
    : selection;
}

export function promotionSourceIdentity(identity) {
  if (!identity) {
    return identity;
  }
  return {
    ...identity,
    inventoryDigest: "<versioned-inventory>",
    publicationSelection: promotionSelection(identity.publicationSelection),
    projection: identity.projection && {
      ...identity.projection,
      version: "<promoted-version>",
      // Source admission derives these final-only outputs from the release train
      // (and the unchanged Android pin). They have independent publication gates;
      // neither is a product qualification lane reused from the beta.
      platforms: identity.projection.platforms.filter(
        (platform) => !["linux", "android"].includes(platform.id),
      ),
      packages: identity.projection.packages.map((pkg) => ({
        ...pkg,
        version: pkg.version === identity.projection.version ? "<promoted-version>" : pkg.version,
      })),
    },
  };
}
