import { t } from "./i18n/index.js";
/** The Scribes tab: the list of scribes grouped by state, and one scribe's detail and controls. */
import type { Page } from "./page-context.js";
import { button, chip, el } from "./page-dom.js";
import {
  openConfirmDialog,
  openStartDialog,
  pluginButton,
  pluginStateText,
  scribeTile,
} from "./scribe-dialog.js";
import {
  plural,
  renderScribeRunHistory,
  runsSummary,
  statusChip,
  when,
} from "./scribe-run-history.js";
import { openScheduleDialog } from "./scribe-schedule-dialog.js";
import { settingsValue } from "./scribe-settings-dialog.js";
import {
  needsUpgrade,
  replacesTurnCreated,
  repairScribe,
  runScribeNow,
  ScribeActionError,
  setScribePaused,
  startScribe,
  turnOffScribe,
  updateScribe,
} from "./scribes-actions.js";
import {
  EDITABLE_SETTINGS,
  scribeById,
  scribeLabel,
  type ScribeDefinition,
} from "./scribes-catalog.js";
import {
  detectSources,
  loadRuns,
  loadScribes,
  neededPluginState,
  type ScribeDetection,
  type ScribeJob,
  type ScribeRun,
  type ScribeSnapshot,
  type ScribeStatus,
} from "./scribes-state.js";
import { replacementButton, update, updateNotice, upgradeNotice } from "./scribes-updates.js";
import { storeLabel, storeOf } from "./stores-view.js";
import { icon } from "./ui-icons.js";

/** Why automation controls are off: scribe automations are written with administrator access. */
const needsAdmin = () => t("knowledge.scribes.needsAdmin");
// The installed scribe’s session and automation keep their existing names.
const scribeTitle = (scribe: ScribeDefinition) =>
  scribe.id === "conversations"
    ? t("knowledge.scribes.catalog.conversations.dialogTitle")
    : scribe.title;

/**
 * Whether this connection can start `scribe`: a once run is a message in its conversation and
 * needs write access; an ongoing scribe is an automation and needs an administrator.
 */
const canStart = (ui: Page, scribe: ScribeDefinition) => {
  const { canWrite, canAdmin } = ui.s.context.host.connection;
  return canWrite && (canAdmin || scribe.modes.includes("once"));
};

/** Scribes the list shows under "On": everything set up that is not finished or startable. */
const isOn = (status: ScribeStatus) => status !== "available" && status !== "done";

// "a, b and c".
const listText = (items: string[]) =>
  items.length > 1
    ? t("knowledge.common.andList", { items: items.slice(0, -1).join(", "), last: items.at(-1)! })
    : (items[0] ?? "");
