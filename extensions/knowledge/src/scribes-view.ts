/** The Scribes tab: the list of scribes grouped by state, and one scribe's detail and controls. */
import type { Page } from "./page-context.js";
import { button, chip, clock, el } from "./page-dom.js";
import { openConfirmDialog, openStartDialog, scribeTile } from "./scribe-dialog.js";
import {
  repairScribe,
  retryScribe,
  runScribeNow,
  setScribePaused,
  startScribe,
  turnOffScribe,
} from "./scribes-actions.js";
import { scribeById, scribeLabel, type ScribeSetup } from "./scribes-catalog.js";
import {
  detectSources,
  loadRuns,
  loadScribes,
  resultFromText,
  type ScribeDetection,
  type ScribeJob,
  type ScribeRun,
  type ScribeSnapshot,
  type ScribeStatus,
} from "./scribes-state.js";
import { storeLabel, storeOf } from "./stores-view.js";
import { icon } from "./ui-icons.js";

const STATUS: Record<ScribeStatus, [string, string]> = {
  available: ["Available", ""],
  starting: ["Starting", ""],
  on: ["On", "scribe-chip-on"],
  paused: ["Paused", ""],
  failing: ["Failing", "scribe-chip-warn"],
  done: ["Done", "scribe-chip-on"],
  reauth: ["Needs reauthorization", "scribe-chip-warn"],
};
/**
 * Jobs whose first run this page already forced. A job reads as never run until its forced run
 * starts, so this keeps reloads in that gap from forcing it again. Another page open at the same
 * moment could force a second run; that is a visible, harmless extra run.
 */
const firstRuns = new Set<string>();

/** Scribes the list shows under "On": everything set up that is not finished or startable. */
const isOn = (status: ScribeStatus) => status !== "available" && status !== "done";

const statusChip = (status: ScribeStatus) => {
  const [text, tone] = STATUS[status];
  const node = chip(text);
  if (tone) {
    node.classList.add(tone);
  }
  return node;
};
/** "Oct 26, 3:52 AM" in the viewer's locale. */
const when = (ms: number) => {
  const at = new Date(ms);
  return `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${clock(at.toISOString())}`;
};
const plural = (n: number, one: string) => `${n.toLocaleString()} ${one}${n === 1 ? "" : "s"}`;

/** Human schedule for a scribe automation; daily cron expressions read as a time of day. */
function scheduleText(job: ScribeJob) {
  const { schedule } = job;
  if (schedule.kind === "cron" && schedule.expr) {
    // Daily ("M H * * *") and weekly ("M H * * D", one day 0-7) read as a time of day.
    const fields = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7])$/.exec(schedule.expr.trim());
    const tz = schedule.tz ? ` · ${schedule.tz}` : "";
    if (fields) {
      const at = new Date(2000, 0, 1, Number(fields[2]), Number(fields[1]));
      const clockText = at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
      if (fields[3] === "*") {
        return `Daily, ${clockText}${tz}`;
      }
      // 2000-01-02 was a Sunday, so day N of the week is January 2 + N.
      const day = new Date(2000, 0, 2 + (Number(fields[3]) % 7)).toLocaleDateString(undefined, {
        weekday: "long",
      });
      return `Weekly on ${day}, ${clockText}${tz}`;
    }
    return `${schedule.expr}${tz}`;
  }
  if (schedule.kind === "every" && schedule.everyMs) {
    const minutes = Math.round(schedule.everyMs / 60000);
    return minutes % 60 === 0
      ? `Every ${plural(minutes / 60, "hour")}`
      : `Every ${plural(minutes, "minute")}`;
  }
  if (schedule.kind === "at" && schedule.at) {
    return `Once, ${when(Date.parse(schedule.at))}`;
  }
  return schedule.kind === "event" ? "When Knowledge maintenance asks" : schedule.kind;
}

