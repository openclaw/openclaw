// Shared shipped-boundary inventory for generation and deterministic candidate checks.
import { execFileSync } from "node:child_process";
import {
  extractChangelogReleaseSections,
  parseContributionRecordProvenance,
  releaseNotesVersionForTag,
} from "../render-github-release-notes.mts";
import { loadChangelogCollection } from "./release-changelog.mjs";
import { compareReleaseVersions, parseReleaseVersion } from "./release-version.mjs";

function git(rootDir: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export function cumulativeShippedPullRequests(
  changelog: string,
  label: string,
  version?: string,
  diagnostics: string[] = [],
) {
  const baseline = version ? parseReleaseVersion(version) : null;
  const pullRequests = new Set<number>();
  for (const section of extractChangelogReleaseSections(changelog)) {
    if (
      section.version === "Unreleased" ||
      !section.source.includes("\n### Complete contribution record")
    ) {
      continue;
    }
    if (baseline) {
      const parsed = parseReleaseVersion(section.version);
      if (!parsed || (compareReleaseVersions(parsed.version, baseline.version) ?? 1) > 0) {
        continue;
      }
      // A beta draft in a stable tag is not evidence that its work shipped.
      if (baseline.channel === "stable" && parsed.channel !== "stable") {
        continue;
      }
    }
    const numbers = [...section.source.matchAll(/^- \*\*PR #(\d+)\*\*/gmu)].map((match) =>
      Number(match[1]),
    );
    if (new Set(numbers).size !== numbers.length) {
      throw new Error(
        label + " section " + section.version + " contains duplicate contribution record PR rows",
      );
    }
    try {
      parseContributionRecordProvenance(section.source);
    } catch (error) {
      // Old cumulative ledgers used stale "merged PRs" totals. Keep their
      // explicit rows readable without treating that total as audited evidence.
      if (
        /^This audited record covers the complete \S+ history: [0-9]+ merged PRs?\./mu.test(
          section.source,
        ) &&
        error instanceof Error &&
        error.message.startsWith("contribution record row count ")
      ) {
        diagnostics.push(
          `${label} section ${section.version} has a stale legacy PR count; using explicit rows, not its declared total.`,
        );
      } else {
        throw error;
      }
    }
    for (const number of numbers) {
      pullRequests.add(number);
    }
  }
  return pullRequests;
}

export function loadChangelogShippedBaseline(
  ref: string,
  rootDir = process.cwd(),
  target?: string,
) {
  const baseVersion = releaseNotesVersionForTag(ref);
  const tagRef = "refs/tags/" + ref;
  const commit = git(rootDir, ["rev-parse", "--verify", tagRef + "^{commit}"]);
  const changelog = loadChangelogCollection({ rootDir, ref: tagRef, recordsOnly: true });
  const sections = extractChangelogReleaseSections(changelog);
  const selected =
    sections.find((section) => section.version === ref.slice(1)) ??
    sections.find((section) => section.version === baseVersion);
  // Immutable historical releases can lack records. Retain uncertain work rather
  // than infer PR membership from prose, a closeout commit, or an issue reference.
  const diagnostics: string[] = [];
  if (!selected || !parseContributionRecordProvenance(selected.source)) {
    diagnostics.push(
      "Shipped baseline " +
        ref +
        " has no audited contribution provenance; only explicit historical PR rows can be subtracted, and uncertain work is retained.",
    );
  }
  const pullRequests = cumulativeShippedPullRequests(
    changelog,
    "shipped baseline " + ref,
    selected?.version ?? ref.slice(1),
    diagnostics,
  );
  if (target && pullRequests.size > 0) {
    // Compare immutable histories, not moving main, for reproducible candidate
    // validation. Only a recorded carrier can establish a shipped alias.
    const commits = (range: string) =>
      git(rootDir, ["log", "--format=%H%x1f%s%x1f%an%x1f%ae%x1f%B%x1e", range])
        .split("\x1e")
        .filter((record) => record.trim())
        .map((record) => {
          const [hash = "", subject = "", authorName = "", authorEmail = "", body = ""] = record
            .trim()
            .split("\x1f");
          const number = Number(
            subject.match(/ \(#(\d+)\)$/u)?.[1] ??
              subject.match(/^Merge pull request #(\d+) from /u)?.[1],
          );
          return {
            hash,
            subject,
            authorName,
            authorEmail,
            body,
            pullRequests: number ? [number] : [],
          };
        });
    const targets = commits(commit + ".." + target);
    const byHash = new Map(targets.map((entry) => [entry.hash, entry]));
    const bySubject = new Map<string, typeof targets>();
    const byOrigin = new Map<string, typeof targets>();
    const byPullRequest = new Map<number, typeof targets>();
    for (const entry of targets) {
      const subject = normalizedCommitSubject(entry.subject);
      bySubject.set(subject, [...(bySubject.get(subject) ?? []), entry]);
      for (const origin of cherryPickOrigins(entry.body)) {
        byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), entry]);
      }
      for (const number of entry.pullRequests) {
        byPullRequest.set(number, [...(byPullRequest.get(number) ?? []), entry]);
      }
    }
    const withPaths = (entry: (typeof targets)[number]): CanonicalCommit => ({
      ...entry,
      changedPaths: new Set(
        git(rootDir, [
          "diff-tree",
          "--root",
          "--no-commit-id",
          "--name-only",
          "-r",
          entry.hash,
          "--",
        ])
          .split("\n")
          .filter(Boolean),
      ),
    });
    for (const carrier of commits(target + ".." + commit)) {
      if (!carrier.pullRequests.some((number) => pullRequests.has(number))) {
        continue;
      }
      const candidates = [
        ...new Set([
          ...(bySubject.get(normalizedCommitSubject(carrier.subject)) ?? []),
          ...(byOrigin.get(carrier.hash) ?? []),
          ...cherryPickOrigins(carrier.body).flatMap((origin) =>
            byHash.has(origin) ? [byHash.get(origin)!] : [],
          ),
          ...backportPullRequestOrigins(carrier.body).flatMap(
            (number) => byPullRequest.get(number) ?? [],
          ),
        ]),
      ];
      if (!candidates.length) {
        continue;
      }
      const matched = new Set(
        canonicalMainCommitMatches(withPaths(carrier), candidates.map(withPaths)),
      );
      for (const entry of candidates) {
        if (matched.has(entry.hash)) {
          for (const number of entry.pullRequests) {
            pullRequests.add(number);
          }
        }
      }
    }
  }
  return { ref, commit, pullRequests, diagnostics };
}

type CommitIdentity = { authorEmail?: string; authorName?: string };
type CanonicalCommit = CommitIdentity & {
  hash: string;
  subject: string;
  body: string;
  changedPaths: Set<string>;
  pullRequests?: number[];
};

export function normalizedCommitSubject(subject: string) {
  return subject
    .replace(/(?:\s+\(#\d+\))+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function cherryPickOrigins(message: string) {
  return [...message.matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)$/gim)].map((match) =>
    match[1]!.toLowerCase(),
  );
}

export function backportPullRequestOrigins(message: string) {
  return [
    ...message.matchAll(/^Backport of #(\d+) to release\/[A-Za-z0-9._/-]+(?:\.)?\s*$/gim),
  ].map((match) => Number(match[1]));
}

export function authorsMatch(left: CommitIdentity, right: CommitIdentity) {
  const leftEmail = left.authorEmail?.trim().toLowerCase();
  const rightEmail = right.authorEmail?.trim().toLowerCase();
  if (leftEmail && rightEmail && leftEmail === rightEmail) {
    return true;
  }
  return (
    left.authorName?.trim().toLowerCase() === right.authorName?.trim().toLowerCase() &&
    Boolean(left.authorName?.trim())
  );
}

export function pathsOverlap(left: Set<string>, right: Set<string>) {
  for (const filePath of left) {
    if (right.has(filePath)) {
      return true;
    }
  }
  return false;
}

export function canonicalMainCommitMatches(commit: CanonicalCommit, candidates: CanonicalCommit[]) {
  const exact = candidates.find((candidate) => candidate.hash === commit.hash);
  if (exact) {
    return [exact.hash];
  }

  const origins = new Set(cherryPickOrigins(commit.body));
  const explicit = candidates
    .filter(
      (candidate) =>
        origins.has(candidate.hash) || cherryPickOrigins(candidate.body).includes(commit.hash),
    )
    .map((candidate) => candidate.hash);
  if (explicit.length > 0) {
    return [...new Set(explicit)];
  }

  const pullRequestOrigins = new Set(backportPullRequestOrigins(commit.body));
  if (pullRequestOrigins.size > 0) {
    const pullRequestMatches = candidates.filter(
      (candidate) =>
        (candidate.pullRequests ?? []).some((number) => pullRequestOrigins.has(number)) &&
        authorsMatch(commit, candidate) &&
        pathsOverlap(commit.changedPaths, candidate.changedPaths),
    );
    return pullRequestMatches.length === 1 ? pullRequestMatches.map((match) => match.hash) : [];
  }

  const subject = normalizedCommitSubject(commit.subject);
  const matches = candidates.filter(
    (candidate) =>
      normalizedCommitSubject(candidate.subject) === subject &&
      authorsMatch(commit, candidate) &&
      pathsOverlap(commit.changedPaths, candidate.changedPaths),
  );
  return matches.length === 1 ? matches.map((match) => match.hash) : [];
}

export function canonicalMainHistoryFor(section: string) {
  const lines = section
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("Canonical main history:"));
  if (!lines.length) {
    return undefined;
  }
  const commit = lines[0]?.match(/^Canonical main history: ([0-9a-f]{40})\.$/u)?.[1];
  if (lines.length !== 1 || !commit) {
    throw new Error("Malformed canonical main history provenance");
  }
  return commit;
}
