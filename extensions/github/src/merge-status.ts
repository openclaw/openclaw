import {
  ControlUiGitHubError,
  fetchGitHubApi,
  isRecord,
  readGitHubJsonResponse,
} from "./github-api.js";

const OID = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_MESSAGE_LENGTH = 4096;

export type GitHubAsyncMergeTarget = {
  owner: string;
  repo: string;
  number: number;
  url: string;
  headSha: string;
};

export type GitHubAsyncMergeStatus = {
  status: "pending" | "merged" | "enqueued" | "failed" | "unavailable";
  message: string;
  sha?: string;
  retryAfterMs?: number;
};

export type GitHubAsyncMergeReceipt = GitHubAsyncMergeStatus & { uuid: string | null };

function message(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= MAX_MESSAGE_LENGTH
    ? value
        // oxlint-disable-next-line eslint/no-control-regex -- Strip control characters from external API messages before displaying them.
        .replace(/[\u0000-\u001f\u007f]/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 512)
    : undefined;
}

function unavailable(detail = "Merge status is unavailable; check the pull request on GitHub.") {
  return { status: "unavailable" as const, message: detail };
}

export function githubAsyncMergeReceiptRef(number: number): string {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new TypeError("Invalid pull request number");
  }
  return `refs/openclaw/pr-merge-outcomes/${number}`;
}

/** Local receipts identify a request to observe, never authority to submit or repeat a merge. */
export function parseGitHubAsyncMergeReceipt(
  raw: string,
  target: GitHubAsyncMergeTarget,
): GitHubAsyncMergeReceipt | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_RECEIPT_BYTES) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const url = URL.parse(target.url);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[A-Za-z0-9_.-]+$/u.test(target.owner) ||
    !/^[A-Za-z0-9_.-]+$/u.test(target.repo) ||
    !Number.isSafeInteger(target.number) ||
    target.number < 1 ||
    !OID.test(target.headSha) ||
    url.pathname.toLowerCase() !==
      `/${target.owner}/${target.repo}/pull/${target.number}`.toLowerCase() ||
    !isRecord(value) ||
    !isRecord(value.repo) ||
    value.version !== 1 ||
    value.pr !== target.number ||
    value.head !== target.headSha ||
    typeof value.repo.nameWithOwner !== "string" ||
    value.repo.nameWithOwner.toLowerCase() !== `${target.owner}/${target.repo}`.toLowerCase() ||
    typeof value.repo.url !== "string" ||
    value.repo.url.toLowerCase() !== `${url.origin}/${target.owner}/${target.repo}`.toLowerCase() ||
    value.transport !== "rest" ||
    value.route !== "immediate" ||
    value.method !== "squash" ||
    !isRecord(value.asyncMerge)
  ) {
    return null;
  }
  const result = value.asyncMerge;
  const detail = message(result.message);
  if (
    detail === undefined ||
    (result.uuid !== null && (typeof result.uuid !== "string" || !UUID.test(result.uuid)))
  ) {
    return null;
  }
  if (value.phase !== "intent") {
    return ["merged", "commenting", "commented", "complete"].includes(String(value.phase)) &&
      typeof value.landed === "string" &&
      OID.test(value.landed) &&
      value.accepted === true
      ? { uuid: null, status: "merged", message: detail, sha: value.landed }
      : null;
  }
  if (result.status === "submitting") {
    return value.accepted === false && result.uuid === null && result.sha === null
      ? {
          uuid: null,
          ...unavailable(
            "Merge submission is unconfirmed; check the retained request before retrying.",
          ),
        }
      : null;
  }
  if (value.accepted !== true) {
    return null;
  }
  if (result.status === "pending" && typeof result.uuid === "string" && result.sha === null) {
    return { uuid: result.uuid, status: "pending", message: detail };
  }
  if (result.status === "merged" && typeof result.sha === "string" && OID.test(result.sha)) {
    return { uuid: null, status: "merged", message: detail, sha: result.sha };
  }
  return (result.status === "enqueued" || result.status === "failed") && result.sha === null
    ? { uuid: null, status: result.status, message: detail }
    : null;
}

/** The host supplies current session and managed credential authority for every read. */
export async function readGitHubAsyncMergeStatus(
  target: GitHubAsyncMergeTarget,
  receipt: GitHubAsyncMergeReceipt,
  options: {
    identity: { token: string; revalidate: () => Promise<void>; assertSelected: () => void };
    apiBaseUrl: string;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<GitHubAsyncMergeStatus> {
  const { identity, signal } = options;
  const assertCurrent = async () => {
    signal?.throwIfAborted();
    await identity.revalidate();
    identity.assertSelected();
    signal?.throwIfAborted();
  };
  await assertCurrent();
  if (!identity.token) {
    return unavailable();
  }
  if (receipt.status !== "pending") {
    const { uuid: _uuid, ...status } = receipt;
    return identity.token && status.message.includes(identity.token) ? unavailable() : status;
  }
  if (!receipt.uuid || !UUID.test(receipt.uuid)) {
    return unavailable();
  }
  try {
    const url = `${options.apiBaseUrl}/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/pulls/${target.number}/merge-async/${receipt.uuid}`;
    const response = await fetchGitHubApi(
      url,
      options.fetchImpl ?? fetch,
      identity.token,
      async () => {
        throw new ControlUiGitHubError(409, "Merge request repository changed");
      },
      identity,
      undefined,
      signal,
      undefined,
      options.apiBaseUrl,
      { apiVersion: "2026-03-10", cacheControl: "max-age=0" },
    );
    const value = await readGitHubJsonResponse(response, MAX_RESPONSE_BYTES);
    await assertCurrent();
    if (response.status !== 200 || !isRecord(value) || !isRecord(value.details)) {
      return unavailable();
    }
    const details = value.details;
    const detail = message(details.message);
    if (detail === undefined || (identity.token && detail.includes(identity.token))) {
      return unavailable();
    }
    if (value.status === "pending") {
      return details.uuid === receipt.uuid &&
        details.expected_head_sha === target.headSha &&
        details.merge_method === "squash" &&
        details.merge_action === "direct_merge" &&
        (details.bypass_rules === undefined || details.bypass_rules === false)
        ? { status: "pending", message: detail }
        : unavailable("Merge request no longer matches the prepared pull request head or options.");
    }
    if (value.status === "merged" && typeof details.sha === "string" && OID.test(details.sha)) {
      return { status: "merged", message: detail, sha: details.sha };
    }
    return value.status === "enqueued" || value.status === "failed"
      ? { status: value.status, message: detail }
      : unavailable();
  } catch (error) {
    // Permission loss and expired results both use 404. Neither proves a failed merge.
    await assertCurrent();
    const retryAfterMs = error instanceof ControlUiGitHubError ? error.retryAfterMs : undefined;
    return { ...unavailable(), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  }
}
