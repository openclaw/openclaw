/** Bringing scribe automations up to date: the update turns, Replace with new, and the wait for them. */
import type { Page } from "./page-context.js";
import { button, el } from "./page-dom.js";
import { changedLines, openConfirmDialog } from "./scribe-dialog.js";
import { needsUpdate, repairScribe, updateScribe } from "./scribes-actions.js";
import type { ScribeJob, ScribeSnapshot } from "./scribes-state.js";

/**
 * Per Gateway, by its Control UI base path: the page gets a new host on every reconnect, and a lost
 * response usually arrives as a dropped connection. State kept per host would be forgotten then,
 * and the reloaded page would send an unsent attempt again as a new request.
 *
 * Update attempts by automation revision. An attempt keeps its identity until its turn is sent,
 * so a transport retry after a failed send is the same request. A sent attempt is not repeated on
 * reloads, since the revision stays until the turn re-declares the automation; Try again after it
 * stayed unchanged starts a new attempt.
 */
type Attempt = { id: string; sent: boolean; session?: ScribeSnapshot["session"] };
const attempts = new Map<string, Map<string, Attempt>>();
const attemptsOf = (ui: Page) => {
  const gateway = ui.s.context.host.basePath;
  let map = attempts.get(gateway);
  if (!map) {
    map = new Map();
    attempts.set(gateway, map);
  }
  return map;
};
/**
 * Per Gateway, like attempts: automations a turn was just asked to change (an update, Replace with
 * new, or Repair), by job id, with the revision they had then, and the page's watch over them.
 * The page shows them as updating and reloads until the revision changes; after
 * `UPDATE_WAIT_MS` it says the automation did not change instead.
 */
type UpdateEntry = {
  agentId: string;
  revision: string | undefined;
  since: number;
  /** Whether a read shows the change landed; a turn can write more than once. */
  applied: (snapshot: ScribeSnapshot) => boolean;
  /**
   * Sends the same change again as a new attempt, for Try again once it is late, through the
   * page that asks: the page that marked it may have been replaced by a reconnect.
   */
  retry: (ui: Page) => Promise<unknown>;
  late?: boolean;
};
const updates = new Map<
  string,
  { pending: Map<string, UpdateEntry>; watch?: { ui: Page; stop: () => void } }
>();
const UPDATE_WAIT_MS = 3 * 60_000;
const updatesOf = (ui: Page) => {
  const gateway = ui.s.context.host.basePath;
  let state = updates.get(gateway);
  if (!state) {
    state = { pending: new Map() };
    updates.set(gateway, state);
  }
  return state;
};

/**
 * Bring a scribe's automation up to date with this version of Knowledge: each run in a fresh
 * session, and an unedited run message from an earlier version replaced. The Scribes page owns
 * this because it is where the owner, with write access, manages scribe automations; it asks the
 * scribe's conversation, which re-declares its automation with the owner's turn authority.
 */
export async function update(
  ui: Page,
  snapshot: ScribeSnapshot,
  agentId: string,
  /** Try again reports a failed send to its button instead of announcing it. */
  rethrow = false,
) {
  const { job } = snapshot;
  const asked = job && `${job.id}:${job.configRevision ?? ""}`;
  // An update still landing may write the automation more than once; don't ask again meanwhile.
  const landing = job && updatesOf(ui).pending.get(job.id);
  const map = attemptsOf(ui);
  if (!job || !asked || map.get(asked)?.sent || landing || !needsUpdate(snapshot)) {
    return;
  }
  const attempt = map.get(asked) ?? { id: crypto.randomUUID(), sent: false };
  map.set(asked, attempt);
  try {
    await updateScribe(ui.s.context.host, snapshot, job, agentId, undefined, attempt.id);
    attempt.sent = true;
    markUpdating(
      ui,
      job,
      agentId,
      (next) => !needsUpdate(next),
      async (current) => {
        if (map.get(asked)?.sent) {
          map.delete(asked);
        }
        await update(current, snapshot, agentId, true);
      },
    );
    ui.announce(`${snapshot.scribe.title}: updating for this version of Knowledge…`);
  } catch (error) {
    // Not sent: the next load asks again, as the same request.
    if (rethrow) {
      throw error;
    }
    ui.announce(`${snapshot.scribe.title}: the update was not sent. ${ui.errorText(error)}`);
  }
}