// The options a scribe was started with, in the dialog's words.
function optionsText(setup: ScribeSetup) {
  const { options } = setup;
  if ("scope" in options) {
    const since: Record<string, string> = {
      "30d": "the last 30 days",
      "90d": "the last 90 days",
      all: "the beginning",
      today: "today",
    };
    return `${options.scope === "all" ? "Active and archived" : "Active"} conversations, from ${since[options.since] ?? "an unknown start"} · ${setup.mode === "once" ? "once" : "keeps learning"}`;
  }
  if ("sources" in options && Array.isArray(options.sources)) {
    const names: Record<string, string> = {
      "memory-md": "MEMORY.md",
      "daily-notes": "daily notes",
      dreams: "Dreaming diary",
    };
    return options.sources.map((source) => names[source] ?? source).join(", ");
  }
  return "No options";
}

// One-line state for an "On" row.
function activeMeta(snapshot: ScribeSnapshot) {
  const { status, job, result } = snapshot;
  const meta = el("span", undefined, "scribe-meta");
  const dot = el("span", undefined, "scribe-dot");
  if (status === "failing" || status === "reauth") {
    dot.classList.add("scribe-dot-warn");
  } else if (status !== "on") {
    dot.classList.add("scribe-dot-idle");
  }
  meta.append(dot);
  const parts: string[] = [];
  if (status === "starting") {
    parts.push("Setting up in its conversation");
  } else if (status === "reauth") {
    parts.push("Its conversation is archived or gone. Repair reconnects it.");
  } else if (status === "paused") {
    parts.push("Paused");
  } else if (firstRunPending(snapshot)) {
    parts.push("First run in progress");
  }
  if (job && status !== "reauth") {
    parts.push(scheduleText(job));
    if (job.state.lastRunAtMs) {
      parts.push(`Last run ${when(job.state.lastRunAtMs)}`);
    }
  }
  if (status === "failing" && job?.state.lastError) {
    parts.push(job.state.lastError);
  } else if (result?.summary && status !== "starting") {
    parts.push(result.summary);
  }
  parts.forEach((part, i) => {
    if (i) {
      meta.append(el("span", "·"));
    }
    meta.append(el("span", part));
  });
  return meta;
}

// Detection facts for an Available row, or nothing when they could not be read.
function detectionMeta(snapshot: ScribeSnapshot, detection: ScribeDetection, agent: string) {
  const { scribe } = snapshot;
  const meta = el("span", undefined, "scribe-meta");
  const { activeConversations: active, archivedConversations: archived, memoryFile } = detection;
  if (snapshot.status === "done" && snapshot.result) {
    meta.append(el("span", `Done · ${snapshot.result.summary}`));
  } else if (scribe.id === "conversations" && (active !== undefined || archived !== undefined)) {
    const counts = [
      active === undefined ? "" : `${active.toLocaleString()} active`,
      archived === undefined ? "" : `${archived.toLocaleString()} archived`,
    ].filter(Boolean);
    meta.append(el("span", `${counts.join(" · ")} conversations on ${agent}`));
  } else if (scribe.id === "memory" && memoryFile !== undefined) {
    meta.append(
      el(
        "span",
        memoryFile === null
          ? `No MEMORY.md on ${agent}`
          : `Found Memory on ${agent}${memoryFile.size === undefined ? "" : ` · MEMORY.md ${Math.max(1, Math.round(memoryFile.size / 1024))} KB`}`,
      ),
    );
  }
  meta.append(chip(scribe.cadence));
  return meta;
}

