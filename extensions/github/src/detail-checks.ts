import type { ControlUiLinkReaderDocument } from "openclaw/plugin-sdk/control-ui-link-reader";
import { ControlUiGitHubError, isRecord, requiredString } from "./github-api.js";

type Checks = NonNullable<ControlUiLinkReaderDocument["checks"]>;
type Check = Checks["items"][number];
type JsonPage = { value: unknown; hasNextPage: boolean };
type CheckPage = { items: Check[]; total: number; truncated: boolean };
const CHECK_LIMIT = 100;
const LABEL_MAX_CHARS = 256;
const STATE_ORDER = { failure: 0, pending: 1, success: 2, neutral: 3 };

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ControlUiGitHubError(502, "GitHub checks returned an invalid count");
  }
  return value;
}

function checkUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function runState(run: Record<string, unknown>): Pick<Check, "state" | "detail"> {
  switch (run.status) {
    case "queued":
      return { state: "pending", detail: "Queued" };
    case "in_progress":
      return { state: "pending", detail: "In progress" };
    case "waiting":
    case "requested":
    case "pending":
      return { state: "pending", detail: "Waiting" };
    case "completed":
      switch (run.conclusion) {
        case "success":
          return { state: "success", detail: "Passed" };
        case "neutral":
          return { state: "neutral", detail: "Neutral" };
        case "skipped":
          return { state: "neutral", detail: "Skipped" };
        case "failure":
          return { state: "failure", detail: "Failed" };
        case "cancelled":
          return { state: "failure", detail: "Canceled" };
        case "timed_out":
          return { state: "failure", detail: "Timed out" };
        case "action_required":
          return { state: "failure", detail: "Action required" };
        case "stale":
          return { state: "failure", detail: "Stale" };
        case "startup_failure":
          return { state: "failure", detail: "Could not start" };
      }
  }
  throw new ControlUiGitHubError(502, "GitHub check returned an unknown state");
}

function statusState(status: Record<string, unknown>): Pick<Check, "state" | "detail"> {
  switch (status.state) {
    case "success":
      return { state: "success", detail: "Passed" };
    case "pending":
      return { state: "pending", detail: "Pending" };
    case "failure":
      return { state: "failure", detail: "Failed" };
    case "error":
      return { state: "failure", detail: "Error" };
  }
  throw new ControlUiGitHubError(502, "GitHub commit status returned an unknown state");
}

function parsePage(page: JsonPage, commit: string, kind: "runs" | "statuses"): CheckPage {
  if (!isRecord(page.value)) {
    throw new ControlUiGitHubError(502, "GitHub checks were not an object");
  }
  const value = page.value;
  const entries = kind === "runs" ? value.check_runs : value.statuses;
  if (!Array.isArray(entries) || (kind === "statuses" && value.sha !== commit)) {
    throw new ControlUiGitHubError(
      502,
      "GitHub checks returned a different revision or invalid list",
    );
  }
  const reportedTotal = count(value.total_count);
  const latest = new Map<string, { id: number; item: Check }>();
  for (const entry of entries.slice(0, CHECK_LIMIT)) {
    if (!isRecord(entry) || (kind === "runs" && entry.head_sha !== commit)) {
      throw new ControlUiGitHubError(
        502,
        "GitHub check returned a different revision or invalid item",
      );
    }
    const id = count(entry.id);
    const name = requiredString(entry, kind === "runs" ? "name" : "context");
    // GitHub's latest filter owns run selection. Different workflows can share
    // an app/name, so only repeated run IDs denote the same check. Legacy
    // statuses instead have explicitly case-insensitive context identities.
    const key = kind === "runs" ? String(id) : name.toLowerCase();
    if ((latest.get(key)?.id ?? -1) >= id) {
      continue;
    }
    const state = kind === "runs" ? runState(entry) : statusState(entry);
    latest.set(key, {
      id,
      item: {
        name: name.slice(0, LABEL_MAX_CHARS),
        ...state,
        url: checkUrl(kind === "runs" ? entry.html_url : entry.target_url),
      },
    });
  }
  const missing = Math.max(0, reportedTotal - Math.min(entries.length, CHECK_LIMIT));
  return {
    items: Array.from(latest.values(), ({ item }) => item),
    total: latest.size + missing,
    truncated: page.hasNextPage || missing > 0 || entries.length > CHECK_LIMIT,
  };
}

export async function fetchPullChecks(
  repositoryUrl: string,
  headSha: unknown,
  url: string,
  fetchPage: (url: string) => Promise<JsonPage>,
): Promise<Checks> {
  if (typeof headSha !== "string" || !/^[a-f0-9]{40}$/u.test(headSha)) {
    return {
      state: "unavailable",
      summary: "Checks unavailable",
      total: 0,
      items: [],
      truncated: true,
      url,
    };
  }
  const commitUrl = repositoryUrl + "/commits/" + headSha;
  const items: Check[] = [];
  let total = 0;
  let truncated = false;
  // Two bounded pages, no per-job reads or pagination. Sequential
  // dispatch lets the existing API cooldown stop a second request on exhaustion.
  for (const kind of ["runs", "statuses"] as const) {
    try {
      const suffix = kind === "runs" ? "/check-runs?filter=latest&per_page=" : "/status?per_page=";
      const page = parsePage(await fetchPage(commitUrl + suffix + CHECK_LIMIT), headSha, kind);
      items.push(...page.items);
      total += page.total;
      truncated ||= page.truncated;
    } catch {
      // Optional CI must not hide the PR body or disclose transport diagnostics.
      truncated = true;
    }
  }
  items.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.name.localeCompare(b.name));
  truncated ||= items.length > CHECK_LIMIT;
  const counts = { success: 0, failure: 0, pending: 0, neutral: 0 };
  for (const item of items) {
    counts[item.state] += 1;
  }
  // Known failures outrank pending work; incomplete data can never imply success.
  // Empty complete responses are neutral, not GitHub's legacy empty "pending".
  const state = counts.failure
    ? "failure"
    : counts.pending
      ? "pending"
      : truncated
        ? "unavailable"
        : counts.success
          ? "success"
          : "neutral";
  const summary =
    [
      truncated ? (items.length ? "Checks incomplete" : "Checks unavailable") : undefined,
      counts.failure ? counts.failure + " failed" : undefined,
      counts.pending ? counts.pending + " pending" : undefined,
      counts.success ? counts.success + " passed" : undefined,
      counts.neutral ? counts.neutral + " skipped or neutral" : undefined,
    ]
      .filter(Boolean)
      .join(" · ") || "No checks reported";
  return {
    state,
    summary,
    total,
    items: items.slice(0, CHECK_LIMIT),
    truncated,
    url,
    commit: headSha,
  };
}
