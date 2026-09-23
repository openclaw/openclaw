#!/usr/bin/env node

// GitHub dependency-change guard: requests maintainer review and can autoscrub
// lockfile-only PR changes without executing contributor code.
import { appendFile } from "node:fs/promises";
import {
  SupersededReviewError,
  assertGuardUnchanged,
  findMaintainerApproval,
  finishGuard,
  openGuard,
  withApprovalRequest,
} from "./guard-review.mjs";
import {
  GITHUB_API_REQUEST_TIMEOUT_MS,
  GITHUB_ERROR_BODY_MAX_BYTES,
  GITHUB_RESPONSE_BODY_MAX_BYTES,
  GitHubDiffDataError,
  GitHubRateLimitError,
  createGitHubApi,
  createIssueMutationHelpers,
  normalizeGuardLoginSet,
  readBoundedGitHubErrorText,
  readBoundedGitHubJson,
  sanitizeGuardDisplayValue,
} from "./guard-shared.mjs";
import { loadSecurityReviewPolicy } from "./security-review-policy.mjs";

/** Marker used to identify dependency guard comments. */
const dependencyChangeMarker = "<!-- openclaw:dependency-guard -->";
const dependencyGraphGuardMarker = "<!-- openclaw:dependency-graph-guard -->";
const dependencyApprovalCommand = "/allow-dependencies-change";
export const dependencyChangedLabel = "dependencies-changed";
export {
  GITHUB_API_REQUEST_TIMEOUT_MS,
  GITHUB_ERROR_BODY_MAX_BYTES,
  GITHUB_RESPONSE_BODY_MAX_BYTES,
  readBoundedGitHubErrorText,
  readBoundedGitHubJson,
};

const autoscrubCommitMessage = "chore: remove dependency lockfile change";
const dependencyManifestFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "dependenciesMeta",
  "overrides",
  "resolutions",
  "packageManager",
  "workspaces",
  "pnpm",
  "name",
  "version",
  "engines",
  "os",
  "cpu",
  "libc",
];

/**
 * @typedef {{ path: string, fields: string[], previousPath?: string }} DependencyManifestChange
 * @typedef {{ kind: "not-attempted" } |
 *   { kind: "blocked-by-dependency-manifest-fields", changes: DependencyManifestChange[] } |
 *   { kind: "blocked-by-other-dependency-files", files: string[] } |
 *   { kind: "failed", reason: string }} AutoscrubStatus
 */

export function dependencyFieldChanges(baseManifest, headManifest) {
  const changes = [];
  for (const field of dependencyManifestFields) {
    if (stableJson(baseManifest?.[field] ?? null) !== stableJson(headManifest?.[field] ?? null)) {
      changes.push(field);
    }
  }
  return changes;
}

export function isRemovalOnlyDependencyGraphChange(changes) {
  return changes.length > 0 && changes.every((change) => change.change_type === "removed");
}

/**
 * @param {{
 *   dependencyFiles?: string[],
 *   lockfileChanges: string[],
 *   dependencyManifestChanges?: DependencyManifestChange[],
 * }} options
 */
export function shouldAutoscrubDependencyLockfiles({
  dependencyFiles = [],
  lockfileChanges,
  dependencyManifestChanges = [],
}) {
  const { isPackageLockfile } = loadSecurityReviewPolicy();
  return (
    lockfileChanges.length > 0 &&
    dependencyManifestChanges.length === 0 &&
    dependencyFiles.every(isPackageLockfile)
  );
}

export function canAutoscrubPullRequest({ owner, repo, pullRequest }) {
  return autoscrubTargetRepository({ owner, repo, pullRequest }) !== null;
}

function autoscrubTargetRepository({ owner, repo, pullRequest }) {
  const baseRepository = `${owner}/${repo}`;
  const headRepository = pullRequest.head?.repo;
  const headRepositoryName = headRepository?.full_name;
  if (
    typeof pullRequest.head?.ref === "string" &&
    pullRequest.head.ref.length > 0 &&
    typeof pullRequest.head?.sha === "string" &&
    pullRequest.head.sha.length > 0
  ) {
    if (headRepositoryName === baseRepository) {
      return { owner, repo };
    }

    if (pullRequest.maintainer_can_modify === true && typeof headRepositoryName === "string") {
      const [headOwner, headRepo] = headRepositoryName.split("/");
      if (headOwner && headRepo) {
        return { owner: headOwner, repo: headRepo };
      }
    }
  }
  return null;
}

