import type { ControlUiLinkReaderDocument } from "openclaw/plugin-sdk/control-ui-link-reader";
import { ControlUiGitHubError, isRecord, requiredString } from "./github-api.js";

type Checks = NonNullable<ControlUiLinkReaderDocument["checks"]>;
type Check = Checks["items"][number];
type JsonPage = { value: unknown; hasNextPage: boolean };
type CheckPage = { items: Check[]; total: number; truncated: boolean };
const CHECK_LIMIT = 100;
const LABEL_MAX_CHARS = 256;
const STATE_ORDER = { failure: 0, pending: 1, success: 2, neutral: 3 };
type CheckState = Pick<Check, "state" | "detail">;
const RUN_STATES = new Map<unknown, CheckState>([
  ["queued", { state: "pending", detail: "Queued" }],
  ["in_progress", { state: "pending", detail: "In progress" }],
  ["waiting", { state: "pending", detail: "Waiting" }],
  ["requested", { state: "pending", detail: "Waiting" }],
  ["pending", { state: "pending", detail: "Waiting" }],
]);
const RUN_CONCLUSIONS = new Map<unknown, CheckState>([
  ["success", { state: "success", detail: "Passed" }],
  ["neutral", { state: "neutral", detail: "Neutral" }],
  ["skipped", { state: "neutral", detail: "Skipped" }],
  ["failure", { state: "failure", detail: "Failed" }],
  ["cancelled", { state: "failure", detail: "Canceled" }],
  ["timed_out", { state: "failure", detail: "Timed out" }],
  ["action_required", { state: "failure", detail: "Action required" }],
  ["stale", { state: "failure", detail: "Stale" }],
  ["startup_failure", { state: "failure", detail: "Could not start" }],
]);
const STATUS_STATES = new Map<unknown, CheckState>([
  ["success", { state: "success", detail: "Passed" }],
  ["pending", { state: "pending", detail: "Pending" }],
  ["failure", { state: "failure", detail: "Failed" }],
  ["error", { state: "failure", detail: "Error" }],
]);

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
  const url = URL.parse(value);
  return url?.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
}

function checkState(entry: Record<string, unknown>, kind: "runs" | "statuses"): CheckState {
  const state =
    kind === "statuses"
      ? STATUS_STATES.get(entry.state)
      : entry.status === "completed"
        ? RUN_CONCLUSIONS.get(entry.conclusion)
        : RUN_STATES.get(entry.status);
  if (!state) {
    throw new ControlUiGitHubError(
      502,
      kind === "runs"
        ? "GitHub check returned an unknown state"
        : "GitHub commit status returned an unknown state",
    );
  }
  return state;
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
    latest.set(key, {
      id,
      item: {
        name: name.slice(0, LABEL_MAX_CHARS),
        ...checkState(entry, kind),
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
