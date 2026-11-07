#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  downloadActionsArtifactArchive,
  inspectActionsArtifactZipWithPolicy,
} from "./lib/actions-artifact-archive.mjs";
import { isObservationPath } from "./lib/ci-test-observations.mjs";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_MEMBER_BYTES = 8 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const MEMBER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\/(?:observations|launch)\.json$/u;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const positive = (value) =>
  /^[1-9][0-9]*$/u.test(String(value)) && Number.isSafeInteger(Number(value));
const time = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

function requirePrior(condition, reason) {
  if (!condition) {
    throw new Error(reason);
  }
}

async function readJson(
  fetchImpl,
  token,
  repository,
  endpoint,
  deadline,
  maxBytes = 2 * 1024 * 1024,
) {
  const remaining = deadline - Date.now();
  requirePrior(remaining > 0, "deadline-exceeded");
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2026-03-10",
    },
    redirect: "error",
    signal: AbortSignal.timeout(remaining),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("metadata-unavailable");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requirePrior(size <= maxBytes, "metadata-too-large");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)));
}

async function compareTrees(readTree, baseTree, headTree, root, deadline) {
  const result = await readTree(baseTree);
  requirePrior(
    result.sha === baseTree && result.truncated === false && Array.isArray(result.tree),
    "prior-tree-unavailable",
  );
  const prior = new Map();
  const paths = new Set();
  for (const entry of result.tree) {
    requirePrior(
      isObservationPath(entry.path) &&
        !paths.has(entry.path) &&
        SHA.test(entry.sha) &&
        ((entry.type === "tree" && entry.mode === "040000") ||
          (entry.type === "blob" && ["100644", "100755", "120000"].includes(entry.mode)) ||
          (entry.type === "commit" && entry.mode === "160000")),
      "invalid-prior-tree-entry",
    );
    paths.add(entry.path);
    if (entry.type !== "tree") {
      prior.set(entry.path, `${entry.mode} ${entry.type} ${entry.sha}`);
    }
  }
  const remaining = deadline - Date.now();
  requirePrior(remaining > 0, "deadline-exceeded");
  const bytes = execFileSync("git", ["ls-tree", "-r", "-z", "--full-tree", headTree], {
    cwd: root,
    timeout: Math.min(1000, remaining),
    maxBuffer: MAX_TREE_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const changed = new Set();
  for (const row of new TextDecoder("utf8", { fatal: true }).decode(bytes).split("\0")) {
    if (!row) {
      continue;
    }
    const separator = row.indexOf("\t");
    const path = row.slice(separator + 1);
    requirePrior(separator > 0 && isObservationPath(path), "invalid-head-tree-entry");
    if (prior.get(path) !== row.slice(0, separator)) {
      changed.add(path);
    }
    prior.delete(path);
  }
  for (const path of prior.keys()) {
    changed.add(path);
  }
  requirePrior(Date.now() < deadline && changed.size < 600, "prior-tree-diff-unavailable");
  return changed;
}

// Preflight owns network access. Consumers receive inert, immutable JSON only.
export async function restoreCiAdaptivePriors(options = {}) {
  const deadline = Date.now() + 10_000;
  const env = options.env ?? process.env;
  const repository = env.GITHUB_REPOSITORY ?? "";
  const root = options.repositoryRoot ?? process.cwd();
  let revision = "";
  let tree = "";
  try {
    [revision, tree] = execFileSync("git", ["rev-parse", "HEAD", "HEAD^{tree}"], {
      cwd: root,
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split("\n");
  } catch {
    // Missing checkout identity makes the optional bundle ineligible.
  }
  const bundle = {
    version: 1,
    restoredAt: new Date().toISOString(),
    cutoffAt: null,
    repository,
    consumer: {
      runId: env.GITHUB_RUN_ID ?? "",
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? "",
      revision,
      tree,
    },
    candidates: [],
    fallbackReasons: [],
  };
  const token = env.GITHUB_TOKEN;
  if (
    !token ||
    !REPOSITORY.test(repository) ||
    !SHA.test(revision) ||
    !SHA.test(tree) ||
    !positive(bundle.consumer.runId) ||
    !positive(bundle.consumer.runAttempt)
  ) {
    bundle.fallbackReasons.push("restore-context-unavailable");
    return bundle;
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const read = (endpoint) => readJson(fetchImpl, token, repository, endpoint, deadline);
  const comparisons = new Map();
  try {
    const current = await read(
      `actions/runs/${bundle.consumer.runId}/attempts/${bundle.consumer.runAttempt}`,
    );
    requirePrior(
      current.id === Number(bundle.consumer.runId) &&
        current.run_attempt === Number(bundle.consumer.runAttempt) &&
        current.repository?.full_name === repository &&
        current.head_repository?.full_name === repository &&
        current.path === ".github/workflows/ci.yml" &&
        ["schedule", "pull_request"].includes(current.event) &&
        time(current.created_at),
      "consumer-run-unavailable",
    );
    bundle.cutoffAt = current.created_at;
    const cutoff = Date.parse(current.created_at);
    const listing = await read(
      "actions/workflows/ci.yml/runs?event=schedule&branch=main&status=completed&per_page=5",
    );
    requirePrior(Array.isArray(listing.workflow_runs), "run-list-unavailable");
    let downloads = 0;
    for (const run of listing.workflow_runs.slice(0, 5)) {
      if (downloads === 2) {
        break;
      }
      if (
        !positive(run.id) ||
        !positive(run.run_attempt) ||
        run.id === Number(bundle.consumer.runId) ||
        run.event !== "schedule" ||
        run.head_branch !== "main" ||
        run.status !== "completed" ||
        !["success", "failure"].includes(run.conclusion) ||
        !SHA.test(run.head_sha) ||
        run.repository?.full_name !== repository ||
        run.head_repository?.full_name !== repository ||
        !time(run.updated_at) ||
        Date.parse(run.updated_at) >= cutoff
      ) {
        continue;
      }
      const artifacts = await read(`actions/runs/${run.id}/artifacts?per_page=100`);
      requirePrior(
        Array.isArray(artifacts.artifacts) && artifacts.total_count === artifacts.artifacts.length,
        "artifact-list-incomplete",
      );
      const matches = artifacts.artifacts.filter(
        (artifact) =>
          new RegExp(`^ci-test-observations-${run.id}-${run.run_attempt}-[0-9]+$`, "u").test(
            artifact.name,
          ) &&
          artifact.expired === false &&
          time(artifact.created_at) &&
          Date.parse(artifact.created_at) < cutoff,
      );
      matches.sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at) || right.id - left.id,
      );
      for (const artifact of matches) {
        if (downloads === 2) {
          break;
        }
        downloads++;
        try {
          const { archiveBytes, artifactMetadata, workflowRun } =
            await downloadActionsArtifactArchive({
              token,
              fetchImpl,
              deadlineMs: deadline,
              timeoutMs: 10_000,
              retryAttempts: 1,
              maxArchiveBytes: MAX_ARCHIVE_BYTES,
              expected: {
                repository,
                artifactId: artifact.id,
                artifactName: artifact.name,
                artifactDigest: artifact.digest,
                artifactSizeBytes: artifact.size_in_bytes,
                runId: run.id,
                runAttempt: run.run_attempt,
                workflowSha: run.head_sha,
                workflowPath: ".github/workflows/ci.yml",
                workflowEvent: "schedule",
                workflowHeadBranch: "main",
                runStatePolicy: "completed-success-or-failure",
              },
            });
          requirePrior(
            artifactMetadata.created_at === artifact.created_at &&
              time(workflowRun.updated_at) &&
              Date.parse(workflowRun.updated_at) < cutoff,
            "prior-created-after-cutoff",
          );
          const files = inspectActionsArtifactZipWithPolicy(archiveBytes, {
            minEntries: 1,
            maxEntries: 4,
            maxArchiveBytes: MAX_ARCHIVE_BYTES,
            maxExpandedBytes: MAX_ARCHIVE_BYTES,
            allowPath: (name) => MEMBER.test(name),
            maxEntryBytes: () => MAX_MEMBER_BYTES,
          });
          let comparison = comparisons.get(run.head_sha);
          if (!comparison) {
            // Test checkouts are shallow. Resolve the complete path diff once here,
            // while preflight owns network access, instead of fetching in every shard.
            const result = await read(`compare/${run.head_sha}...${revision}?per_page=1&page=1`);
            requirePrior(
              result.base_commit?.sha === run.head_sha &&
                SHA.test(result.base_commit?.commit?.tree?.sha) &&
                result.merge_base_commit?.sha === run.head_sha &&
                ["ahead", "identical"].includes(result.status) &&
                result.behind_by === 0 &&
                Array.isArray(result.files),
              "prior-comparison-unavailable",
            );
            // Compare caps file lists at 300. A single bounded base-tree download
            // plus the checked-out head avoids both that cap and per-directory API calls.
            const changedFiles =
              result.files.length >= 300
                ? await compareTrees(
                    (sha) =>
                      readJson(
                        fetchImpl,
                        token,
                        repository,
                        `git/trees/${sha}?recursive=1`,
                        deadline,
                        MAX_TREE_BYTES,
                      ),
                    result.base_commit.commit.tree.sha,
                    tree,
                    root,
                    deadline,
                  )
                : new Set();
            for (const file of result.files.length >= 300 ? [] : result.files) {
              requirePrior(isObservationPath(file.filename), "invalid-comparison-path");
              changedFiles.add(file.filename);
              if (file.status === "renamed" || file.previous_filename !== undefined) {
                requirePrior(isObservationPath(file.previous_filename), "invalid-comparison-path");
                changedFiles.add(file.previous_filename);
              }
            }
            requirePrior(
              result.status !== "identical" ||
                (run.head_sha === revision &&
                  result.base_commit.commit.tree.sha === tree &&
                  changedFiles.size === 0),
              "invalid-identical-comparison",
            );
            comparison = {
              baseRevision: run.head_sha,
              baseTree: result.base_commit.commit.tree.sha,
              headRevision: revision,
              headTree: tree,
              changedFiles: [...changedFiles].toSorted((left, right) =>
                left < right ? -1 : left > right ? 1 : 0,
              ),
            };
            comparisons.set(run.head_sha, comparison);
          }
          const candidates = [];
          for (const [memberPath, bytes] of files) {
            requirePrior(Date.now() < deadline, "deadline-exceeded");
            if (!memberPath.endsWith("/observations.json")) {
              continue;
            }
            const observations = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes));
            const context = observations.observations?.context;
            requirePrior(
              observations.version === 1 &&
                [1, 2].includes(observations.observations?.version) &&
                String(observations.source?.runId) === String(run.id) &&
                String(observations.source?.runAttempt) === String(run.run_attempt) &&
                observations.source?.event === "schedule" &&
                context?.repository === repository &&
                context.revision === run.head_sha &&
                context.tree === comparison.baseTree,
              "prior-source-mismatch",
            );
            const preContext = observations.preExecution?.observations?.context;
            requirePrior(
              !preContext ||
                (preContext.repository === repository &&
                  preContext.revision === context.revision &&
                  preContext.tree === context.tree),
              "prior-inventory-mismatch",
            );
            const launchHash = observations.preExecution?.launchInputs?.sha256;
            const launch = files.get(memberPath.replace(/observations\.json$/u, "launch.json"));
            requirePrior(launch && hash(launch) === launchHash, "prior-launch-mismatch");
            candidates.push({
              artifactId: artifact.id,
              runId: run.id,
              runAttempt: run.run_attempt,
              createdAt: artifact.created_at,
              archiveSha256: hash(archiveBytes),
              memberPath,
              memberSha256: hash(bytes),
              observations,
              comparison,
            });
          }
          requirePrior(
            candidates.length > 0 && candidates.length <= 2 && files.size === candidates.length * 2,
            "prior-member-count",
          );
          requirePrior(Date.now() < deadline, "deadline-exceeded");
          bundle.candidates.push(...candidates);
        } catch {
          bundle.fallbackReasons.push("prior-artifact-unavailable");
        }
      }
    }
    if (!bundle.candidates.length) {
      bundle.fallbackReasons.push("no-eligible-prior");
    }
  } catch {
    bundle.fallbackReasons.push("restore-unavailable");
  }
  bundle.restoredAt = new Date().toISOString();
  bundle.fallbackReasons = [...new Set(bundle.fallbackReasons)];
  return bundle;
}

async function main() {
  const args = process.argv.slice(2);
  requirePrior(
    args.length === 0 || (args.length === 2 && args[0] === "--output"),
    "usage: ci-adaptive-priors.mjs [--output path]",
  );
  const output = resolve(args[1] ?? ".artifacts/ci-adaptive-priors.json");
  const bundle = await restoreCiAdaptivePriors();
  const temporary = `${output}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(temporary, JSON.stringify(bundle), { flag: "wx", mode: 0o600 });
    renameSync(temporary, output);
    console.log(`[adaptive-ci] restored ${bundle.candidates.length} prior observations`);
  } finally {
    rmSync(temporary, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => console.warn("[adaptive-ci] prior restore unavailable; tests unchanged"));
}