function stableJson(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const sorted = {};
  for (const key of Object.keys(value).toSorted((left, right) => left.localeCompare(right))) {
    sorted[key] = value[key];
  }
  return JSON.stringify(sorted);
}

export function markdownCode(value) {
  return `\`${sanitizeGuardDisplayValue(value).replaceAll("`", "\\`")}\``;
}

function shellQuote(value) {
  return `'${sanitizeGuardDisplayValue(value).replaceAll("'", "'\\''")}'`;
}

export function dependencyGuardCommentAuthors(value) {
  return normalizeGuardLoginSet(value, "github-actions[bot]");
}

export function isDependencyGuardMarkerComment(comment, marker, trustedAuthors) {
  const login = comment.user?.login?.toLowerCase();
  return Boolean(login && trustedAuthors.has(login) && comment.body?.includes(marker));
}

function renderDependencyChangeLines({
  lockfileChanges,
  dependencyFiles = [],
  dependencyManifestChanges,
}) {
  const files = new Set([...lockfileChanges, ...dependencyFiles]);
  for (const change of dependencyManifestChanges) {
    if (change.previousPath) {
      files.add(change.previousPath);
    }
    files.add(change.path);
  }
  return [...files].map((path) => `- ${markdownCode(path)}`);
}

function renderApprovedDependencyComment(approval, changes) {
  return [
    dependencyGraphGuardMarker,
    "",
    approval.kind === "author"
      ? "### ⚠️ Dependency graph changes"
      : "### ✅ Dependency graph changes approved",
    "",
    approval.kind === "author"
      ? "This maintainer PR changes the dependency graph. This comment is informational because the PR author has repository Maintain or Admin access."
      : "A maintainer approved this revision with an explicit dependency approval comment.",
    "",
    `- Current SHA: ${markdownCode(approval.sha)}`,
    `- Maintainer: @${sanitizeGuardDisplayValue(approval.login)}`,
    `- Repository role: ${markdownCode(approval.role)}`,
    ...(approval.kind === "comment" ? [`- Approval comment: ${approval.url}`] : []),
    "",
    ...(approval.kind === "author"
      ? ["These dependency graph changes were made:", ...renderDependencyChangeLines(changes), ""]
      : []),
    approval.kind === "author"
      ? "Carefully review these changes before merging."
      : "A later push requires a fresh approval comment for an external contributor's PR.",
  ].join("\n");
}

export function renderRemovalOnlyDependencyComment({ dependencyGraphChanges, headSha }) {
  const removalLines = dependencyGraphChanges.map(
    (change) =>
      `- Removed ${markdownCode(change.name ?? "<unknown dependency>")} from ${markdownCode(change.manifest ?? "<unknown manifest>")}.`,
  );
  return [
    dependencyGraphGuardMarker,
    "",
    "### Dependency removals noted",
    "",
    "This PR only removes dependencies from the dependency graph, so the dependency guard is informational and does not require additional maintainer approval.",
    "",
    ...removalLines,
    "",
    `- Current SHA: ${markdownCode(headSha ?? "<head-sha>")}`,
    "",
    "A later push that adds or changes dependency graph entries will require a fresh maintainer approval.",
  ].join("\n");
}

export function renderAutoscrubbedDependencyComment({ baseBranch, lockfileChanges, commitSha }) {
  const safeBranch = sanitizeGuardDisplayValue(baseBranch ?? "main");
  const fileLines = lockfileChanges.map((path) => `- ${markdownCode(path)}`);
  return `${dependencyGraphGuardMarker}

### Dependency lockfile changes were removed

This PR did not change dependency graph fields in package manifests and had no maintainer approval, so the workflow restored the lockfile residue from the target branch automatically.

Restored lockfiles:
${fileLines.join("\n")}

- Target branch: ${markdownCode(safeBranch)}
- Cleanup commit: ${markdownCode(commitSha)}
- Workflow action: restored each listed lockfile from the target branch and pushed the cleanup commit to this PR head.
- Verification result: this PR no longer carries those package lockfile diffs after the cleanup commit.

No action is needed unless this PR intentionally requires a dependency update. If it does, explain the update in the PR and request a maintainer's review.`;
}

export function isAutoscrubbedDependencyComment(comment) {
  return comment?.body?.includes("### Dependency lockfile changes were removed") === true;
}

