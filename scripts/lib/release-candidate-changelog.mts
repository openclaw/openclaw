// Owns the release-notes and contribution-record gates a candidate must pass
// before publication. pnpm release:candidate and the SHA-pinned Full Release
// Validation dispatch helper both run them; the helper runs under native Node,
// so this module must stay resolvable without workspace package aliases.
import { execFileSync, spawnSync } from "node:child_process";
import {
  CHANGELOG_ATTRIBUTION_NEXT_STEP,
  findChangelogAttributionViolations,
} from "../check-changelog-attributions.mts";
import {
  dedicatedSectionVersionForTag,
  extractChangelogReleaseSections,
  extractChangelogSection,
  formatShippedBaselineExclusions,
  loadReleaseNotesForTag,
  parseContributionRecordProvenance,
  parseShippedBaselineExclusions,
  releaseNotesVersionForTag,
  renderGithubReleaseNotes,
} from "../render-github-release-notes.mts";
import { loadChangelogCollection, readReleaseChangelogFiles } from "./release-changelog.mjs";

type StringFields<K extends string> = Record<K, string>;

export function gitIsAncestor(ancestor: string, target: string, cwd = process.cwd()) {
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${ancestor}^{commit}`, `${target}^{commit}`],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status === 0) {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  throw new Error(
    `could not check git ancestry ${ancestor}..${target}: ${
      result.stderr?.trim() || result.signal || result.status
    }`,
  );
}

function candidateContributionRecordPullRequests(
  section: string,
  label: string,
  { requireExactProvenance = true }: { requireExactProvenance?: boolean } = {},
) {
  const recordStart = section.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    throw new Error(`${label} is missing ### Complete contribution record`);
  }
  const record = section.slice(recordStart);
  const rowNumbers = [...record.matchAll(/^- \*\*PR #(?<number>[0-9]+)\*\*/gmu)].map((match) =>
    Number(match.groups?.number),
  );
  const rows = new Set(rowNumbers);
  if (rows.size !== rowNumbers.length) {
    const duplicate = rowNumbers.find((number, index) => rowNumbers.indexOf(number) !== index);
    throw new Error(`${label} contains duplicate contribution record PR #${duplicate}`);
  }
  if (!requireExactProvenance) {
    return rows;
  }
  const provenance = parseContributionRecordProvenance(record);
  if (!provenance || !/^[0-9a-f]{40}$/u.test(provenance.target)) {
    throw new Error(`${label} is missing exact complete contribution record provenance`);
  }
  return rows;
}

export function candidateCumulativeShippedPullRequests(changelog: string, label: string) {
  const pullRequests = new Set<number>();
  for (const section of extractChangelogReleaseSections(changelog)) {
    if (
      section.version === "Unreleased" ||
      !section.source.includes("\n### Complete contribution record")
    ) {
      continue;
    }
    for (const number of candidateContributionRecordPullRequests(
      section.source,
      `${label} section ${section.version}`,
      { requireExactProvenance: false },
    )) {
      pullRequests.add(number);
    }
  }
  return pullRequests;
}