/** Repair shares the update attempt owner so lost responses survive page replacement. */
export async function repair(ui: Page, snapshot: ScribeSnapshot, job: ScribeJob, agentId: string) {
  const map = attemptsOf(ui);
  const asked = `repair:${job.id}:${job.configRevision ?? ""}`;
  const previous = map.get(asked);
  const attempt: Attempt =
    previous && !previous.sent ? previous : { id: crypto.randomUUID(), sent: false };
  map.set(asked, attempt);
  const target = attempt.session ? { ...snapshot, session: attempt.session } : snapshot;
  try {
    await repairScribe(ui.s.context.host, target, job, agentId, attempt.id);
  } finally {
    // Creation can succeed before chat.send loses its response; retries keep that target.
    attempt.session = target.session;
  }
  attempt.sent = true;
  // Restoring an archived conversation needs no turn; every other repair is one.
  if (!(target.status === "missing" && target.session?.archived)) {
    markUpdating(
      ui,
      job,
      agentId,
      () => true,
      (current) => repair(current, target, job, agentId),
    );
  }
}

/**
 * Show `job` as updating until its revision changes and `applied` holds for the new read, and
 * watch for that.
 */
function markUpdating(
  ui: Page,
  job: ScribeJob,
  agentId: string,
  applied: UpdateEntry["applied"],
  retry: UpdateEntry["retry"],
) {
  updatesOf(ui).pending.set(job.id, {
    agentId,
    revision: job.configRevision,
    since: Date.now(),
    applied,
    retry,
  });
  watchUpdates(ui);
}

/**
 * Settle updating automations against a fresh read: a new revision means the turn applied it;
 * one past the wait stays marked late, with a message, until the owner acts again.
 */
export function settleUpdates(ui: Page, agentId: string, snapshots: ScribeSnapshot[]) {
  const { pending } = updatesOf(ui);
  for (const [jobId, entry] of pending) {
    // Another agent's scribes aren't in this read; they settle when that agent is viewed.
    if (entry.agentId !== agentId) {
      continue;
    }
    const snapshot = snapshots.find((candidate) => candidate.job?.id === jobId);
    if (
      !snapshot?.job ||
      (snapshot.job.configRevision !== entry.revision && entry.applied(snapshot))
    ) {
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
  "its automation hasn't changed after 3 minutes. Open the conversation to see what happened, or try again.";

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
  // A watch left by a closed page belongs to it; this page takes over.
  if (state.watch?.ui === ui) {
    return;
  }
  stop();
  const reload = () => {
    if (ui.s.disposed || ui.s.tab !== "scribes" || !waiting()) {
      stop();
      return;
    }
    void ui.load(true);
  };
  const stopEvents = ui.s.context.host.onEvent("cron.inventory.changed", reload);
  const poll = setInterval(reload, 10_000);
  state.watch = {
    ui,
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
    () => {
      // One request per dialog: confirming again after a failed send repeats the same request.
      const attempt = crypto.randomUUID();
      openConfirmDialog(
        "Replace with the new run instructions?",
        `Later runs of ${scribe.title} follow the new run message. These lines change; the saved message is not kept.`,
        "Replace with new",
        async () => {
          await updateScribe(ui.s.context.host, snapshot, job, agentId, next, attempt);
          // Keep a late retry's identity until its send succeeds.
          let retryAttempt = crypto.randomUUID();
          markUpdating(
            ui,
            job,
            agentId,
            (read) => read.job?.payload?.message === next,
            async (current) => {
              await updateScribe(
                current.s.context.host,
                snapshot,
                job,
                agentId,
                next,
                retryAttempt,
              );
              retryAttempt = crypto.randomUUID();
            },
          );
          ui.announce(`${scribe.title}: replacing the run message…`);
          void ui.load();
        },
        diff,
      );
    },
    "knowledge-button knowledge-small",
  );
  replace.disabled = !ui.s.context.host.connection.canWrite;
  notice.append(replace);
  return notice;
}

// The notice while a turn changes the automation, or after it took too long, with Try again.
export function updatingNotice(ui: Page, snapshot: ScribeSnapshot, state: "updating" | "late") {
  const { scribe, job } = snapshot;
  const notice = el("div", undefined, "knowledge-notice scribe-update");
  notice.append(
    el(
      "span",
      state === "updating"
        ? `Updating ${scribe.title}… This page refreshes when its automation changes.`
        : `${scribe.title}: ${LATE_TEXT}`,
    ),
  );
  const entry = job && updatesOf(ui).pending.get(job.id);
  if (state === "late" && entry) {
    const again = button(
      "Try again",
      () => {
        again.disabled = true;
        updatesOf(ui).pending.delete(job.id);
        entry.retry(ui).then(
          () => {
            // A retry that went through `update` marks itself; any other is marked here.
            if (!updatesOf(ui).pending.has(job.id)) {
              markUpdating(ui, job, entry.agentId, entry.applied, entry.retry);
            }
            void ui.load();
          },
          (error: unknown) => {
            updatesOf(ui).pending.set(job.id, entry);
            again.disabled = false;
            ui.announce(`${scribe.title}: the update was not sent. ${ui.errorText(error)}`);
          },
        );
      },
      "knowledge-button knowledge-small",
    );
    again.disabled = !ui.s.context.host.connection.canWrite;
    notice.append(again);
  }
  return notice;
}