export function renderClearedDependencyGuardComment({ headSha }) {
  return [
    dependencyGraphGuardMarker,
    "",
    "### Dependency graph guard cleared",
    "",
    `This PR no longer has dependency changes awaiting review. A future dependency graph change from an external contributor requires a maintainer's ${markdownCode(dependencyApprovalCommand)} comment after the guard notice identifies that revision.`,
    "",
    `- Current SHA: ${markdownCode(headSha ?? "<head-sha>")}`,
  ].join("\n");
}

/**
 * @param {{
 *   baseBranch?: string,
 *   headSha?: string,
 *   lockfileChanges: string[],
 *   dependencyManifestChanges: DependencyManifestChange[],
 *   dependencyFiles?: string[],
 *   autoscrubStatus?: AutoscrubStatus | null,
 * }} options
 */
export function renderBlockedDependencyComment({
  baseBranch,
  headSha,
  lockfileChanges,
  dependencyManifestChanges,
  autoscrubStatus,
  dependencyFiles = [],
}) {
  const safeBranch = sanitizeGuardDisplayValue(baseBranch ?? "main");
  const baseRef = shellQuote(`origin/${safeBranch}`);
  const autoscrubLines = renderAutoscrubStatusLines(autoscrubStatus);
  const removalSteps =
    lockfileChanges.length > 0
      ? [
          "",
          "To remove lockfile changes, restore them from the target branch:",
          "",
          "```bash",
          "git fetch origin",
          `git checkout ${baseRef} -- ${lockfileChanges.map(shellQuote).join(" ")}`,
          `git commit -m ${shellQuote(autoscrubCommitMessage)}`,
          "git push",
          "```",
        ]
      : [];
  return [
    dependencyGraphGuardMarker,
    "",
    "### ⚠️ Maintainer dependency review required",
    "",
    "This external contributor PR changes the dependency graph. A maintainer must review these changes before merging.",
    "",
    `Current SHA: ${markdownCode(headSha ?? "<head-sha>")}`,
    "",
    "These dependency graph changes were made:",
    ...renderDependencyChangeLines({ lockfileChanges, dependencyFiles, dependencyManifestChanges }),
    ...autoscrubLines,
    ...removalSteps,
    "",
    "After reviewing the changes, post a new PR comment containing only approval commands, each on its own line:",
    "",
    "```text",
    dependencyApprovalCommand,
    "```",
    "",
    "A later push requires a fresh approval comment.",
  ].join("\n");
}

function renderAutoscrubStatusLines(status) {
  if (!status) {
    return [];
  }
  if (status.kind === "not-attempted") {
    return [
      "",
      "Auto-scrub was not attempted because this workflow can only push deterministic cleanup commits to PR branches that maintainers can modify. Please remove the lockfile changes manually.",
    ];
  }
  if (status.kind === "blocked-by-dependency-manifest-fields") {
    return [
      "",
      "Auto-scrub was not attempted because this PR changes package manifest dependency graph fields:",
      ...renderDependencyChangeLines({
        lockfileChanges: [],
        dependencyManifestChanges: status.changes,
      }),
      "",
      "Dependency graph changes require maintainer review. Please remove lockfile changes manually if they are not needed.",
    ];
  }
  if (status.kind === "blocked-by-other-dependency-files") {
    return [
      "",
      "Auto-scrub was not attempted because this PR also changes dependency-related files that are not package lockfiles:",
      ...status.files.map((path) => `- ${markdownCode(path)}`),
      "",
      "Please remove lockfile changes manually if they are not needed.",
    ];
  }
  if (status.kind === "failed") {
    return [
      "",
      `Auto-scrub was attempted, but GitHub rejected the cleanup commit: ${markdownCode(status.reason)}. Please remove the lockfile changes manually.`,
    ];
  }
  return [];
}

export function githubApi(token, options = {}) {
  const api = createGitHubApi(token, { ...options, userAgent: "openclaw-dependency-guard" });
  return {
    ...api,
    graphql: async (query, variables) => {
      const result = await api.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      });
      if (Array.isArray(result.errors) && result.errors.length > 0) {
        const error = new Error(
          result.errors.map((entry) => entry.message ?? "GraphQL error").join("; "),
        );
        error.errors = result.errors;
        throw error;
      }
      return result.data;
    },
  };
}

function decodeContentFile(payload) {
  if (!payload || payload.type !== "file" || typeof payload.content !== "string") {
    return null;
  }
  return Buffer.from(payload.content, payload.encoding ?? "base64").toString("utf8");
}