export function loadCandidateShippedBaseline(ref: string, rootDir = process.cwd()) {
  const tagRef = `refs/tags/${ref}`;
  execFileSync("git", ["rev-parse", "--verify", `${tagRef}^{commit}`], {
    cwd: rootDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  const changelog = loadChangelogCollection({ rootDir, ref: tagRef, recordsOnly: true });
  const version = releaseNotesVersionForTag(ref);
  const source = loadReleaseNotesForTag({ rootDir, ref: tagRef, tag: ref, version });
  candidateContributionRecordPullRequests(
    source.record ?? source.section,
    `shipped baseline ${ref}`,
  );
  const pullRequests = candidateCumulativeShippedPullRequests(changelog, `shipped baseline ${ref}`);
  return { ref, pullRequests };
}

export function validateCandidateReleaseNotes({
  changelog,
  repository,
  tag,
  contributionRecordPath,
}: StringFields<"changelog" | "repository" | "tag"> & { contributionRecordPath?: string }) {
  if (/-beta\.[1-9][0-9]*$/u.test(tag)) {
    // New candidates cannot silently reuse cumulative or earlier-beta prose.
    extractChangelogSection(changelog, tag.slice(1));
  }
  const rendered = renderGithubReleaseNotes({
    changelog,
    version: releaseNotesVersionForTag(tag),
    tag,
    repository,
    contributionRecordPath,
  });
  return {
    status: "passed",
    mode: rendered.mode,
    characters: rendered.size.characters,
    bytes: rendered.size.bytes,
  };
}

export function validateCandidateChangelogProvenance({
  changelog,
  version,
  tag,
  targetSha,
  isAncestor = gitIsAncestor,
  loadShippedBaseline = loadCandidateShippedBaseline,
}: {
  changelog: string;
  version: string;
  tag: string;
  targetSha: string;
  isAncestor?: (ancestor: string, target: string) => boolean;
  loadShippedBaseline?: (ref: string) => { pullRequests: Set<number> };
}) {
  // Beta and correction tags may carry their own changelog heading.
  let section: string | undefined;
  let sectionVersion = version;
  const dedicatedVersion = dedicatedSectionVersionForTag(tag);
  if (typeof dedicatedVersion === "string" && dedicatedVersion !== version) {
    try {
      section = extractChangelogSection(changelog, dedicatedVersion);
      sectionVersion = dedicatedVersion;
    } catch {
      // No dedicated section; validate the base section.
    }
  }
  if (section === undefined) {
    section = extractChangelogSection(changelog, version);
  }
  const recordStart = section.search(/\n### Complete contribution record\r?$/m);
  if (recordStart < 0) {
    throw new Error(
      `CHANGELOG.md ## ${sectionVersion} is missing ### Complete contribution record`,
    );
  }
  const record = section.slice(recordStart);
  const recordedPullRequests = candidateContributionRecordPullRequests(
    section,
    `CHANGELOG.md ## ${sectionVersion}`,
  );
  const provenance = parseContributionRecordProvenance(record);
  const base = provenance?.base;
  const recordedTarget = provenance?.target;
  if (!base || !recordedTarget || !/^[0-9a-f]{40}$/u.test(recordedTarget)) {
    throw new Error(
      `CHANGELOG.md ## ${sectionVersion} is missing exact complete contribution record provenance`,
    );
  }
  const shippedBaselines = parseShippedBaselineExclusions(record);
  const sectionShippedBaselines = parseShippedBaselineExclusions(section);
  if (
    formatShippedBaselineExclusions(sectionShippedBaselines) !==
    formatShippedBaselineExclusions(shippedBaselines)
  ) {
    throw new Error(
      "shipped baseline exclusions must appear inside the complete contribution record",
    );
  }
  if (!isAncestor(base, recordedTarget)) {
    throw new Error(
      `CHANGELOG.md contribution record base ${base} is not an ancestor of recorded target ${recordedTarget}`,
    );
  }
  // The record is generated before its own changelog/finalization commit. Require
  // reachability so the tag can contain that bounded release-only follow-up.
  if (!isAncestor(recordedTarget, targetSha)) {
    throw new Error(
      `CHANGELOG.md contribution record target ${recordedTarget} is not reachable from release tag ${targetSha}`,
    );
  }
  // The verifier persists associated and text-linked PR exclusions together.
  // Revalidate that exact inventory here instead of rediscovering a narrower set from git text.
  const excludedPullRequests = new Set<number>();
  for (const baseline of shippedBaselines) {
    const loaded = loadShippedBaseline(baseline.ref);
    if (!(loaded.pullRequests instanceof Set)) {
      throw new Error(`shipped baseline ${baseline.ref} did not provide a PR inventory`);
    }
    const duplicateExclusions = baseline.pullRequests.filter((number) =>
      excludedPullRequests.has(number),
    );
    if (duplicateExclusions.length > 0) {
      throw new Error(
        `release contribution record repeats shipped PR exclusions across baselines: ${duplicateExclusions.map((number) => `#${number}`).join(", ")}`,
      );
    }
    const absent = baseline.pullRequests.filter((number) => !loaded.pullRequests.has(number));
    if (absent.length > 0) {
      throw new Error(
        `release contribution record lists PRs absent from shipped baseline ${baseline.ref}: ${absent.map((number) => `#${number}`).join(", ")}`,
      );
    }
    const retained = [...recordedPullRequests].filter((number) => loaded.pullRequests.has(number));
    if (retained.length > 0) {
      throw new Error(
        `release contribution record still contains shipped PRs from ${baseline.ref}: ${retained.map((number) => `#${number}`).join(", ")}`,
      );
    }
    for (const number of baseline.pullRequests) {
      excludedPullRequests.add(number);
    }
  }
  return {
    status: "passed",
    base,
    target: recordedTarget,
    shippedBaselines,
    reason: undefined,
  };
}

// Applies pnpm check's changelog-only lints to the candidate's committed changelog
// artifacts, so a release-notes edit fails here instead of hours into validation.
function validateCandidateChangelogLints({
  rootDir,
  targetSha,
}: StringFields<"rootDir" | "targetSha">) {
  const violations = findChangelogAttributionViolations(
    readReleaseChangelogFiles({ rootDir, ref: targetSha }),
  );
  if (violations.length > 0) {
    throw new Error(
      `Forbidden changelog thanks attribution (pnpm check:changelog-attributions): ${violations
        .map((violation) => `${violation.path}:${violation.line} uses Thanks @${violation.handle}`)
        .join("; ")}. ${CHANGELOG_ATTRIBUTION_NEXT_STEP}`,
    );
  }
}

export function validateCandidateChangelog({
  rootDir,
  repository,
  tag,
  targetSha,
}: StringFields<"rootDir" | "repository" | "tag" | "targetSha">) {
  validateCandidateChangelogLints({ rootDir, targetSha });
  const version = releaseNotesVersionForTag(tag);
  const releaseChangelog = loadReleaseNotesForTag({ rootDir, ref: targetSha, tag, version });
  return {
    releaseNotesText: releaseChangelog.section,
    releaseNotesCheck: validateCandidateReleaseNotes({
      changelog: releaseChangelog.section,
      repository,
      tag,
      contributionRecordPath: releaseChangelog.recordPath ?? undefined,
    }),
    releaseNotesProvenance: validateCandidateChangelogProvenance({
      changelog: releaseChangelog.record ?? releaseChangelog.section,
      version,
      tag,
      targetSha,
    }),
  };
}
