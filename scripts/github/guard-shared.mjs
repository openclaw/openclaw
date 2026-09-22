import { appendFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";
import { readBoundedResponseText } from "../lib/bounded-response.mjs";

export const GITHUB_ERROR_BODY_MAX_BYTES = 64 * 1024;
export const GITHUB_RESPONSE_BODY_MAX_BYTES = 4 * 1024 * 1024;
export const GITHUB_API_REQUEST_TIMEOUT_MS = 30_000;

const githubApiRetryStatuses = new Set([500, 502, 503, 504]);
const githubApiRetryCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const githubApiRetryDelaysMs = [1_000, 2_000, 4_000];
// One primary quota window plus room for a fresh evaluation. Persist the deadline
// across detect/autoscrub/enforce so each step cannot start another hour of waits.
const securityReviewBudgetMs = 65 * 60_000;
const recoveryDeadlineEnv = "OPENCLAW_SECURITY_REVIEW_DEADLINE_MS";

export class GitHubRateLimitError extends Error {
  constructor(message, response) {
    super(message);
    this.status = response.status;
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const retryAfter = response.headers.get("retry-after");
    const retrySeconds = retryAfter === null ? Number.NaN : Number(retryAfter);
    const retryAt = Number.isFinite(retrySeconds)
      ? Date.now() + Math.max(0, retrySeconds) * 1_000
      : Date.parse(retryAfter ?? "");
    this.retryAt = Math.max(
      remaining === "0" && Number.isFinite(reset) ? reset * 1_000 : 0,
      Number.isFinite(retryAt) ? retryAt : 0,
    );
  }
}

export class GitHubStatusPublicationError extends Error {
  constructor(cause) {
    super(cause.message, { cause });
  }
}

export class GitHubDiffDataError extends Error {}

export async function withSecurityReviewRecovery(evaluate) {
  const recorded = process.env[recoveryDeadlineEnv];
  const deadline = recorded === undefined ? Date.now() + securityReviewBudgetMs : Number(recorded);
  if (!Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new Error("Invalid Security Review recovery deadline.");
  }
  if (recorded === undefined && process.env.GITHUB_ENV) {
    await appendFile(process.env.GITHUB_ENV, `${recoveryDeadlineEnv}=${deadline}\n`);
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await evaluate();
    } catch (error) {
      const rateLimited = error instanceof GitHubRateLimitError;
      const inconsistentDiff = error instanceof GitHubDiffDataError;
      if (!rateLimited && !inconsistentDiff && !(error instanceof GitHubStatusPublicationError)) {
        throw error;
      }
      // Do not resume a status write with stale authority after waiting. The
      // caller restarts from live PR, file, comment, role, and CI observations.
      const delay = rateLimited
        ? Math.max(error.retryAt - Date.now(), 60_000 * 2 ** attempt) +
          1_000 +
          Math.floor(Math.random() * 15_000)
        : inconsistentDiff
          ? 60_000 * 2 ** attempt
          : githubApiRetryDelaysMs[attempt];
      if (attempt >= 3 || Date.now() + delay + GITHUB_API_REQUEST_TIMEOUT_MS > deadline) {
        throw new Error(
          inconsistentDiff
            ? `GitHub diff-data recovery budget exhausted; security review remains incomplete. ${error.message}`
            : "GitHub API recovery budget exhausted; security review remains incomplete.",
          { cause: error },
        );
      }
      console.warn(
        `${rateLimited ? `GitHub API rate limited (${error.status})` : inconsistentDiff ? error.message : `GitHub status publication failed (${error.message})`}; retrying the complete evaluation in ${Math.ceil(delay / 1_000)}s (attempt ${attempt + 1}/3).`,
      );
      await wait(delay);
    }
  }
}

const approvalCommands = new Set([
  "/allow-security-sensitive-change",
  "/allow-dependencies-change",
]);