async function readJsonFileAtRef(api, { owner, repo, path, ref }) {
  if (!ref) {
    return null;
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const payload = await api
    .request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`)
    .catch((error) => {
      if (error?.status === 404) {
        return null;
      }
      throw error;
    });
  const text = decodeContentFile(payload);
  return text ? JSON.parse(text) : null;
}

async function readContentFileMetadataAtRef(api, { owner, repo, path, ref }) {
  if (!ref) {
    return null;
  }
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return api
    .request(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`)
    .catch((error) => {
      if (error?.status === 404) {
        return null;
      }
      throw error;
    });
}

async function readBase64FileAtRef(api, { owner, repo, path, ref }) {
  const file = await readContentFileMetadataAtRef(api, { owner, repo, path, ref });
  if (!file) {
    return null;
  }
  if (file.encoding === "base64" && typeof file.content === "string" && file.content.length > 0) {
    return file.content.replace(/\s+/gu, "");
  }
  if (typeof file.sha === "string" && file.sha.length > 0) {
    const blob = await api.request(`/repos/${owner}/${repo}/git/blobs/${file.sha}`);
    if (blob.encoding === "base64" && typeof blob.content === "string" && blob.content.length > 0) {
      return blob.content.replace(/\s+/gu, "");
    }
  }
  throw new Error(`Unable to read base64 file contents for ${path}`);
}

async function collectDependencyManifestChanges(api, { owner, repo, pullRequest, files }) {
  const { isDependencyManifest } = loadSecurityReviewPolicy();
  const changes = [];
  let mergeBaseSha;
  for (const file of files) {
    const basePath = file.previous_filename ?? file.filename;
    const headPath = file.filename;
    if (!isDependencyManifest(basePath) && !isDependencyManifest(headPath)) {
      continue;
    }
    if (!mergeBaseSha) {
      // Match the PR diff: unrelated dependency updates on the target branch
      // must neither invent nor hide manifest changes introduced by this PR.
      // Page two omits file patches; only the comparison metadata is needed.
      const baseSha = pullRequest.base?.sha;
      const comparison = await api.request(
        `/repos/${owner}/${repo}/compare/${baseSha}...${pullRequest.head?.sha}?per_page=1&page=2`,
      );
      if (
        comparison?.base_commit?.sha !== baseSha ||
        !/^[a-f0-9]{40}$/u.test(comparison?.merge_base_commit?.sha ?? "")
      ) {
        throw new GitHubDiffDataError("GitHub returned an invalid dependency manifest merge base.");
      }
      mergeBaseSha = comparison.merge_base_commit.sha;
    }
    const baseManifest = isDependencyManifest(basePath)
      ? await readJsonFileAtRef(api, { owner, repo, path: basePath, ref: mergeBaseSha })
      : null;
    const headManifest = isDependencyManifest(headPath)
      ? await readJsonFileAtRef(api, { owner, repo, path: headPath, ref: pullRequest.head?.sha })
      : null;
    const fields = dependencyFieldChanges(baseManifest, headManifest);
    if (fields.length > 0 || basePath !== headPath) {
      changes.push({
        path: headPath,
        fields,
        ...(basePath !== headPath ? { previousPath: basePath } : {}),
      });
    }
  }
  return changes;
}

export async function createAutoscrubCommit(
  { baseApi, writeApi, guard },
  { owner, repo, pullRequest, lockfileChanges, targetRepository },
) {
  const headSha = pullRequest.head.sha;
  const headRef = pullRequest.head.ref;
  const writeOwner = targetRepository.owner;
  const writeRepo = targetRepository.repo;
  const additions = [];
  const deletions = [];
  for (const path of lockfileChanges) {
    const contents = await readBase64FileAtRef(baseApi, {
      owner,
      repo,
      path,
      ref: pullRequest.base?.sha,
    });
    if (contents) {
      additions.push({ path, contents });
    } else {
      deletions.push({ path });
    }
  }
  // Recheck after reading file contents: neither an old workflow event nor the
  // detection job authorizes a write after the PR or its approval has changed.
  await assertGuardUnchanged(guard);
  if (await findMaintainerApproval(guard)) {
    return null;
  }
  await assertGuardUnchanged(guard);
  const data = await writeApi.graphql(
    `mutation CreateAutoscrubCommit($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
        }
      }
    }`,
    {
      input: {
        branch: {
          repositoryNameWithOwner: `${writeOwner}/${writeRepo}`,
          branchName: headRef,
        },
        expectedHeadOid: headSha,
        fileChanges: { additions, deletions },
        message: { headline: autoscrubCommitMessage },
      },
    },
  );
  return { sha: data.createCommitOnBranch.commit.oid };
}

async function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(markdown);
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
}

