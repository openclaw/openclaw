import { t } from "./i18n/index.js";
/** The Scribes tab: the list of scribes grouped by state, and one scribe's detail and controls. */
import type { Page } from "./page-context.js";
import { button, chip, clock, el } from "./page-dom.js";
import {
  openConfirmDialog,
  openStartDialog,
  pluginButton,
  pluginStateText,
  scribeTile,
} from "./scribe-dialog.js";
import {
  repairScribe,
  runScribeNow,
  setScribePaused,
  startScribe,
  turnOffScribe,
} from "./scribes-actions.js";
import { scribeById, scribeLabel } from "./scribes-catalog.js";
import {
  detectSources,
  loadRuns,
  loadScribes,
  neededPluginState,
  statusFromText,
  type ScribeDetection,
  type ScribeJob,
  type ScribeRun,
  type ScribeSnapshot,
  type ScribeStatus,
} from "./scribes-state.js";
import { storeLabel, storeOf } from "./stores-view.js";
import { icon } from "./ui-icons.js";

const STATUS_TONE: Record<ScribeStatus, string> = {
  available: "",
  starting: "",
  on: "scribe-chip-on",
  paused: "",
  failing: "scribe-chip-warn",
  done: "scribe-chip-on",
  missing: "scribe-chip-warn",
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
  const tone = STATUS_TONE[status];
  const node = chip(t(`knowledge.scribes.status.${status}`));
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
// "a, b and c".
const listText = (items: string[]) =>
  items.length > 1
    ? t("knowledge.common.andList", { items: items.slice(0, -1).join(", "), last: items.at(-1)! })
    : (items[0] ?? "");
// Count copy with one and other forms under `key`.
const plural = (key: string, n: number) =>
  t(`${key}.${n === 1 ? "one" : "other"}`, { count: n.toLocaleString() });

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
        return t("knowledge.scribes.schedule.daily", { time: clockText }) + tz;
      }
      // 2000-01-02 was a Sunday, so day N of the week is January 2 + N.
      const day = new Date(2000, 0, 2 + (Number(fields[3]) % 7)).toLocaleDateString(undefined, {
        weekday: "long",
      });
      return t("knowledge.scribes.schedule.weekly", { day, time: clockText }) + tz;
    }
    // Weekdays at one or more hours ("M H1,H2 * * 1-5") read as their times of day.
    const weekdays = /^(\d{1,2}) (\d{1,2}(?:,\d{1,2})*) \* \* 1-5$/.exec(schedule.expr.trim());
    if (weekdays) {
      const times = weekdays[2]!.split(",").map((hour) =>
        new Date(2000, 0, 1, Number(hour), Number(weekdays[1])).toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        }),
      );
      return t("knowledge.scribes.schedule.weekdays", { times: listText(times) }) + tz;
    }
    return `${schedule.expr}${tz}`;
  }
  if (schedule.kind === "every" && schedule.everyMs) {
    const minutes = Math.round(schedule.everyMs / 60000);
    return minutes % 60 === 0
      ? plural("knowledge.scribes.schedule.hours", minutes / 60)
      : plural("knowledge.scribes.schedule.minutes", minutes);
  }
  if (schedule.kind === "at" && schedule.at) {
    return t("knowledge.scribes.schedule.once", { time: when(Date.parse(schedule.at)) });
  }
  return schedule.kind === "event" ? t("knowledge.scribes.schedule.event") : schedule.kind;
}