/** Human schedule for a scribe automation; daily cron expressions read as a time of day. */
function scheduleText(schedule: ScribeJob["schedule"]) {
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
  if (status === "failing" || status === "missing" || status === "attention") {
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
  } else if (job?.state.runningAtMs) {
    parts.push(t("knowledge.scribes.runningNow"));
  }
  if (job && status !== "missing") {
    parts.push(scheduleText(job.schedule));
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
  const [loaded, detection] = await Promise.all([
    loadScribes(host, agentId),
    // A detail only needs detection for its plugin; the list shows every scribe's facts.
    selected && !selected.plugin
      ? Promise.resolve({})
      : detectSources(host, agentId).catch(() => ({})),
  ]);
  let snapshots = loaded;
  // An administrator's load brings earlier automations up to date, then reads the result.
  if (host.connection.canAdmin) {
    const wrote = await Promise.all(snapshots.map((snapshot) => update(ui, snapshot, agentId)));
    if (wrote.some(Boolean)) {
      snapshots = await loadScribes(host, agentId);
    }
  }
  const snapshot = selected && snapshots.find((entry) => entry.scribe.id === selected.id);
  let runs: ScribeRun[] = [];
  let runHistoryFailed = false;
  if (snapshot?.job) {
    try {
      runs = await loadRuns(host, snapshot.job, agentId);
    } catch {
      runHistoryFailed = true;
    }
  }
  if (!live(n)) {
    return;
  }
  renderScribesTab(ui.scribesTab, snapshots.filter((entry) => isOn(entry.status)).length);
  s.scribesCountAgent = agentId;
  target.replaceChildren(
    snapshot
      ? detail(ui, snapshot, runs, detection, runHistoryFailed)
      : list(ui, snapshots, detection),
  );
}

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
  const { agentId, agentName } = pageNames(ui);
  const host = ui.s.context.host;
  const attempt = crypto.randomUUID();
  openStartDialog({
    scribe: snapshot.scribe,
    agentName,
    detection,
    canWrite: host.connection.canWrite,
    canAdmin: host.connection.canAdmin,
    basePath: host.basePath,
    start: async (setup, text) => {
      await startScribe(host, snapshot, agentId, setup, text, attempt);
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
          : availableRow(ui, snapshot, detection, agentName),
      );
    }
    root.append(surface);
  }
  root.append(
    el(
      "p",
      ui.s.context.host.connection.canAdmin
        ? t("knowledge.scribes.footnote")
        : `${t("knowledge.scribes.footnote")} ${needsAdmin()}`,
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
  copy.append(el("span", scribeTitle(scribe), "scribe-title"), activeMeta(snapshot));
  link.append(scribeTile(scribe), copy);
  const actions = el("span", undefined, "scribe-actions");
  const chevron = button(
    "",
    () => openScribe(ui, scribe.id),
    "knowledge-quiet knowledge-icon-button",
  );
  chevron.setAttribute("aria-label", t("knowledge.scribes.open", { scribe: scribeTitle(scribe) }));
  chevron.append(icon("chevronRight", 16));
  if (needsUpgrade(snapshot)) {
    actions.append(chip("Upgrade available"));
  } else if (snapshot.runMessage?.state === "differs") {
    actions.append(chip("New run instructions"));
  }
  actions.append(statusChip(snapshot.status), chevron);
  row.append(link, actions);
  return row;
}

function availableRow(
  ui: Page,
  snapshot: ScribeSnapshot,
  detection: ScribeDetection,
  agentName: string,
) {
  const { scribe } = snapshot;
  const startable = canStart(ui, scribe);
  const row = el("div", undefined, "scribe-row");
  const copy = el("span", undefined, "scribe-copy");
  copy.append(
    el("span", scribeTitle(scribe), "scribe-title"),
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
  startButton.disabled = !startable || Boolean(blocked);
  if (!ui.s.context.host.connection.canWrite) {
    startButton.title = t("knowledge.scribes.needsWrite");
  } else if (!startable) {
    startButton.title = needsAdmin();
  } else if (scribe.plugin && blocked) {
    startButton.title = t("knowledge.scribes.connectPluginFirst", { plugin: scribe.plugin.name });
  }
  actions.append(startButton);
  row.append(scribeTile(scribe), copy, actions);
  return row;
}

function detail(
  ui: Page,
  snapshot: ScribeSnapshot,
  runs: ScribeRun[],
  detection: ScribeDetection,
  runHistoryFailed: boolean,
) {
  const { scribe, job, session, status } = snapshot;
  const host = ui.s.context.host;
  const { agentId, agentName, storeName } = pageNames(ui);
  // Every automation control is an administrator's write.
  const canAdmin = host.connection.canAdmin;
  const root = el("div", undefined, "scribe-detail");
  const crumb = button("", () => openScribe(ui, ""), "knowledge-quiet knowledge-crumb");
  crumb.append(icon("arrowLeft", 14), el("span", t("knowledge.page.tabs.scribes")));
  const head = el("div", undefined, "scribe-detail-head");
  const heading = el("div");
  heading.append(
    el("h2", scribeTitle(scribe)),
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
        const restore = () => controls.forEach((other) => (other.disabled = !canAdmin));
        run().then(
          () => {
            restore();
            ui.announce(done);
            void ui.load();
          },
          (error: unknown) => {
            restore();
            feedback.textContent =
              error instanceof ScribeActionError
                ? error.message
                : t("knowledge.scribes.actionFailed");
            feedback.classList.add("knowledge-error");
          },
        );
      },
      className,
    );
    node.disabled = !canAdmin;
    if (!canAdmin) {
      node.title = needsAdmin();
    }
    controls.push(node);
    return node;
  };
  if (job && status !== "missing") {
    actions.append(
      control(
        t("knowledge.scribes.runNow"),
        () => runScribeNow(host, job),
        t("knowledge.scribes.running", { scribe: scribeTitle(scribe) }),
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
  // Repairing an automation an agent turn created replaces it, so it asks first, as Upgrade does.
  if (job && (status === "missing" || status === "failing")) {
    const repair = () => repairScribe(host, snapshot, job, agentId);
    actions.append(
      replacesTurnCreated(snapshot)
        ? replacementButton(ui, snapshot, "Repair…", "Repair", "repaired and turned on", repair)
        : control(
            "Repair",
            repair,
            status === "missing" && session?.archived
              ? t("knowledge.scribes.restored", { scribe: scribeLabel(scribe) })
              : t("knowledge.scribes.repaired", { scribe: scribeTitle(scribe) }),
          ),
    );
  }
  if (job && status !== "missing") {
    const paused = !job.enabled;
    actions.append(
      control(
        t(
          paused
            ? "knowledge.scribes.enable"
            : job.state.runningAtMs
              ? "knowledge.scribes.stopAndDisable"
              : "knowledge.scribes.disable",
        ),
        () => setScribePaused(host, job, !paused),
        t(paused ? "knowledge.scribes.resumed" : "knowledge.scribes.paused", {
          scribe: scribeTitle(scribe),
        }),
      ),
    );
  }
  if (job) {
    const turnOff = button(
      t("knowledge.scribes.turnOffMenu"),
      () =>
        openConfirmDialog(
          t("knowledge.scribes.turnOffTitle", { scribe: scribeTitle(scribe) }),
          t("knowledge.scribes.turnOffBody", { session: scribeLabel(scribe) }),
          t("knowledge.scribes.turnOff"),
          async () => {
            await turnOffScribe(host, job);
            ui.announce(t("knowledge.scribes.turnedOff", { scribe: scribeTitle(scribe) }));
            void ui.load();
          },
        ),
      "knowledge-quiet knowledge-small",
    );
    turnOff.disabled = !canAdmin;
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
    again.disabled = !canStart(ui, scribe);
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
    const scheduleValue = el("span", scheduleText(job.schedule), "scribe-status");
    // A schedule change replaces an automation an agent turn created; Upgrade does that first.
    if (status !== "missing" && !needsUpgrade(snapshot)) {
      const change = button(
        "Change…",
        () =>
          openScheduleDialog({
            scribe,
            schedule: job.schedule,
            describe: scheduleText,
            save: async (next) => {
              await updateScribe(host, snapshot, job, agentId, { schedule: next });
              ui.announce(`${scribe.title}: schedule changed.`);
              void ui.load();
            },
          }),
        "knowledge-quiet knowledge-small",
      );
      change.setAttribute("aria-label", "Change schedule");
      change.disabled = !canAdmin;
      scheduleValue.append(change);
    }
    facts.push(["Schedule", scheduleValue]);
    if (EDITABLE_SETTINGS.has(scribe.id) && status !== "missing") {
      facts.push(["Settings", settingsValue(ui, snapshot, job, agentId, detection)]);
    }
    facts.push(
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
    const tokens = scribe.plugin.channel && detection.tokens?.[scribe.plugin.id];
    const tokenText = [
      tokens?.bot === false ? "no bot token" : "",
      tokens?.user === undefined ? "" : tokens.user ? "user token configured" : "no user token",
    ].filter(Boolean);
    value.append(el("span", [pluginStateText(scribe.plugin, readiness), ...tokenText].join(" · ")));
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

  root.append(crumb, head, feedback);
  if (job && needsUpgrade(snapshot)) {
    root.append(upgradeNotice(ui, snapshot, job, agentId));
  } else if (job && snapshot.runMessage?.state === "differs") {
    root.append(updateNotice(ui, snapshot, job, agentId, snapshot.runMessage.current));
  }
  root.append(
    grid,
    renderScribeRunHistory(snapshot, runs, host.basePath, runHistoryFailed, ui.errorText),
  );
  return root;
}