async function setOutput(name, value) {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }
  await appendFile(outputPath, `${name}=${value}\n`);
}

export async function reviewDependencyChanges(
  prepared,
  mode = process.env.OPENCLAW_DEPENDENCY_GUARD_MODE ?? "enforce",
) {
  const guard = await openGuard(
    {
      context: "openclaw/dependency-review",
      commentMarker: dependencyGraphGuardMarker,
      approvalCommand: dependencyApprovalCommand,
    },
    prepared,
  );
  if (!guard) {
    return true;
  }
  const { api, owner, repo, pullRequest, issuePath, files } = guard;
  const { isDependencyFile, isDependencyManifest, isPackageLockfile } = loadSecurityReviewPolicy();
  if (!["detect", "autoscrub", "enforce"].includes(mode)) {
    throw new Error(`Unknown dependency guard mode: ${mode}`);
  }
  const dependencyFiles = [
    ...new Set(files.flatMap((file) => [file.filename, file.previous_filename])),
  ]
    .filter((filename) => typeof filename === "string" && isDependencyFile(filename))
    .toSorted((left, right) => left.localeCompare(right));
  const lockfileChanges = dependencyFiles.filter(isPackageLockfile);
  const dependencyManifestChanges = await collectDependencyManifestChanges(api, {
    owner,
    repo,
    pullRequest,
    files,
  });
  const dependencyGraphFiles = [
    ...dependencyFiles,
    ...dependencyManifestChanges.map((change) => change.path),
  ].toSorted((left, right) => left.localeCompare(right));
  const approval = dependencyGraphFiles.length > 0 ? await findMaintainerApproval(guard) : null;
  let dependencyGraphChanges = [];
  // A package removal does not waive review of patches or workspace policy.
  if (dependencyGraphFiles.length > 0 && !approval && dependencyFiles.every(isPackageLockfile)) {
    dependencyGraphChanges = await api.paginate(
      `/repos/${owner}/${repo}/dependency-graph/compare/${pullRequest.base?.sha}...${pullRequest.head?.sha}`,
    );
  }
  // Moving dependency files can change package resolution even when GitHub's
  // graph reports only removals. A renamed lockfile can also become an artifact
  // that automatic cleanup must preserve for maintainer review.
  const renamedDependencyFile = files.some(
    (file) =>
      file.previous_filename &&
      [file.previous_filename, file.filename].some(
        (filename) => isDependencyFile(filename) || isDependencyManifest(filename),
      ),
  );
  const removalOnly =
    !renamedDependencyFile && isRemovalOnlyDependencyGraphChange(dependencyGraphChanges);
  const autoscrubCandidate =
    !renamedDependencyFile &&
    shouldAutoscrubDependencyLockfiles({
      dependencyFiles,
      lockfileChanges,
      dependencyManifestChanges,
    });
  const autoscrubTarget =
    autoscrubCandidate && !approval && !removalOnly
      ? autoscrubTargetRepository({ owner, repo, pullRequest })
      : null;
  if (mode === "detect") {
    await setOutput("autoscrub", String(Boolean(autoscrubTarget)));
    if (autoscrubTarget) {
      await setOutput("autoscrub-owner", autoscrubTarget.owner);
      await setOutput("autoscrub-repository", autoscrubTarget.repo);
    }
    await writeSummary(
      "## Dependency Guard\n\nDependency analysis complete; the final guard job publishes the review result.",
    );
    return true;
  }

  const comments = await api.paginate(`${issuePath}/comments`);
  const labels = await api.paginate(`${issuePath}/labels`);
  const trustedCommentAuthors = dependencyGuardCommentAuthors(
    process.env.OPENCLAW_DEPENDENCY_GUARD_COMMENT_BOTS,
  );
  const findComment = (marker) =>
    comments.find((comment) =>
      isDependencyGuardMarkerComment(comment, marker, trustedCommentAuthors),
    );
  const existingGuardComment = findComment(dependencyGraphGuardMarker);
  const { removeLabelIfPresent, addLabelIfMissing, deleteCommentIfPresent, upsertComment } =
    createIssueMutationHelpers({
      api,
      issuePath,
      owner,
      repo,
      labelNames: new Set(labels.map((label) => label.name)),
    });
  // Consolidate the former awareness and enforcement comments into one notice.
  await deleteCommentIfPresent(findComment(dependencyChangeMarker));
  if (dependencyGraphFiles.length === 0) {
    await removeLabelIfPresent(dependencyChangedLabel);
    if (existingGuardComment && !isAutoscrubbedDependencyComment(existingGuardComment)) {
      await upsertComment(
        existingGuardComment,
        renderClearedDependencyGuardComment({ headSha: pullRequest.head.sha }),
      );
    }
    await writeSummary("## Dependency Guard\n\nNo dependency-related file changes detected.");
    if (mode === "enforce") {
      return await finishGuard(guard, { description: "No dependency changes require review." });
    }
    return true;
  }
  await addLabelIfMissing(dependencyChangedLabel);

  let autoscrubStatus = null;
  if (mode === "autoscrub") {
    if (autoscrubTarget) {
      try {
        const token = process.env.OPENCLAW_DEPENDENCY_GUARD_AUTOSCRUB_TOKEN;
        if (!token) {
          await writeSummary(
            "## Dependency Guard\n\nAutomatic lockfile cleanup is unavailable because no write token could be created. Remove the lockfile changes manually or request maintainer approval. Final dependency review remains required.",
          );
          // Optional cleanup cannot grant approval; the final enforcement step
          // still evaluates these unchanged dependency files.
          return false;
        }
        const commit = await createAutoscrubCommit(
          { baseApi: api, writeApi: githubApi(token), guard },
          { owner, repo, pullRequest, lockfileChanges, targetRepository: autoscrubTarget },
        );
        if (!commit) {
          await writeSummary(
            "## Dependency Guard\n\nMaintainer approval arrived; lockfile changes were preserved.",
          );
          return true;
        }
        await removeLabelIfPresent(dependencyChangedLabel);
        const body = renderAutoscrubbedDependencyComment({
          baseBranch: pullRequest.base.ref,
          lockfileChanges,
          commitSha: commit.sha,
        });
        await upsertComment(existingGuardComment, body);
        await writeSummary(body);
        return true;
      } catch (error) {
        if (
          error instanceof GitHubRateLimitError ||
          error instanceof GitHubDiffDataError ||
          error instanceof SupersededReviewError
        ) {
          throw error;
        }
        autoscrubStatus = {
          kind: "failed",
          reason: error instanceof Error ? error.message : String(error),
        };
        console.warn(`Autoscrub failed: ${autoscrubStatus.reason}`);
      }
    } else {
      await writeSummary(
        "## Dependency Guard\n\nNo unapproved lockfile-only change needs autoscrub.",
      );
      return true;
    }
  } else if (autoscrubCandidate && !autoscrubTarget && !approval && !removalOnly) {
    autoscrubStatus = { kind: "not-attempted" };
  } else if (lockfileChanges.length > 0 && dependencyManifestChanges.length > 0) {
    autoscrubStatus = {
      kind: "blocked-by-dependency-manifest-fields",
      changes: dependencyManifestChanges,
    };
  } else if (lockfileChanges.length > 0) {
    const otherFiles = dependencyFiles.filter((path) => !isPackageLockfile(path));
    if (otherFiles.length > 0) {
      autoscrubStatus = { kind: "blocked-by-other-dependency-files", files: otherFiles };
    }
  }

  if (mode === "enforce") {
    const allowed = await finishGuard(guard, {
      description: removalOnly
        ? "Dependency removals are informational."
        : "Dependency review requirements satisfied.",
      requiresApproval: !removalOnly,
    });
    if (allowed) {
      const body = removalOnly
        ? renderRemovalOnlyDependencyComment({
            dependencyGraphChanges,
            headSha: pullRequest.head.sha,
          })
        : withApprovalRequest(
            guard,
            renderApprovedDependencyComment(guard.approval, {
              lockfileChanges,
              dependencyFiles,
              dependencyManifestChanges,
            }),
          );
      await upsertComment(existingGuardComment, body);
      await writeSummary(body);
      return true;
    }
  }
  const body = withApprovalRequest(
    guard,
    renderBlockedDependencyComment({
      baseBranch: pullRequest.base.ref,
      headSha: pullRequest.head.sha,
      lockfileChanges,
      dependencyManifestChanges,
      autoscrubStatus,
      dependencyFiles,
    }),
  );
  await upsertComment(existingGuardComment, body);
  await writeSummary(body);
  if (autoscrubStatus?.kind === "failed") {
    throw new Error(`Dependency lockfile autoscrub failed: ${autoscrubStatus.reason}`);
  }
  return false;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  reviewDependencyChanges().catch(
    /** @param {unknown} error */ (error) => {
      if (error instanceof SupersededReviewError) {
        console.log(error.message);
        return;
      }
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
