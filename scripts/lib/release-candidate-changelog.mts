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
  extractChangelogSection,
  formatShippedBaselineExclusions,
  loadReleaseNotesForTag,
  parseContributionRecordProvenance,
  parseShippedBaselineExclusions,
  releaseNotesVersionForTag,
  renderGithubReleaseNotes,
} from "../render-github-release-notes.mts";
import {
  canonicalMainHistoryFor,
  loadChangelogShippedBaseline,
} from "./release-changelog-baseline.mts";

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
  rootDir = process.cwd(),
  isAncestor = (ancestor, target) => gitIsAncestor(ancestor, target, rootDir),
  loadShippedBaseline,
}: {
  changelog: string;
  version: string;
  tag: string;
  targetSha: string;
  rootDir?: string;
  isAncestor?: (ancestor: string, target: string) => boolean;
  loadShippedBaseline?: (ref: string) => { pullRequests: Set<number>; diagnostics?: string[] };
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
  const recordedPullRequests = new Set(
    [...record.matchAll(/^- \*\*PR #(\d+)\*\*/gmu)].map((match) => Number(match[1])),
  );
  const provenance = parseContributionRecordProvenance(record);
  const base = provenance?.base;
  const recordedTarget = provenance?.target;
  if (!base || !recordedTarget || !/^[0-9a-f]{40}$/u.test(recordedTarget)) {
    throw new Error(
      `CHANGELOG.md ## ${sectionVersion} is missing exact complete contribution record provenance`,
    );
  }
  const canonicalMain = canonicalMainHistoryFor(record);
  if (canonicalMainHistoryFor(section) !== canonicalMain) {
    throw new Error("canonical main history must appear inside the complete contribution record");
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
  if (
    !isAncestor(base, recordedTarget) &&
    !shippedBaselines.some((baseline) => baseline.ref === base)
  ) {
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
  const diagnostics: string[] = [];
  const excludedPullRequests = new Set<number>();
  for (const baseline of shippedBaselines) {
    const loaded = loadShippedBaseline
      ? loadShippedBaseline(baseline.ref)
      : loadChangelogShippedBaseline(baseline.ref, rootDir, canonicalMain ?? recordedTarget);
    diagnostics.push(...(loaded.diagnostics ?? []));
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
    ...(diagnostics.length ? { diagnostics } : {}),
    reason: undefined,
  };
}

// Apply the shared attribution policy only to the selected publication inputs.
// The standalone repository checker still owns linting the complete archive.
function validateCandidateChangelogLints(
  releaseChangelog: ReturnType<typeof loadReleaseNotesForTag>,
) {
  const files = [{ path: releaseChangelog.sourcePath, content: releaseChangelog.section }];
  if (releaseChangelog.record !== null && releaseChangelog.recordPath !== null) {
    files.push({ path: releaseChangelog.recordPath, content: releaseChangelog.record });
  }
  const violations = findChangelogAttributionViolations(files);
  if (violations.length > 0) {
    throw new Error(
      `Forbidden changelog thanks attribution (pnpm check:changelog-attributions): ${violations
        .map((violation) => `${violation.path}:${violation.line} uses Thanks @${violation.handle}`)
        .join("; ")}. ${CHANGELOG_ATTRIBUTION_NEXT_STEP}`,
    );
  }
  return files.map((file) => file.path);
}

// Describe commits after the audited record only when assembling final candidate evidence.
export function inspectCandidateChangelogRange({
  rootDir,
  repository,
  recordedTarget,
  targetSha,
  changelogPaths,
}: StringFields<"rootDir" | "repository" | "recordedTarget" | "targetSha"> & {
  changelogPaths: string[];
}) {
  const range = `${recordedTarget}..${targetSha}`;
  const revList = (...args: string[]) =>
    execFileSync("git", ["rev-list", ...args], { cwd: rootDir, encoding: "utf8" }).trim();
  const commitCount = recordedTarget === targetSha ? 0 : Number(revList("--count", range));
  // Walk the commits, including merged branches. A tip-to-tip diff hides reverted changes.
  const excludedPaths = ["CHANGELOG.md", ...changelogPaths].map(
    (path) => `:(exclude,literal)${path}`,
  );
  const latestChangeOutsideChangelog = commitCount
    ? revList("--full-history", "--max-count=1", range, "--", ".", ...excludedPaths) || null
    : null;
  const compareUrl = `https://github.com/${repository}/compare/${recordedTarget}...${targetSha}`;
  const count = `${commitCount} commit${commitCount === 1 ? "" : "s"} after the audited record`;
  const summary =
    commitCount === 0
      ? "Contribution record covers the candidate."
      : latestChangeOutsideChangelog
        ? `${count}. Review changes outside the selected changelog: ${compareUrl}`
        : `${count} (selected changelog paths only).`;
  return { candidate: targetSha, commitCount, latestChangeOutsideChangelog, compareUrl, summary };
}

export function validateCandidateChangelog({
  rootDir,
  repository,
  tag,
  targetSha,
}: StringFields<"rootDir" | "repository" | "tag" | "targetSha">) {
  const version = releaseNotesVersionForTag(tag);
  const releaseChangelog = loadReleaseNotesForTag({ rootDir, ref: targetSha, tag, version });
  const changelogPaths = validateCandidateChangelogLints(releaseChangelog);
  return {
    releaseNotesText: releaseChangelog.section,
    changelogPaths,
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
      rootDir,
    }),
  };
}