/** Load the Scribes tab for the viewed agent: the list, or one scribe's detail. */
export async function scribes(ui: Page, n: number, target: HTMLElement) {
  const { s, live } = ui;
  const host = s.context.host;
  const agentId = ui.viewedAgent();
  const selected = scribeById(s.scribe);
  const [snapshots, detection] = await Promise.all([
    loadScribes(host, agentId),
    selected ? Promise.resolve({}) : detectSources(host, agentId).catch(() => ({})),
  ]);
  if (host.connection.canWrite) {
    await Promise.all(snapshots.map((snapshot) => startFirstRun(ui, snapshot)));
  }
  const snapshot = selected && snapshots.find((entry) => entry.scribe.id === selected.id);
  const runs = snapshot?.job ? await loadRuns(host, snapshot.job, agentId).catch(() => []) : [];
  if (!live(n)) {
    return;
  }
  renderScribesTab(ui.scribesTab, snapshots.filter((entry) => isOn(entry.status)).length);
  target.replaceChildren(snapshot ? detail(ui, snapshot, runs) : list(ui, snapshots, detection));
}

/**
 * Force an ongoing scribe's first run once its setup turn reported `on`. Setup turns never run
 * their own job, so the page does it, at most once per job from this page.
 */
async function startFirstRun(ui: Page, snapshot: ScribeSnapshot) {
  const { job } = snapshot;
  if (!snapshot.firstRunDue || !job || firstRuns.has(job.id)) {
    return;
  }
  firstRuns.add(job.id);
  try {
    await runScribeNow(ui.s.context.host, job);
    ui.announce(`${snapshot.scribe.title}: first run started.`);
  } catch (error) {
    // Not started: forget it so the next load tries again and nothing shows it as running.
    firstRuns.delete(job.id);
    ui.announce(`${snapshot.scribe.title}: the first run did not start. ${ui.errorText(error)}`);
  }
}

/** The first run is forced or running and nothing has finished yet. */
const firstRunPending = (snapshot: ScribeSnapshot) =>
  Boolean(
    snapshot.job &&
    !snapshot.job.state.lastRunAtMs &&
    (snapshot.job.state.runningAtMs || firstRuns.has(snapshot.job.id)),
  );

/** Tab label with the count of scribes that are on. */
function renderScribesTab(tab: HTMLButtonElement, on: number) {
  tab.replaceChildren(document.createTextNode("Scribes"));
  if (on) {
    const badge = el("span", String(on), "knowledge-tab-count");
    badge.setAttribute("aria-hidden", "true");
    tab.append(badge);
  }
}

// Shared page facts: agent display name and the viewed store's label.
function pageNames(ui: Page) {
  const agentId = ui.viewedAgent();
  const entry = ui.s.storesSnapshot && storeOf(ui.s.storesSnapshot, agentId);
  return {
    agentId,
    agentName: ui.displayName(agentId),
    storeName: entry ? storeLabel(entry, ui.displayName) : "Knowledge",
  };
}

// Open the start dialog; a successful start shows the scribe's detail.
function start(ui: Page, snapshot: ScribeSnapshot, detection: ScribeDetection) {
  const { agentId, agentName, storeName } = pageNames(ui);
  const host = ui.s.context.host;
  const attempt = crypto.randomUUID();
  openStartDialog({
    scribe: snapshot.scribe,
    agentId,
    agentName,
    storeName,
    detection,
    canWrite: host.connection.canWrite,
    start: async (setup) => {
      await startScribe(host, snapshot, setup, attempt);
      ui.announce(`Started ${scribeLabel(snapshot.scribe)}.`);
      openScribe(ui, snapshot.scribe.id);
    },
  });
}

/** Show one scribe's detail, or the list for an empty id. */
function openScribe(ui: Page, id: string) {
  ui.s.scribe = id;
  void ui.load();
}

