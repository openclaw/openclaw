#!/usr/bin/env node

// GitHub security-sensitive file guard: detects sensitive boundary files,
// manages sticky comments/labels, and requires SHA-bound secops/admin approval.
import { appendFile, readFile } from "node:fs/promises";
import { readBoundedResponseText } from "../lib/bounded-response.mjs";

/** Marker used to identify security-sensitive guard comments. */
export const securitySensitiveGuardMarker = "<!-- openclaw:security-sensitive-guard -->";
export const securitySensitiveChangedLabel = "security-sensitive-changed";
export const allowSecuritySensitiveCommand = "/allow-security-sensitive-change";
export const GITHUB_ERROR_BODY_MAX_BYTES = 64 * 1024;
export const GITHUB_API_REQUEST_TIMEOUT_MS = 30_000;

const securityTeamSlug = process.env.OPENCLAW_SECURITY_TEAM_SLUG ?? "openclaw-secops";
const maxListedFiles = 25;
const securitySensitiveFiles = [
  {
    path: ".gitignore",
    reason:
      "Controls ignored secret and local files, including common `.env` files, before they can be accidentally committed.",
  },
];

export function securitySensitiveFileDefinitions() {
  return securitySensitiveFiles.map((entry) => ({ ...entry }));
}

export function securitySensitiveFileDefinition(filename) {
  return securitySensitiveFiles.find((entry) => entry.path === filename) ?? null;
}

export function isSecuritySensitiveFile(filename) {
  return securitySensitiveFileDefinition(filename) !== null;
}

export function sanitizeDisplayValue(value) {
  return String(value)
    .replace(/[\p{Cc}]/gu, "?")
    .slice(0, 240);
}

export function markdownCode(value) {
  return `\`${sanitizeDisplayValue(value).replaceAll("`", "\\`")}\``;
}

function* securitySensitiveOverrideCandidates({ comments, expectedSha, newerThan }) {
  if (!expectedSha) {
    return;
  }
  const commandPattern = /^\/allow-security-sensitive-change(?:\s+(.+))?$/gimu;
  for (const comment of comments.toReversed()) {
    const body = comment.body ?? "";
    for (const match of body.matchAll(commandPattern)) {
      const reason = match[1]?.trim();
      const login = comment.user?.login;
      if (!login || !isCommentNewerThan(comment, newerThan)) {
        continue;
      }
      yield {
        login,
        reason: reason ? sanitizeDisplayValue(reason) : null,
        sha: expectedSha,
        url: comment.html_url,
      };
    }
  }
}

export function findSecuritySensitiveOverrideCommand({
  comments,
  expectedSha,
  isSecurityMember,
  newerThan,
}) {
  for (const candidate of securitySensitiveOverrideCandidates({
    comments,
    expectedSha,
    newerThan,
  })) {
    if (isSecurityMember(candidate.login)) {
      return candidate;
    }
  }
  return null;
}

export async function findSecuritySensitiveOverrideCommandAsync(input) {
  for (const candidate of securitySensitiveOverrideCandidates(input)) {
    if (await input.isSecurityMember(candidate.login)) {
      return candidate;
    }
  }
  return null;
}

function isCommentNewerThan(comment, newerThan) {
  if (!newerThan) {
    return false;
  }
  const commentTime = Date.parse(comment.created_at ?? "");
  const barrierTime = Date.parse(newerThan);
  return Number.isFinite(commentTime) && Number.isFinite(barrierTime) && commentTime > barrierTime;
}

export function securitySensitiveGuardCommentHeadSha(comment) {
  const body = comment?.body ?? "";
  const patterns = [
    /Approved SHA:\s+`([a-f0-9]{40})`/iu,
    /current head SHA\s+\(`([a-f0-9]{40})`\)/iu,
    /Current SHA:\s+`([a-f0-9]{40})`/iu,
  ];
  for (const pattern of patterns) {
    const match = body.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }
  return null;
}

export function securitySensitiveOverrideExpectedSha(existingGuardComment, currentHeadSha) {
  if (
    !currentHeadSha ||
    existingGuardComment?.body?.includes("### Security-sensitive changes are blocked") !== true
  ) {
    return null;
  }
  return securitySensitiveGuardCommentHeadSha(existingGuardComment) === currentHeadSha
    ? currentHeadSha
    : null;
}

export function isSecuritySensitiveGuardAuthorizedForHead(comment, currentHeadSha) {
  return (
    Boolean(currentHeadSha) &&
    comment?.body?.includes("### Security-sensitive change authorized") === true &&
    securitySensitiveGuardCommentHeadSha(comment) === currentHeadSha
  );
}