// One-line state for an "On" row.
function activeMeta(snapshot: ScribeSnapshot) {
  const { status, job, result } = snapshot;
  const meta = el("span", undefined, "scribe-meta");
  const dot = el("span", undefined, "scribe-dot");
  if (status === "failing" || status === "missing") {
    dot.classList.add("scribe-dot-warn");
  } else if (status !== "on") {
    dot.classList.add("scribe-dot-idle");
  }
  meta.append(dot);
  const parts: string[] = [];
  if (status === "starting") {
    parts.push(t("knowledge.scribes.settingUp"));
  } else if (status === "missing") {
    parts.push(
      snapshot.session?.archived
        ? t("knowledge.scribes.sessionArchived")
        : t("knowledge.scribes.sessionDeleted"),
    );
  } else if (status === "paused") {
    parts.push(t("knowledge.scribes.status.paused"));
  } else if (firstRunPending(snapshot)) {
    parts.push(t("knowledge.scribes.firstRunPending"));
  }
  if (job && status !== "missing") {
    parts.push(scheduleText(job));
    if (job.state.lastRunAtMs) {
      parts.push(t("knowledge.scribes.lastRunAt", { time: when(job.state.lastRunAtMs) }));
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
  const readiness = neededPluginState(scribe, detection);
  if (snapshot.status === "done" && snapshot.result) {
    meta.append(
      el("span", t("knowledge.scribes.doneSummary", { summary: snapshot.result.summary })),
    );
  } else if (scribe.plugin && readiness) {
    meta.append(el("span", pluginStateText(scribe.plugin, readiness)));
  } else if (scribe.id === "conversations" && (active !== undefined || archived !== undefined)) {
    const counts = [
      active === undefined
        ? ""
        : t("knowledge.scribes.activeCount", { count: active.toLocaleString() }),
      archived === undefined
        ? ""
        : t("knowledge.scribes.archivedCount", { count: archived.toLocaleString() }),
    ].filter(Boolean);
    meta.append(
      el("span", t("knowledge.scribes.sessionsOn", { counts: counts.join(" · "), agent })),
    );
  } else if (scribe.id === "memory" && memoryFile !== undefined) {
    meta.append(
      el(
        "span",
        memoryFile === null
          ? t("knowledge.scribes.noMemory", { agent })
          : memoryFile.size === undefined
            ? t("knowledge.scribes.foundMemory", { agent })
            : t("knowledge.scribes.foundMemorySize", {
                agent,
                size: String(Math.max(1, Math.round(memoryFile.size / 1024))),
              }),
      ),
    );
  }
  meta.append(chip(t(`knowledge.scribes.catalog.${scribe.id}.cadence`)));
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
    // A detail only needs detection for its plugin; the list shows every scribe's facts.
    selected && !selected.plugin
      ? Promise.resolve({})
      : detectSources(host, agentId).catch(() => ({})),
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
  s.scribesCountAgent = agentId;
  target.replaceChildren(
    snapshot ? detail(ui, snapshot, runs, detection) : list(ui, snapshots, detection),
  );
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
    ui.announce(t("knowledge.scribes.firstRunStarted", { scribe: snapshot.scribe.title }));
  } catch (error) {
    // Not started: forget it so the next load tries again and nothing shows it as running.
    firstRuns.delete(job.id);
    ui.announce(
      t("knowledge.scribes.firstRunFailed", {
        scribe: snapshot.scribe.title,
        details: ui.errorText(error),
      }),
    );
  }
}

/** The first run is forced or running and nothing has finished yet. */
const firstRunPending = (snapshot: ScribeSnapshot) =>
  Boolean(
    snapshot.job &&
    !snapshot.job.state.lastRunAtMs &&
    (snapshot.job.state.runningAtMs || firstRuns.has(snapshot.job.id)),
  );

/** Number of the agent's scribes that are on, for the Scribes tab count. */
export async function countScribesOn(host: Parameters<typeof loadScribes>[0], agentId: string) {
  return (await loadScribes(host, agentId)).filter((entry) => isOn(entry.status)).length;
}

/** Tab label with the count of scribes that are on. */
export function renderScribesTab(tab: HTMLButtonElement, on: number) {
  tab.replaceChildren(document.createTextNode(t("knowledge.page.tabs.scribes")));
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
    storeName: entry ? storeLabel(entry, ui.displayName) : t("knowledge.common.knowledge"),
  };
}