function list(ui: Page, snapshots: ScribeSnapshot[], detection: ScribeDetection) {
  const { agentName, storeName } = pageNames(ui);
  const canWrite = ui.s.context.host.connection.canWrite;
  const root = el("div", undefined, "scribes");
  root.append(
    el(
      "p",
      `Scribes keep ${storeName} up to date on their own. Each one is a conversation you own that follows a skill shipped with Knowledge, once or on a schedule. Open one any time to see exactly what it did.`,
      "scribes-intro",
    ),
  );
  const on = snapshots.filter((entry) => isOn(entry.status)),
    rest = snapshots.filter((entry) => !isOn(entry.status));
  for (const [heading, group] of [
    ["On", on],
    ["Available", rest],
  ] as const) {
    if (!group.length) {
      continue;
    }
    root.append(el("h3", `${heading} · ${group.length}`, "knowledge-eyebrow"));
    const surface = el("div", undefined, "knowledge-surface");
    for (const snapshot of group) {
      surface.append(
        isOn(snapshot.status)
          ? activeRow(ui, snapshot)
          : availableRow(ui, snapshot, detection, agentName, canWrite),
      );
    }
    root.append(surface);
  }
  root.append(
    el(
      "p",
      "Scribes run as you, with your private access, and use your agent’s default model. Ongoing scribes also appear on the Automations page.",
      "knowledge-muted scribes-footnote",
    ),
  );
  return root;
}

function activeRow(ui: Page, snapshot: ScribeSnapshot) {
  const { scribe } = snapshot;
  const row = el("div", undefined, "scribe-row");
  const link = button("", () => openScribe(ui, scribe.id), "scribe-row-link");
  const copy = el("span", undefined, "scribe-copy");
  copy.append(el("span", scribe.title, "scribe-title"), activeMeta(snapshot));
  link.append(scribeTile(scribe), copy);
  const actions = el("span", undefined, "scribe-actions");
  const chevron = button(
    "",
    () => openScribe(ui, scribe.id),
    "knowledge-quiet knowledge-icon-button",
  );
  chevron.setAttribute("aria-label", `Open ${scribe.title}`);
  chevron.append(icon("chevronRight", 16));
  actions.append(statusChip(snapshot.status), chevron);
  row.append(link, actions);
  return row;
}

function availableRow(
  ui: Page,
  snapshot: ScribeSnapshot,
  detection: ScribeDetection,
  agentName: string,
  canWrite: boolean,
) {
  const { scribe } = snapshot;
  const row = el("div", undefined, "scribe-row");
  const copy = el("span", undefined, "scribe-copy");
  copy.append(
    el("span", scribe.title, "scribe-title"),
    el("span", scribe.blurb, "scribe-blurb"),
    detectionMeta(snapshot, detection, agentName),
  );
  const actions = el("span", undefined, "scribe-actions");
  if (snapshot.status === "done") {
    actions.append(
      button("Details", () => openScribe(ui, scribe.id), "knowledge-quiet knowledge-small"),
    );
  }
  const startButton = button(
    scribe.startLabel,
    () => start(ui, snapshot, detection),
    "knowledge-button knowledge-primary knowledge-small",
  );
  startButton.disabled = !canWrite;
  if (!canWrite) {
    startButton.title = "Starting a scribe needs write access to this Gateway.";
  }
  actions.append(startButton);
  row.append(scribeTile(scribe), copy, actions);
  return row;
}

/** A run that errored, or was skipped because it could not complete. */
const runFailed = (run: ScribeRun) => run.status === "error" || run.completionStatus === "failed";

// "3 recent runs, all succeeded" / "1 of 3 recent runs failed" from run history.
function runsSummary(runs: ScribeRun[]) {
  if (!runs.length) {
    return "";
  }
  const failed = runs.filter(runFailed).length,
    skipped = runs.filter((run) => run.status === "skipped" && !runFailed(run)).length;
  if (failed) {
    return `${failed} of ${plural(runs.length, "recent run")} failed`;
  }
  return skipped
    ? `${skipped} of ${plural(runs.length, "recent run")} skipped`
    : `${plural(runs.length, "recent run")}, all succeeded`;
}