export function isSecuritySensitiveGuardTrustedForHead(comment, currentHeadSha) {
  return (
    Boolean(currentHeadSha) &&
    comment?.body?.includes("### Security-sensitive changes noted") === true &&
    securitySensitiveGuardCommentHeadSha(comment) === currentHeadSha
  );
}

export function securityApproverSet(value) {
  return new Set(
    String(value ?? "")
      .split(/[\s,]+/u)
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function securitySensitiveGuardCommentAuthors(value) {
  return new Set(
    String(value ?? "github-actions[bot]")
      .split(/[\s,]+/u)
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isSecuritySensitiveGuardMarkerComment(comment, trustedAuthors) {
  const login = comment.user?.login?.toLowerCase();
  return Boolean(
    login && trustedAuthors.has(login) && comment.body?.includes(securitySensitiveGuardMarker),
  );
}

function sortedSecuritySensitiveChanges(filenames) {
  const byPath = new Map();
  for (const filename of filenames) {
    if (typeof filename !== "string") {
      continue;
    }
    const definition = securitySensitiveFileDefinition(filename);
    if (definition) {
      byPath.set(definition.path, definition);
    }
  }
  return [...byPath.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

export function collectSecuritySensitiveChanges(files) {
  const filenames = [];
  for (const file of files) {
    if (typeof file === "string") {
      filenames.push(file);
      continue;
    }
    if (file && typeof file === "object") {
      filenames.push(file.filename, file.previous_filename);
    }
  }
  return sortedSecuritySensitiveChanges(filenames);
}

function renderChangedFileLines(changes) {
  const listedFiles = changes.slice(0, maxListedFiles);
  const omittedCount = changes.length - listedFiles.length;
  const lines = listedFiles.map(
    (change) => `- ${markdownCode(change.path)}: ${sanitizeDisplayValue(change.reason)}`,
  );
  if (omittedCount > 0) {
    lines.push(`- ${omittedCount} additional security-sensitive files not shown`);
  }
  return lines;
}

export function renderSecuritySensitiveAwarenessComment(changes) {
  return [
    securitySensitiveGuardMarker,
    "",
    "### Security-sensitive file changes detected",
    "",
    "This PR changes files that define security boundaries. Maintainers should confirm these changes are intentional.",
    "",
    "Changed files:",
    ...renderChangedFileLines(changes),
    "",
    "Maintainer follow-up:",
    "- Review whether each security-sensitive file change is intentional.",
    "- Confirm the change does not weaken secret, credential, or local-state protection.",
    "- If this PR intentionally needs the change, a repository admin or member of `@openclaw/openclaw-secops` must approve the exact head SHA.",
  ].join("\n");
}

export function renderAuthorizedSecuritySensitiveComment(override) {
  const lines = [
    securitySensitiveGuardMarker,
    "",
    "### Security-sensitive change authorized",
    "",
    "This PR includes security-sensitive file changes. A repository admin or member of `@openclaw/openclaw-secops` authorized this exact head SHA with `/allow-security-sensitive-change`.",
    "",
    `- Approved SHA: ${markdownCode(override.sha)}`,
    `- Approved by: @${sanitizeDisplayValue(override.login)}`,
  ];
  if (override.reason) {
    lines.push(`- Reason: ${markdownCode(override.reason)}`);
  }
  lines.push("", "A later push changes the PR head SHA and requires a fresh security approval.");
  return lines.join("\n");
}

export function renderTrustedSecuritySensitiveComment({ actor, headSha, changes }) {
  return [
    securitySensitiveGuardMarker,
    "",
    "### Security-sensitive changes noted",
    "",
    "This PR includes security-sensitive file changes. The guard is informational because the PR author is a repository admin or a member of `@openclaw/openclaw-secops`.",
    "",
    `- Current SHA: ${markdownCode(headSha ?? "<head-sha>")}`,
    `- Trusted actor: @${sanitizeDisplayValue(actor.login)}`,
    `- Trusted role: ${markdownCode(actor.reason)}`,
    "",
    "Changed files:",
    ...renderChangedFileLines(changes),
    "",
    "Security review is still recommended before merge when the change is intentional.",
  ].join("\n");
}

export function renderClearedSecuritySensitiveGuardComment({ headSha }) {
  return [
    securitySensitiveGuardMarker,
    "",
    "### Security-sensitive guard cleared",
    "",
    "This PR no longer has blocked security-sensitive file changes. A future security-sensitive change requires a fresh `/allow-security-sensitive-change` comment after the guard blocks that new head SHA.",
    "",
    `- Current SHA: ${markdownCode(headSha ?? "<head-sha>")}`,
  ].join("\n");
}

export function renderBlockedSecuritySensitiveComment({ headSha, changes }) {
  return [
    securitySensitiveGuardMarker,
    "",
    "### Security-sensitive changes are blocked",
    "",
    "OpenClaw does not accept security-sensitive file changes through PRs unless a repository admin or security explicitly authorizes the current head SHA.",
    "",
    "Detected security-sensitive changes:",
    ...renderChangedFileLines(changes),
    "",
    "If this PR intentionally needs these changes, ask a repository admin or member of `@openclaw/openclaw-secops` to comment:",
    "",
    "```text",
    allowSecuritySensitiveCommand,
    "```",
    "",
    `The action will approve the current head SHA (${markdownCode(headSha ?? "<head-sha>")}) when it reruns. A later push requires a fresh approval.`,
  ].join("\n");
}

export function securitySensitiveGuardTrustedActorCandidates({
  pullRequest,
  event,
  currentHeadSha,
}) {
  const eventHeadSha = event?.pull_request?.head?.sha;
  const eventAfterSha = event?.after;
  const eventMatchesCurrentHead =
    Boolean(currentHeadSha) &&
    (eventHeadSha === currentHeadSha || eventAfterSha === currentHeadSha);
  if (!eventMatchesCurrentHead) {
    return [];
  }
  const candidates = [];
  const seen = new Set();
  for (const [source, login] of [["pull request author", pullRequest?.user?.login]]) {
    if (typeof login !== "string" || login.length === 0) {
      continue;
    }
    const normalizedLogin = login.toLowerCase();
    if (seen.has(normalizedLogin)) {
      continue;
    }
    seen.add(normalizedLogin);
    candidates.push({ login, source });
  }
  return candidates;
}

export async function findTrustedSecuritySensitiveGuardActor({
  candidates,
  isSecuritySensitiveApprover,
}) {
  for (const candidate of candidates) {
    const role = await isSecuritySensitiveApprover(candidate.login);
    if (role) {
      return {
        login: candidate.login,
        reason: `${candidate.source}; ${role}`,
      };
    }
  }
  return null;
}

function githubErrorBodyTooLarge(maxBytes) {
  return new Error(`GitHub error response body exceeded ${maxBytes} bytes`);
}

export async function readBoundedGitHubErrorText(response, maxBytes = GITHUB_ERROR_BODY_MAX_BYTES) {
  return await readBoundedResponseText(response, "GitHub error", maxBytes, {
    createTooLargeError: () => githubErrorBodyTooLarge(maxBytes),
  });
}

function timeoutError(path, method, timeoutMs) {
  return new Error(`GitHub API ${method} ${path} exceeded timeout ${timeoutMs}ms`);
}

function combineAbortSignals(signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) {
    return undefined;
  }
  if (activeSignals.length === 1) {
    return activeSignals[0];
  }
  return AbortSignal.any(activeSignals);
}

export function githubApi(token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GITHUB_API_REQUEST_TIMEOUT_MS;
  const baseHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "openclaw-security-sensitive-guard",
    "x-github-api-version": "2022-11-28",
  };
  const request = async (path, requestOptions = {}) => {
    const method = requestOptions.method ?? "GET";
    const timeoutController = new AbortController();
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timeoutController.abort();
        reject(timeoutError(path, method, timeoutMs));
      }, timeoutMs);
      timeout.unref?.();
    });
    const operationPromise = (async () => {
      const response = await fetchImpl(`https://api.github.com${path}`, {
        ...requestOptions,
        signal: combineAbortSignals([requestOptions.signal, timeoutController.signal]),
        headers: { ...baseHeaders, ...requestOptions.headers },
      });
      if (response.status === 204) {
        return null;
      }
      if (!response.ok) {
        let errorText;
        try {
          errorText = await readBoundedGitHubErrorText(response);
        } catch (bodyError) {
          errorText = bodyError instanceof Error ? bodyError.message : String(bodyError);
        }
        const error = new Error(`${response.status} ${response.statusText}: ${errorText}`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    })();
    operationPromise.catch(() => {});
    try {
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
  };
  return {
    request,
    paginate: async (path) => {
      const items = [];
      for (let page = 1; ; page += 1) {
        const separator = path.includes("?") ? "&" : "?";
        const pageItems = await request(`${path}${separator}per_page=100&page=${page}`);
        items.push(...pageItems);
        if (pageItems.length < 100) {
          return items;
        }
      }
    },
  };
}

async function writeSummary(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    console.log(markdown);
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !eventPath || !repository) {
    throw new Error("GITHUB_TOKEN, GITHUB_EVENT_PATH, and GITHUB_REPOSITORY are required.");
  }
  const [owner, repo] = repository.split("/");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  const eventPullRequest = event.pull_request;
  if (!eventPullRequest) {
    console.log("No pull_request payload found; skipping.");
    return;
  }

  const api = githubApi(token);
  const explicitSecurityApprovers = securityApproverSet(process.env.OPENCLAW_SECURITY_APPROVERS);
  const trustedCommentAuthors = securitySensitiveGuardCommentAuthors(
    process.env.OPENCLAW_SECURITY_SENSITIVE_GUARD_COMMENT_BOTS,
  );
  const issuePath = `/repos/${owner}/${repo}/issues/${eventPullRequest.number}`;
  const pullPath = `/repos/${owner}/${repo}/pulls/${eventPullRequest.number}`;
  const pullRequest = await api.request(pullPath);
  const mode = process.env.OPENCLAW_SECURITY_SENSITIVE_GUARD_MODE ?? "enforce";
  const files = await api.paginate(`${pullPath}/files`);
  const securitySensitiveChanges = collectSecuritySensitiveChanges(files);

  const [comments, labels] = await Promise.all([
    api.paginate(`${issuePath}/comments`),
    api.paginate(`${issuePath}/labels`),
  ]);
  const existingGuardComment = comments.find((comment) =>
    isSecuritySensitiveGuardMarkerComment(comment, trustedCommentAuthors),
  );
  const labelNames = new Set(labels.map((label) => label.name));

  const ignoreUnavailableWritePermission = (action) => (error) => {
    if (error?.status === 403) {
      console.warn(`Skipping ${action}; token does not have write permission.`);
      return;
    }
    if (error?.status === 404 || error?.status === 422) {
      console.warn(`${action} is unavailable.`);
      return;
    }
    throw error;
  };
  const removeLabelIfPresent = async (label) => {
    if (!labelNames.has(label)) {
      return;
    }
    await api
      .request(`${issuePath}/labels/${encodeURIComponent(label)}`, {
        method: "DELETE",
      })
      .catch(ignoreUnavailableWritePermission(`label "${label}" removal`));
    labelNames.delete(label);
  };
  const addLabelIfMissing = async (label) => {
    if (labelNames.has(label)) {
      return;
    }
    await api
      .request(`${issuePath}/labels`, {
        method: "POST",
        body: JSON.stringify({ labels: [label] }),
      })
      .catch(ignoreUnavailableWritePermission(`label "${label}" update`));
    labelNames.add(label);
  };
  const upsertComment = async (comment, body) => {
    if (comment) {
      return await api
        .request(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        })
        .catch(ignoreUnavailableWritePermission("comment update"));
    }
    return await api
      .request(`${issuePath}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      })
      .catch(ignoreUnavailableWritePermission("comment creation"));
  };

  if (securitySensitiveChanges.length === 0) {
    await removeLabelIfPresent(securitySensitiveChangedLabel);
    if (existingGuardComment) {
      await upsertComment(
        existingGuardComment,
        renderClearedSecuritySensitiveGuardComment({ headSha: pullRequest.head?.sha }),
      );
    }
    await writeSummary(
      "## Security Sensitive Guard\n\nNo security-sensitive file changes detected.",
    );
    console.log("No security-sensitive file changes detected.");
    return;
  }

  await addLabelIfMissing(securitySensitiveChangedLabel);
  await writeSummary(
    [
      "## Security Sensitive Guard",
      "",
      `Detected ${securitySensitiveChanges.length} security-sensitive file change(s).`,
      "",
      ...securitySensitiveChanges.map((change) => `- ${markdownCode(change.path)}`),
    ].join("\n"),
  );
  console.log(`Detected ${securitySensitiveChanges.length} security-sensitive file change(s).`);

  const membershipCache = new Map();
  const permissionCache = new Map();
  const isSecurityMember = async (login) => {
    const normalizedLogin = login.toLowerCase();
    if (explicitSecurityApprovers.has(normalizedLogin)) {
      return true;
    }
    if (membershipCache.has(normalizedLogin)) {
      return membershipCache.get(normalizedLogin);
    }
    try {
      const membership = await api.request(
        `/orgs/${owner}/teams/${securityTeamSlug}/memberships/${encodeURIComponent(login)}`,
      );
      const allowed = membership?.state === "active";
      membershipCache.set(normalizedLogin, allowed);
      return allowed;
    } catch (error) {
      if (error?.status !== 404) {
        console.warn(`Could not verify ${login} against ${securityTeamSlug}: ${error.message}`);
      }
      membershipCache.set(normalizedLogin, false);
      return false;
    }
  };
  const isRepositoryAdmin = async (login) => {
    const normalizedLogin = login.toLowerCase();
    if (permissionCache.has(normalizedLogin)) {
      return permissionCache.get(normalizedLogin);
    }
    try {
      const result = await api.request(
        `/repos/${owner}/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      );
      const allowed = result?.permission === "admin";
      permissionCache.set(normalizedLogin, allowed);
      return allowed;
    } catch (error) {
      if (error?.status !== 404) {
        console.warn(`Could not verify repository permission for ${login}: ${error.message}`);
      }
      permissionCache.set(normalizedLogin, false);
      return false;
    }
  };
  const isSecuritySensitiveApprover = async (login) => {
    if (await isSecurityMember(login)) {
      return securityTeamSlug;
    }
    if (await isRepositoryAdmin(login)) {
      return "repository admin";
    }
    return null;
  };
  const currentHeadSha = pullRequest.head?.sha;
  if (isSecuritySensitiveGuardTrustedForHead(existingGuardComment, currentHeadSha)) {
    await writeSummary(
      [
        "## Security Sensitive Guard",
        "",
        `Security-sensitive changes remain informational for a trusted actor at ${markdownCode(currentHeadSha)}.`,
      ].join("\n"),
    );
    console.log("Security-sensitive changes remain informational for this head SHA.");
    return;
  }
  const trustedActor = await findTrustedSecuritySensitiveGuardActor({
    candidates: securitySensitiveGuardTrustedActorCandidates({
      pullRequest,
      event,
      currentHeadSha,
    }),
    isSecuritySensitiveApprover,
  });
  if (trustedActor) {
    await upsertComment(
      existingGuardComment,
      renderTrustedSecuritySensitiveComment({
        actor: trustedActor,
        changes: securitySensitiveChanges,
        headSha: currentHeadSha,
      }),
    );
    await writeSummary(
      [
        "## Security Sensitive Guard",
        "",
        `Security-sensitive changes noted for trusted actor @${sanitizeDisplayValue(trustedActor.login)} and allowed to continue.`,
      ].join("\n"),
    );
    console.log("Security-sensitive changes noted for trusted actor; guard is informational.");
    return;
  }
  if (isSecuritySensitiveGuardAuthorizedForHead(existingGuardComment, currentHeadSha)) {
    await writeSummary(
      [
        "## Security Sensitive Guard",
        "",
        `Security-sensitive changes remain authorized for ${markdownCode(currentHeadSha)}.`,
      ].join("\n"),
    );
    console.log("Security-sensitive changes remain authorized for this head SHA.");
    return;
  }
  const override = await findSecuritySensitiveOverrideCommandAsync({
    comments,
    expectedSha: securitySensitiveOverrideExpectedSha(existingGuardComment, currentHeadSha),
    isSecurityMember: async (login) => Boolean(await isSecuritySensitiveApprover(login)),
    newerThan: existingGuardComment?.updated_at ?? existingGuardComment?.created_at,
  });
  if (override) {
    await upsertComment(existingGuardComment, renderAuthorizedSecuritySensitiveComment(override));
    await writeSummary(
      [
        "## Security Sensitive Guard",
        "",
        `Security-sensitive changes authorized by @${sanitizeDisplayValue(override.login)} for ${markdownCode(override.sha)}.`,
      ].join("\n"),
    );
    console.log("Security-sensitive changes authorized by trusted override.");
    return;
  }
  if (mode === "detect") {
    await upsertComment(
      existingGuardComment,
      renderSecuritySensitiveAwarenessComment(securitySensitiveChanges),
    );
    await writeSummary(
      "## Security Sensitive Guard\n\nSecurity-sensitive enforcement deferred to the final guard job.",
    );
    console.log("Security-sensitive enforcement deferred to the final guard job.");
    return;
  }

  await upsertComment(
    existingGuardComment,
    renderBlockedSecuritySensitiveComment({
      changes: securitySensitiveChanges,
      headSha: pullRequest.head?.sha,
    }),
  );
  await writeSummary(
    "## Security Sensitive Guard\n\nSecurity-sensitive changes are blocked without a current admin or secops override.",
  );
  throw new Error(
    "Security-sensitive changes require removal or a current admin or secops override.",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(
    /** @param {unknown} error */ (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    },
  );
}