export function parseApprovalCommands(body) {
  const lines = (body ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.every((line) => approvalCommands.has(line)) ? lines : [];
}

// Commit statuses are the publisher's durable record of which PRs it evaluated.
// GitHub's commit-to-PR association index is incomplete across fork repositories.
export async function readSecurityReviewHistory(api, owner, repo, head) {
  const contexts = new Set([
    "openclaw/ci-gate",
    "openclaw/security-sensitive-review",
    "openclaw/dependency-review",
  ]);
  const statuses = await api.paginate(`/repos/${owner}/${repo}/commits/${head}/statuses`);
  const numbers = new Set();
  const counts = new Map();
  for (const status of statuses) {
    const context = typeof status.context === "string" ? status.context.toLowerCase() : "";
    if (!contexts.has(context)) {
      continue;
    }
    counts.set(context, (counts.get(context) ?? 0) + 1);
    if (status.creator?.login !== "github-actions[bot]" || status.creator?.type !== "Bot") {
      continue;
    }
    const recorded = /^PR #([1-9][0-9]*): /u.exec(status.description ?? "");
    if (recorded && Number.isSafeInteger(Number(recorded[1]))) {
      numbers.add(Number(recorded[1]));
    }
  }
  return { pullRequestNumbers: [...numbers].toSorted((left, right) => left - right), counts };
}

export async function publishGuardStatus(guard, state, description) {
  if (state === "success") {
    // GitHub statuses belong to commits, while author and comment authority
    // belong to PRs. Never lend one PR's approval to another PR with that head.
    const history = await readSecurityReviewHistory(
      guard.api,
      guard.owner,
      guard.repo,
      guard.pullRequest.head.sha,
    );
    // GitHub refuses writes after 1,000 statuses per commit/context. Stop
    // successes early so exhaustion cannot leave a permanently green result.
    if ((history.counts.get(guard.context) ?? 0) >= 900) {
      await publishGuardStatus(
        guard,
        "failure",
        "Review status capacity is nearly exhausted; push a new commit",
      );
      throw new Error("Review status capacity is nearly exhausted; push a new commit.");
    }
    if (!history.pullRequestNumbers.includes(guard.pullRequest.number)) {
      throw new Error("The current PR's security review status was not recorded.");
    }
    for (const number of history.pullRequestNumbers) {
      if (number === guard.pullRequest.number) {
        continue;
      }
      const other = await guard.api.request(`/repos/${guard.owner}/${guard.repo}/pulls/${number}`);
      if (
        other.state === "open" &&
        other.base?.ref === guard.pullRequest.base.ref &&
        other.head?.sha === guard.pullRequest.head.sha
      ) {
        await publishGuardStatus(
          guard,
          "failure",
          "Multiple PRs use this head; close duplicates or push a distinct commit",
        );
        throw new Error(
          "Multiple open PRs use the same head. Close duplicate PRs or push a distinct commit; security review updates automatically.",
        );
      }
    }
  }
  try {
    await guard.api.request(
      `/repos/${guard.owner}/${guard.repo}/statuses/${guard.pullRequest.head.sha}`,
      {
        method: "POST",
        body: JSON.stringify({
          context: guard.context,
          state,
          description: `PR #${guard.pullRequest.number}: ${description}`,
          target_url: guard.runUrl,
        }),
      },
    );
  } catch (error) {
    if (githubApiRetryStatuses.has(error?.status) || githubApiRetryCodes.has(error?.code)) {
      throw new GitHubStatusPublicationError(error);
    }
    throw error;
  }
}

export function sanitizeGuardDisplayValue(value) {
  return String(value)
    .replace(/[\p{Cc}]/gu, "?")
    .slice(0, 240);
}

/**
 * @param {string | null | undefined} value
 * @param {string} [fallback]
 */
export function normalizeGuardLoginSet(value, fallback = "") {
  return new Set(
    (value ?? fallback)
      .split(/[\s,]+/u)
      .map((login) => login.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function createIssueMutationHelpers({
  api,
  issuePath,
  owner,
  repo,
  labelNames,
  warn = console.warn,
}) {
  const ignoreUnavailableWritePermission = (action) => (error) => {
    if (error instanceof GitHubRateLimitError) {
      throw error;
    }
    if (error?.status === 403) {
      warn(
        `Skipping ${action}; GitHub API rejected the request: ${sanitizeGuardDisplayValue(error.message)}`,
      );
      return;
    }
    if (error?.status === 404 || error?.status === 422) {
      warn(`${action} is unavailable.`);
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
  const deleteCommentIfPresent = async (comment) => {
    if (!comment) {
      return;
    }
    await api
      .request(`/repos/${owner}/${repo}/issues/comments/${comment.id}`, {
        method: "DELETE",
      })
      .catch(ignoreUnavailableWritePermission("comment deletion"));
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
  return { removeLabelIfPresent, addLabelIfMissing, deleteCommentIfPresent, upsertComment };
}

function githubErrorBodyTooLarge(maxBytes) {
  return new Error(`GitHub error response body exceeded ${maxBytes} bytes`);
}

function githubResponseBodyTooLarge(maxBytes) {
  return new Error(`GitHub response body exceeded ${maxBytes} bytes`);
}

export async function readBoundedGitHubErrorText(
  response,
  maxBytes = GITHUB_ERROR_BODY_MAX_BYTES,
  options = {},
) {
  return await readBoundedResponseText(response, "GitHub error", maxBytes, {
    createTooLargeError: () => githubErrorBodyTooLarge(maxBytes),
    ...options,
  });
}

export async function readBoundedGitHubJson(
  response,
  maxBytes = GITHUB_RESPONSE_BODY_MAX_BYTES,
  options = {},
) {
  const text = await readBoundedResponseText(response, "GitHub", maxBytes, {
    createTooLargeError: () => githubResponseBodyTooLarge(maxBytes),
    ...options,
  });
  return JSON.parse(text);
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

export function createGitHubApi(token, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? GITHUB_API_REQUEST_TIMEOUT_MS;
  const retryDelaysMs = options.retryDelaysMs ?? githubApiRetryDelaysMs;
  const responseMaxBodyBytes = options.responseMaxBodyBytes ?? GITHUB_RESPONSE_BODY_MAX_BYTES;
  const baseHeaders = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": options.userAgent,
    "x-github-api-version": "2022-11-28",
  };
  const request = async (path, requestOptions = {}) => {
    const method = (requestOptions.method ?? "GET").toUpperCase();
    const timeoutController = new AbortController();
    const requestSignal = combineAbortSignals([requestOptions.signal, timeoutController.signal]);
    let timeout;
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timeoutController.abort();
        reject(timeoutError(path, method, timeoutMs));
      }, timeoutMs);
      timeout.unref?.();
    });
    const operationPromise = (async () => {
      for (let attempt = 0; ; attempt += 1) {
        let response;
        try {
          response = await fetchImpl(`https://api.github.com${path}`, {
            ...requestOptions,
            signal: requestSignal,
            headers: { ...baseHeaders, ...requestOptions.headers },
          });
        } catch (error) {
          // Node fetch wraps transport failures in a TypeError with the socket
          // or resolver error as its cause. Unknown failures must not be retried.
          const code = error?.cause?.code ?? error?.code;
          if (
            (method === "GET" || method === "HEAD") &&
            !requestSignal.aborted &&
            githubApiRetryCodes.has(code) &&
            attempt < retryDelaysMs.length
          ) {
            await wait(retryDelaysMs[attempt], undefined, { signal: requestSignal });
            continue;
          }
          const detail = error instanceof Error ? error.message : String(error);
          const requestError = new Error(
            `GitHub API ${method} ${path} failed: ${code ? `${code}: ` : ""}${detail}`,
            { cause: error },
          );
          if (!requestSignal.aborted) {
            requestError.code = code;
          }
          throw requestError;
        }
        if (response.status === 204) {
          return null;
        }
        if (!response.ok) {
          if (
            (method === "GET" || method === "HEAD") &&
            githubApiRetryStatuses.has(response.status) &&
            attempt < retryDelaysMs.length
          ) {
            await response.body?.cancel().catch(() => {});
            await wait(retryDelaysMs[attempt], undefined, { signal: requestSignal });
            continue;
          }
          let errorText;
          try {
            errorText = await readBoundedGitHubErrorText(response, GITHUB_ERROR_BODY_MAX_BYTES, {
              signal: timeoutController.signal,
              timeoutPromise,
            });
          } catch (bodyError) {
            errorText = bodyError instanceof Error ? bodyError.message : String(bodyError);
          }
          const message = `GitHub API ${method} ${path} failed: ${response.status} ${response.statusText}: ${errorText}`;
          if (
            (response.status === 403 || response.status === 429) &&
            (response.status === 429 ||
              response.headers.get("x-ratelimit-remaining") === "0" ||
              response.headers.has("retry-after") ||
              /(?:API rate limit exceeded|secondary rate limit)/iu.test(errorText))
          ) {
            throw new GitHubRateLimitError(message, response);
          }
          const error = new Error(message);
          error.status = response.status;
          throw error;
        }
        return await readBoundedGitHubJson(response, responseMaxBodyBytes, {
          signal: timeoutController.signal,
          timeoutPromise,
        });
      }
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