// One run's line: its error when it failed or was skipped, otherwise its summary.
function runText(run: ScribeRun) {
  if (runFailed(run)) {
    return run.error ?? "Failed";
  }
  if (run.status === "skipped") {
    return run.error ? `Skipped: ${run.error}` : "Skipped";
  }
  // A scribe run's summary is its final reply; its result line is the one-sentence summary.
  return run.summary ? (resultFromText(run.summary)?.summary ?? run.summary) : "Finished";
}

function detail(ui: Page, snapshot: ScribeSnapshot, runs: ScribeRun[]) {
  const { scribe, job, session, status } = snapshot;
  const host = ui.s.context.host;
  const { agentId, agentName, storeName } = pageNames(ui);
  const canWrite = host.connection.canWrite;
  const root = el("div", undefined, "scribe-detail");
  const crumb = button("", () => openScribe(ui, ""), "knowledge-quiet knowledge-crumb");
  crumb.append(icon("arrowLeft", 14), el("span", "Scribes"));
  const head = el("div", undefined, "scribe-detail-head");
  const heading = el("div");
  heading.append(el("h2", scribe.title), el("p", scribe.blurb, "knowledge-muted"));
  const feedback = el("p", "", "knowledge-dialog-feedback");
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  const actions = el("span", undefined, "scribe-actions");
  const controls: HTMLButtonElement[] = [];
  // Run one control at a time, then reload the detail to show the Gateway's state.
  const control = (
    text: string,
    run: () => Promise<unknown>,
    done: string,
    className = "knowledge-button knowledge-small",
  ) => {
    const node = button(
      text,
      () => {
        controls.forEach((other) => (other.disabled = true));
        feedback.textContent = "";
        feedback.className = "knowledge-dialog-feedback";
        const restore = () => controls.forEach((other) => (other.disabled = !canWrite));
        run().then(
          () => {
            restore();
            ui.announce(done);
            void ui.load();
          },
          (error: unknown) => {
            restore();
            feedback.textContent = ui.errorText(error);
            feedback.classList.add("knowledge-error");
          },
        );
      },
      className,
    );
    node.disabled = !canWrite;
    controls.push(node);
    return node;
  };
  if (job && status !== "reauth") {
    actions.append(
      control("Run now", () => runScribeNow(host, job), `${scribe.title} is running.`),
    );
  }
  if (session && !session.archived) {
    actions.append(
      button(
        "Open conversation",
        () => host.sessions.open({ sessionKey: session.key, agentId }),
        "knowledge-button knowledge-small",
      ),
    );
  }
  // A failed one-time scribe starts over with its setup; an ongoing one repairs its automation.
  const once = !job && (snapshot.setup?.mode ?? scribe.modes[0]) === "once";
  if (status === "failing" && once) {
    actions.append(
      control(
        "Retry",
        () => retryScribe(host, snapshot, agentId),
        `Asked ${scribeLabel(scribe)} to start over.`,
      ),
    );
  } else if (status === "reauth" || status === "failing") {
    actions.append(
      control(
        "Repair",
        () => repairScribe(host, snapshot, agentId),
        `Asked ${scribeLabel(scribe)} to repair its setup.`,
      ),
    );
  }
  if (job && status !== "reauth") {
    const paused = !job.enabled;
    actions.append(
      control(
        paused ? "Resume" : "Pause",
        () => setScribePaused(host, job, !paused),
        paused ? `${scribe.title} resumed.` : `${scribe.title} paused.`,
      ),
    );
  }
  if (job) {
    const turnOff = button(
      "Turn off…",
      () =>
        openConfirmDialog(
          `Turn off ${scribe.title}?`,
          `Its automation is removed and it stops running. The conversation ${scribeLabel(scribe)} is kept, so you can still read what it did.`,
          "Turn off",
          async () => {
            await turnOffScribe(host, job);
            ui.announce(`${scribe.title} turned off.`);
            void ui.load();
          },
        ),
      "knowledge-quiet knowledge-small",
    );
    turnOff.disabled = !canWrite;
    actions.append(turnOff);
  }
  if (!job && (status === "available" || status === "done")) {
    const again = button(
      scribe.startLabel,
      () => start(ui, snapshot, {}),
      "knowledge-button knowledge-primary knowledge-small",
    );
    again.disabled = !canWrite;
    actions.append(again);
  }
  head.append(scribeTile(scribe), heading, actions);

  const statusValue = el("span", undefined, "scribe-status");
  statusValue.append(statusChip(status));
  const summary = runsSummary(runs);
  if (summary) {
    statusValue.append(el("span", ` · ${summary}`));
  }
  const lastRun = runs[0];
  const facts: [string, string | Node][] = [["Status", statusValue]];
  if (job) {
    facts.push(
      ["Schedule", scheduleText(job)],
      [
        "Next run",
        job.state.runningAtMs
          ? "Running now"
          : !job.enabled
            ? "Paused"
            : job.state.nextRunAtMs
              ? when(job.state.nextRunAtMs)
              : "Not scheduled",
      ],
      [
        "Last run",
        job.state.lastRunAtMs
          ? [
              when(job.state.lastRunAtMs),
              job.state.lastDurationMs === undefined
                ? ""
                : `${Math.max(1, Math.round(job.state.lastDurationMs / 60000))} min`,
              lastRun?.usage?.total_tokens === undefined
                ? ""
                : `${Math.round(lastRun.usage.total_tokens / 1000)}k tokens`,
            ]
              .filter(Boolean)
              .join(" · ")
          : "Not run yet",
      ],
    );
  } else if (snapshot.setup?.mode === "once") {
    facts.push(["Schedule", "Once, nothing scheduled"]);
  }
  facts.push(
    [
      "Conversation",
      session
        ? `${scribeLabel(scribe)}${session.createdAt ? ` · started ${when(session.createdAt)}` : ""}${session.archived ? " · archived" : ""}`
        : "Gone",
    ],
    ["Model", lastRun?.model ?? `${agentName}’s default`],
    ["Store", storeName],
  );
  if (snapshot.setup) {
    facts.push(["Options", optionsText(snapshot.setup)]);
  }
  facts.push(["Follows", `${scribe.skill} skill · ships with Knowledge`]);
  if (job) {
    facts.push([
      "If it fails",
      job.failureAlert === false
        ? "No alert"
        : job.failureAlert
          ? `Alert after ${plural(job.failureAlert.after ?? 1, "failed run")}`
          : "Default failure alert",
    ]);
  }
  const grid = el("dl", undefined, "knowledge-surface knowledge-facts");
  for (const [key, value] of facts) {
    const item = el("div");
    const dd = el("dd");
    dd.append(value);
    item.append(el("dt", key), dd);
    grid.append(item);
  }

  const history = el("section", undefined, "scribe-history");
  history.append(el("h3", job ? "Recent runs" : "Last result", "knowledge-eyebrow"));
  const rows = el("div", undefined, "knowledge-surface");
  for (const run of runs) {
    const line = el("div", undefined, "scribe-run");
    line.append(
      el("time", when(run.runAtMs ?? run.ts)),
      el("span", runText(run)),
      runFailed(run) ? statusChip("failing") : el("span"),
    );
    rows.append(line);
  }
  if (!runs.length && firstRunPending(snapshot)) {
    const line = el("div", undefined, "scribe-run");
    line.append(el("time", "First run"), el("span", "Running now"), el("span"));
    rows.append(line);
  } else if (!runs.length && snapshot.result) {
    const line = el("div", undefined, "scribe-run");
    line.append(el("time", "Latest"), el("span", snapshot.result.summary), el("span"));
    rows.append(line);
  }
  if (!rows.children.length) {
    rows.append(
      el(
        "p",
        job ? "No runs yet." : "No result yet. Open the conversation to follow along.",
        "scribe-empty knowledge-muted",
      ),
    );
  }
  history.append(rows);
  root.append(crumb, head, feedback, grid, history);
  return root;
}