// Open the start dialog; a successful start shows the scribe's detail.
function start(ui: Page, snapshot: ScribeSnapshot, detection: ScribeDetection) {
  const { agentId, agentName, storeName } = pageNames(ui);
  const host = ui.s.context.host;
  const attempt = crypto.randomUUID();
  openStartDialog({
    scribe: snapshot.scribe,
    agentName,
    storeName,
    detection,
    canWrite: host.connection.canWrite,
    basePath: host.basePath,
    start: async (prompt) => {
      await startScribe(host, snapshot, agentId, prompt, attempt);
      ui.announce(t("knowledge.scribes.started", { scribe: scribeLabel(snapshot.scribe) }));
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
  root.append(el("p", t("knowledge.scribes.intro", { store: storeName }), "scribes-intro"));
  const on = snapshots.filter((entry) => isOn(entry.status)),
    rest = snapshots.filter((entry) => !isOn(entry.status));
  for (const [heading, group] of [
    ["on", on],
    ["available", rest],
  ] as const) {
    if (!group.length) {
      continue;
    }
    root.append(
      el(
        "h3",
        t(`knowledge.scribes.groups.${heading}`, { count: String(group.length) }),
        "knowledge-eyebrow",
      ),
    );
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
  root.append(el("p", t("knowledge.scribes.footnote"), "knowledge-muted scribes-footnote"));
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
  chevron.setAttribute("aria-label", t("knowledge.scribes.open", { scribe: scribe.title }));
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
    el("span", t(`knowledge.scribes.catalog.${scribe.id}.blurb`), "scribe-blurb"),
    detectionMeta(snapshot, detection, agentName),
  );
  const actions = el("span", undefined, "scribe-actions");
  if (snapshot.status === "done") {
    actions.append(
      button(
        t("knowledge.scribes.details"),
        () => openScribe(ui, scribe.id),
        "knowledge-quiet knowledge-small",
      ),
    );
  }
  // A needed plugin that is not ready comes first: the scribe can't start until it is.
  const readiness = neededPluginState(scribe, detection);
  const blocked = readiness && readiness !== "ready" ? readiness : undefined;
  if (scribe.plugin && blocked) {
    actions.append(pluginButton(ui.s.context.host.basePath, scribe.plugin, blocked));
  }
  const startButton = button(
    t(`knowledge.scribes.catalog.${scribe.id}.start`),
    () => start(ui, snapshot, detection),
    blocked
      ? "knowledge-button knowledge-small"
      : "knowledge-button knowledge-primary knowledge-small",
  );
  startButton.disabled = !canWrite || Boolean(blocked);
  if (!canWrite) {
    startButton.title = t("knowledge.scribes.needsWrite");
  } else if (scribe.plugin && blocked) {
    startButton.title = t("knowledge.scribes.connectPluginFirst", { plugin: scribe.plugin.name });
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

// One run's line: its error when it failed or was skipped, otherwise its summary.
function runText(run: ScribeRun) {
  if (runFailed(run)) {
    return run.error ?? t("knowledge.scribes.runs.failedRun");
  }
  if (run.status === "skipped") {
    return run.error
      ? t("knowledge.scribes.runs.skippedReason", { reason: run.error })
      : t("knowledge.scribes.runs.skippedRun");
  }
  // A scribe run's summary is its final reply; its status line holds the one-sentence summary.
  return run.summary
    ? statusFromText(run.summary)?.summary || run.summary
    : t("knowledge.scribes.runs.finished");
}

function detail(ui: Page, snapshot: ScribeSnapshot, runs: ScribeRun[], detection: ScribeDetection) {
  const { scribe, job, session, status } = snapshot;
  const host = ui.s.context.host;
  const { agentId, agentName, storeName } = pageNames(ui);
  const canWrite = host.connection.canWrite;
  const root = el("div", undefined, "scribe-detail");
  const crumb = button("", () => openScribe(ui, ""), "knowledge-quiet knowledge-crumb");
  crumb.append(icon("arrowLeft", 14), el("span", t("knowledge.page.tabs.scribes")));
  const head = el("div", undefined, "scribe-detail-head");
  const heading = el("div");
  heading.append(
    el("h2", scribe.title),
    el("p", t(`knowledge.scribes.catalog.${scribe.id}.blurb`), "knowledge-muted"),
  );
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
  if (job && status !== "missing") {
    actions.append(
      control(
        t("knowledge.scribes.runNow"),
        () => runScribeNow(host, job),
        t("knowledge.scribes.running", { scribe: scribe.title }),
      ),
    );
  }
  if (session && !session.archived) {
    actions.append(
      button(
        t("knowledge.scribes.openSession"),
        () => host.sessions.open({ sessionKey: session.key, agentId }),
        "knowledge-button knowledge-small",
      ),
    );
  }
  // A scribe with an automation repairs it; one without starts over from the start dialog.
  if (job && (status === "missing" || status === "failing")) {
    actions.append(
      control(
        t("knowledge.scribes.repair"),
        () => repairScribe(host, snapshot, job, agentId),
        status === "missing" && session?.archived
          ? t("knowledge.scribes.restored", { scribe: scribeLabel(scribe) })
          : t("knowledge.scribes.repairAsked", { scribe: scribeLabel(scribe) }),
      ),
    );
  }
  if (job && status !== "missing") {
    const paused = !job.enabled;
    actions.append(
      control(
        t(paused ? "knowledge.scribes.resume" : "knowledge.scribes.pause"),
        () => setScribePaused(host, job, !paused),
        t(paused ? "knowledge.scribes.resumed" : "knowledge.scribes.paused", {
          scribe: scribe.title,
        }),
      ),
    );
  }
  if (job) {
    const turnOff = button(
      t("knowledge.scribes.turnOffMenu"),
      () =>
        openConfirmDialog(
          t("knowledge.scribes.turnOffTitle", { scribe: scribe.title }),
          t("knowledge.scribes.turnOffBody", { session: scribeLabel(scribe) }),
          t("knowledge.scribes.turnOff"),
          async () => {
            await turnOffScribe(host, job);
            ui.announce(t("knowledge.scribes.turnedOff", { scribe: scribe.title }));
            void ui.load();
          },
        ),
      "knowledge-quiet knowledge-small",
    );
    turnOff.disabled = !canWrite;
    actions.append(turnOff);
  }
  if (!job && status !== "starting") {
    const again = button(
      t(
        status === "failing"
          ? "knowledge.scribes.startAgain"
          : `knowledge.scribes.catalog.${scribe.id}.start`,
      ),
      () => start(ui, snapshot, detection),
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
  const facts: [string, string | Node][] = [[t("knowledge.scribes.facts.status"), statusValue]];
  if (job) {
    facts.push(
      [t("knowledge.scribes.facts.schedule"), scheduleText(job)],
      [
        t("knowledge.scribes.facts.nextRun"),
        job.state.runningAtMs
          ? t("knowledge.scribes.runningNow")
          : !job.enabled
            ? t("knowledge.scribes.status.paused")
            : job.state.nextRunAtMs
              ? when(job.state.nextRunAtMs)
              : t("knowledge.scribes.notScheduled"),
      ],
      [
        t("knowledge.scribes.facts.lastRun"),
        job.state.lastRunAtMs
          ? [
              when(job.state.lastRunAtMs),
              job.state.lastDurationMs === undefined
                ? ""
                : t("knowledge.scribes.minutes", {
                    count: String(Math.max(1, Math.round(job.state.lastDurationMs / 60000))),
                  }),
              lastRun?.usage?.total_tokens === undefined
                ? ""
                : t("knowledge.scribes.tokens", {
                    count: String(Math.round(lastRun.usage.total_tokens / 1000)),
                  }),
            ]
              .filter(Boolean)
              .join(" · ")
          : t("knowledge.scribes.notRunYet"),
      ],
    );
  } else if (status === "done") {
    facts.push([
      t("knowledge.scribes.facts.schedule"),
      t("knowledge.scribes.onceNothingScheduled"),
    ]);
  }
  facts.push(
    [
      t("knowledge.scribes.facts.session"),
      session
        ? [
            scribeLabel(scribe),
            session.createdAt
              ? t("knowledge.scribes.startedAt", { time: when(session.createdAt) })
              : "",
            session.archived ? t("knowledge.scribes.archived") : "",
          ]
            .filter(Boolean)
            .join(" · ")
        : t("knowledge.scribes.notFound"),
    ],
    [
      t("knowledge.scribes.facts.model"),
      lastRun?.model ?? t("knowledge.scribes.defaultModel", { agent: agentName }),
    ],
    [t("knowledge.scribes.facts.store"), storeName],
  );
  facts.push([
    t("knowledge.scribes.facts.follows"),
    t("knowledge.scribes.skill", { skill: scribe.skill }),
  ]);
  const readiness = neededPluginState(scribe, detection);
  if (scribe.plugin && readiness) {
    const value = el("span", undefined, "scribe-status");
    value.append(el("span", pluginStateText(scribe.plugin, readiness)));
    if (readiness !== "ready") {
      value.append(
        pluginButton(host.basePath, scribe.plugin, readiness, "knowledge-quiet knowledge-small"),
      );
    }
    facts.push([t("knowledge.scribes.facts.source"), value]);
  }
  if (job) {
    facts.push([
      t("knowledge.scribes.facts.ifFails"),
      job.failureAlert === false
        ? t("knowledge.scribes.noAlert")
        : job.failureAlert
          ? plural("knowledge.scribes.alertAfter", job.failureAlert.after ?? 1)
          : t("knowledge.scribes.defaultAlert"),
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
    line.append(
      el("time", when(run.runAtMs ?? run.ts)),
      el("span", runText(run)),
      runFailed(run) ? statusChip("failing") : el("span"),
    );
    rows.append(line);
  }
  if (!runs.length && firstRunPending(snapshot)) {
    const line = el("div", undefined, "scribe-run");
    line.append(
      el("time", t("knowledge.scribes.firstRun")),
      el("span", t("knowledge.scribes.runningNow")),
      el("span"),
    );
    rows.append(line);
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
  root.append(crumb, head, feedback, grid, history);
  return root;
}
