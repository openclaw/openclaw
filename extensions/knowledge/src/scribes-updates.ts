/** Bringing scribe automations up to date: the update turns, Replace with new, and the wait for them. */
import type { Page } from "./page-context.js";
import { button, el } from "./page-dom.js";
import { changedLines, openConfirmDialog } from "./scribe-dialog.js";
import { needsUpdate, updateScribe } from "./scribes-actions.js";
import type { ScribeJob, ScribeSnapshot } from "./scribes-state.js";

/**
 * Automation revisions this page already asked to update. The update is a turn in the scribe's
 * conversation, so the revision stays until that turn re-declares the automation; this keeps
 * reloads in that gap from asking again. A turn that left it unchanged is asked again after the
 * page is reopened.
 */
const updatesAsked = new Set<string>();
/**
 * Per Gateway connection: automations a turn was just asked to change (an update, Replace with
 * new, or Repair), by job id, with the revision they had then, and the page's watch over them.
 * The page shows them as updating and reloads until the revision changes; after
 * `UPDATE_WAIT_MS` it says the automation did not change instead.
 */
type UpdateEntry = { revision: string | undefined; since: number; late?: boolean };
const updates = new WeakMap<
  object,
  { pending: Map<string, UpdateEntry>; watch?: { stop: () => void } }
>();
const UPDATE_WAIT_MS = 3 * 60_000;
const updatesOf = (ui: Page) => {
  const host = ui.s.context.host;
  let state = updates.get(host);
  if (!state) {
    state = { pending: new Map() };
    updates.set(host, state);
  }
  return state;
};

/**
 * Bring a scribe's automation up to date with this version of Knowledge: each run in a fresh
 * session, and an unedited run message from an earlier version replaced. The Scribes page owns
 * this because it is where the owner, with write access, manages scribe automations; it asks the
 * scribe's conversation, which re-declares its automation with the owner's turn authority.
 */
export async function update(ui: Page, snapshot: ScribeSnapshot, agentId: string) {
  const { job } = snapshot;
  const asked = job && `${job.id}:${job.configRevision ?? ""}`;
  if (!job || !asked || updatesAsked.has(asked) || !needsUpdate(snapshot)) {
    return;
  }
  updatesAsked.add(asked);
  try {
    await updateScribe(ui.s.context.host, snapshot, job, agentId);
    markUpdating(ui, job);
    ui.announce(`${snapshot.scribe.title}: updating for this version of Knowledge…`);
  } catch (error) {
    ui.announce(`${snapshot.scribe.title}: the update was not sent. ${ui.errorText(error)}`);
  }
}

/** Show `job` as updating until its revision changes, and watch for that. */
export function markUpdating(ui: Page, job: ScribeJob) {
  updatesOf(ui).pending.set(job.id, { revision: job.configRevision, since: Date.now() });
  watchUpdates(ui);
}

/**
 * Settle updating automations against a fresh read: a new revision means the turn applied it;
 * one past the wait stays marked late, with a message, until the owner acts again.
 */
export function settleUpdates(ui: Page, snapshots: ScribeSnapshot[]) {
  const { pending } = updatesOf(ui);
  for (const [jobId, entry] of pending) {
    const snapshot = snapshots.find((candidate) => candidate.job?.id === jobId);
    if (!snapshot?.job || snapshot.job.configRevision !== entry.revision) {
      pending.delete(jobId);
      if (snapshot?.job) {
        ui.announce(`${snapshot.scribe.title}: updated.`);
      }
    } else if (!entry.late && Date.now() - entry.since > UPDATE_WAIT_MS) {
      entry.late = true;
      ui.announce(`${snapshot.scribe.title}: ${LATE_TEXT}`);
    }
  }
}
const LATE_TEXT =
  "its automation hasn't changed after 3 minutes. Open the conversation to see what happened.";

/**
 * While an automation is updating, reload the Scribes tab when automations change, and every 10
 * seconds in case a change event was missed. Stops when nothing is left to wait for or the tab
 * is left.
 */
export function watchUpdates(ui: Page) {
  const state = updatesOf(ui);
  const waiting = () => [...state.pending.values()].some((entry) => !entry.late);
  const stop = () => {
    state.watch?.stop();
    state.watch = undefined;
  };
  if (!waiting()) {
    stop();
    return;
  }
  if (state.watch) {
    return;
  }
  const reload = () => {
    if (ui.s.tab !== "scribes" || !waiting()) {
      stop();
      return;
    }
    void ui.load(true);
  };
  const stopEvents = ui.s.context.host.onEvent("cron.inventory.changed", reload);
  const poll = setInterval(reload, 10_000);
  state.watch = {
    stop: () => {
      stopEvents();
      clearInterval(poll);
    },
  };
}

/** How an updating automation reads on the page, or undefined when it isn't updating. */
export function updateState(ui: Page, job: ScribeJob | undefined) {
  const entry = job && updatesOf(ui).pending.get(job.id);
  return entry && (entry.late ? "late" : "updating");
}

/**
 * The notice for a run message that differs from what this version generates and still carries
 * replaced wording: it is kept until the owner replaces it with the new one.
 */
export function updateNotice(
  ui: Page,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
  next: string,
) {
  const { scribe } = snapshot;
  const notice = el("div", undefined, "knowledge-notice scribe-update");
  notice.append(
    el(
      "span",
      `New run instructions available. The saved run message for ${scribe.title} differs from what this version of Knowledge generates, so it was kept.`,
    ),
  );
  const diff = el("pre", undefined, "scribe-prompt-text scribe-update-message");
  for (const line of changedLines(job.payload?.message ?? "", next)) {
    const removed = line.kind === "removed";
    diff.append(
      el(
        removed ? "del" : "ins",
        `${removed ? "−" : "+"} ${line.text}\n`,
        removed ? "scribe-diff-removed" : "scribe-diff-added",
      ),
    );
  }
  const replace = button(
    "Replace with new…",
    () =>
      openConfirmDialog(
        "Replace with the new run instructions?",
        `Later runs of ${scribe.title} follow the new run message. These lines change; the saved message is not kept.`,
        "Replace with new",
        async () => {
          await updateScribe(ui.s.context.host, snapshot, job, agentId, next);
          markUpdating(ui, job);
          ui.announce(`${scribe.title}: replacing the run message…`);
          void ui.load();
        },
        diff,
      ),
    "knowledge-button knowledge-small",
  );
  replace.disabled = !ui.s.context.host.connection.canWrite;
  notice.append(replace);
  return notice;
}

// The notice while a turn changes the automation, or after it took too long.
export function updatingNotice(scribe: ScribeSnapshot["scribe"], state: "updating" | "late") {
  return el(
    "p",
    state === "updating"
      ? `Updating ${scribe.title}… This page refreshes when its automation changes.`
      : `${scribe.title}: ${LATE_TEXT}`,
    "knowledge-notice scribe-update",
  );
}
