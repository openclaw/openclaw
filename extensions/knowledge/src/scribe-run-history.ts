import { t } from "./i18n/index.js";
import { button, chip, clock, el } from "./page-dom.js";
import {
  statusFromText,
  type ScribeRun,
  type ScribeSnapshot,
  type ScribeStatus,
} from "./scribes-state.js";

const STATUS_TONE: Record<ScribeStatus, string> = {
  available: "",
  starting: "",
  on: "scribe-chip-on",
  attention: "scribe-chip-warn",
  paused: "",
  failing: "scribe-chip-warn",
  done: "scribe-chip-on",
  missing: "scribe-chip-warn",
};
export const statusChip = (status: ScribeStatus) => {
  const tone = STATUS_TONE[status];
  const node = chip(t(`knowledge.scribes.status.${status}`));
  if (tone) {
    node.classList.add(tone);
  }
  return node;
};
/** "Oct 26, 3:52 AM" in the viewer's locale. */
export const when = (ms: number) => {
  const at = new Date(ms);
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock(at.toISOString())}`;
};
// Count copy with one and other forms under `key`.
export const plural = (key: string, n: number) =>
  t(`${key}.${n === 1 ? "one" : "other"}`, { count: n.toLocaleString() });

/** A run that errored, or was skipped because it could not complete. */
const runFailed = (run: ScribeRun) => run.status === "error" || run.completionStatus === "failed";

// "3 recent runs, all succeeded" / "1 of 3 recent runs failed" from run history.
export function runsSummary(runs: ScribeRun[]) {
  if (!runs.length) {
    return "";
  }
  const failed = runs.filter(runFailed).length,
    skipped = runs.filter((run) => run.status === "skipped" && !runFailed(run)).length;
  if (failed) {
    return t(
      runs.length === 1 ? "knowledge.scribes.runs.failedOne" : "knowledge.scribes.runs.failed",
      { count: String(failed), total: runs.length.toLocaleString() },
    );
  }
  return skipped
    ? t(
        runs.length === 1 ? "knowledge.scribes.runs.skippedOne" : "knowledge.scribes.runs.skipped",
        { count: String(skipped), total: runs.length.toLocaleString() },
      )
    : plural("knowledge.scribes.runs.succeeded", runs.length);
}

// Keep diagnostic failure details in the run’s own view.
function runText(run: ScribeRun) {
  if (run.status === "skipped") {
    return t("knowledge.scribes.runs.skippedRun");
  }
  // A scribe run's summary is its final reply; its status line holds the one-sentence summary.
  return run.summary
    ? statusFromText(run.summary)?.summary || run.summary
    : t("knowledge.scribes.runs.finished");
}

export function renderScribeRunHistory(
  snapshot: ScribeSnapshot,
  runs: ScribeRun[],
  basePath: string,
  runHistoryFailed: boolean,
  redact: (text: string) => string,
) {
  const { job, session } = snapshot;
  const history = el("section", undefined, "scribe-history");
  history.append(
    el(
      "h3",
      t(job ? "knowledge.scribes.recentRuns" : "knowledge.scribes.lastResult"),
      "knowledge-eyebrow",
    ),
  );
  const rows = el("div", undefined, "knowledge-surface");
  for (const run of runs) {
    const line = el("div", undefined, "scribe-run");
    const end = el("span", undefined, "scribe-run-end");
    const failed = runFailed(run);
    if (failed) {
      end.append(statusChip("failing"));
    }
    // A run in its own session keeps its chat history there, not in the scribe’s parent session;
    // the Automations page shows it, also after that session is cleaned up.
    let summary: string | HTMLElement = failed ? "" : runText(run);
    if (job && run.runId && run.sessionKey && run.sessionKey !== session?.key) {
      const params = new URLSearchParams({ job: job.id, run: run.runId });
      const href = `${basePath}/automations?${params}`;
      end.append(
        button(
          t("knowledge.scribes.openRun"),
          () => window.location.assign(href),
          "knowledge-quiet knowledge-small",
        ),
      );
    } else if (failed) {
      const diagnostic = run.error ? redact(run.error).trim() : "";
      if (diagnostic) {
        const disclosure = el("details");
        disclosure.append(
          el("summary", t("knowledge.scribes.runs.showDetails")),
          el("p", diagnostic),
        );
        summary = disclosure;
      } else {
        summary = t(
          run.status === "skipped"
            ? "knowledge.scribes.runs.skippedIncomplete"
            : "knowledge.scribes.runs.noDetails",
        );
      }
    }
    line.append(
      el("time", when(run.runAtMs ?? run.ts)),
      typeof summary === "string" ? el("span", summary) : summary,
      end,
    );
    rows.append(line);
  }
  if (runHistoryFailed) {
    const failure = el(
      "p",
      t("knowledge.scribes.recentRunsFailed"),
      "scribe-empty knowledge-error",
    );
    failure.setAttribute("role", "alert");
    rows.append(failure);
  } else if (!runs.length && snapshot.result) {
    const line = el("div", undefined, "scribe-run");
    line.append(
      el("time", t("knowledge.scribes.latest")),
      el("span", snapshot.result.summary),
      el("span"),
    );
    rows.append(line);
  }
  if (!rows.children.length) {
    rows.append(
      el(
        "p",
        t(job ? "knowledge.scribes.noRuns" : "knowledge.scribes.noResult"),
        "scribe-empty knowledge-muted",
      ),
    );
  }
  history.append(rows);
  return history;
}
