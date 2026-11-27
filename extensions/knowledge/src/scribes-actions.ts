/** Gateway writes behind the Scribes controls: start, run now, pause, turn off, repair and update. */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  checkRunMessage,
  defaultOptions,
  rescheduledRunMessage,
  runPrompt,
  SCRIBE_SESSION_TARGET,
  scribeAutomationName,
  scribeDeclarationKey,
  scribeLabel,
  scribeSetup,
  setupIdempotencyKey,
  type ScribeSetup,
} from "./scribes-catalog.js";
import { jobConversationKey, type ScribeJob, type ScribeSnapshot } from "./scribes-state.js";

type ScribeHost = Pick<ControlUiHost, "request" | "sessions">;

/**
 * The scribe's conversation, ready for a message or an automation: its existing session (restored
 * from the archive if needed), or a new one titled with the scribe's name, recorded on the
 * snapshot. A scribe keeps one conversation, so its automation and history stay in one place.
 */
async function conversation(host: ScribeHost, snapshot: ScribeSnapshot, agentId: string) {
  const existing = snapshot.session;
  if (existing) {
    if (existing.archived) {
      // Lifecycle patches name the incarnation they restore.
      await host.request("sessions.patch", {
        key: existing.key,
        agentId,
        archived: false,
        ...(existing.sessionId ? { expectedSessionId: existing.sessionId } : {}),
      });
    }
    return existing.key;
  }
  const key = await host.sessions.create({
    agentId,
    displayName: scribeLabel(snapshot.scribe),
    surface: "plugin-dock",
  });
  if (!key) {
    throw new Error("The scribe’s conversation could not be created.");
  }
  // A retry after a failed write reuses this conversation instead of creating another.
  snapshot.session = { key, displayName: scribeLabel(snapshot.scribe) };
  return key;
}

/**
 * An automation an agent turn created: its runs use that turn's account authority, which can't
 * read channels such as Slack on a schedule, and an administrator's edit can't widen it.
 */
const isTurnCreated = (job: ScribeJob) => job.scheduledToolPolicy?.mode === "account";

/**
 * Whether the scribe still runs on an automation an agent turn created, which the administrator
 * upgrades by choice: the replacement can't carry over the model account recorded on it (the page
 * can't read it), so its runs use the upgrading administrator's, and a rejected replacement leaves
 * no automation. The page never replaces one on its own.
 */
export const needsUpgrade = (snapshot: ScribeSnapshot) =>
  snapshot.status !== "missing" && replacesTurnCreated(snapshot);

/** Whether declaring the scribe again replaces an automation an agent turn created. */
export const replacesTurnCreated = (snapshot: ScribeSnapshot) => snapshot.jobs.some(isTurnCreated);

/** What an ongoing scribe's automation is declared with. */
type Declaration = {
  schedule: ScribeJob["schedule"];
  runMessage: string;
  /** Options saved on an earlier automation, passed on when it is replaced. */
  saved?: ReturnType<typeof savedOptions>;
  /** Set it on or off; left out, an automation kept stays as it is and a replaced pause carries over. */
  enabled?: boolean;
};

/**
 * Declare the scribe's one automation for this agent, in its conversation, as this page's
 * administrator: runs use the operator's authority, so they can read channel plugins.
 * - An automation the page wrote earlier for this conversation is kept and updated in place.
 * - Every other one is removed and replaced: one an agent turn created, whose authority can't be
 *   widened in place, and one recorded for another conversation, whose recorded parent an edit
 *   can't move. Its options are carried over and a pause stays.
 * Removal comes before the new automation is added: a same-key automation would take the new
 * declaration with its old authority. If adding then fails, the scribe reads as Available and
 * can be started again; the caller reports the error.
 */
async function declareScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  agentId: string,
  declaration: Declaration,
): Promise<ScribeJob | undefined> {
  const { scribe } = snapshot;
  const sessionKey = await conversation(host, snapshot, agentId);
  const keep = snapshot.jobs.find(
    (job) => !isTurnCreated(job) && jobConversationKey(job) === sessionKey,
  );
  const replaced = snapshot.jobs.filter((job) => job !== keep);
  for (const job of replaced) {
    await turnOffScribe(host, job);
  }
  const enabled = declaration.enabled ?? keep?.enabled ?? !replaced.some((job) => !job.enabled);
  const definition = {
    name: scribeAutomationName(scribe),
    sessionKey,
    sessionTarget: SCRIBE_SESSION_TARGET,
    enabled,
    schedule: declaration.schedule,
  };
  const result = keep
    ? await host.request("cron.update", {
        id: keep.id,
        patch: { ...definition, payload: { kind: "agentTurn", message: declaration.runMessage } },
        ...(keep.configRevision ? { expectedConfigRevision: keep.configRevision } : {}),
      })
    : await host.request("cron.add", {
        delivery: { mode: "none" },
        failureAlert: { after: 2 },
        ...declaration.saved?.job,
        ...definition,
        agentId,
        declarationKey: scribeDeclarationKey(scribe.id),
        // An explicit cap records the administrator's authority for the runs' tools, channel
        // reads included; a saved cap replaces it.
        payload: {
          toolsAllow: ["*"],
          ...declaration.saved?.payload,
          kind: "agentTurn",
          message: declaration.runMessage,
        },
      });
  // A declarative cron.add answers `{ created, job }`; cron.update answers the job itself.
  const job = isRecord(result) && isRecord(result.job) ? result.job : result;
  // SAFETY: both answer with the written job.
  return isRecord(job) && typeof job.id === "string" ? (job as ScribeJob) : undefined;
}

/**
 * Start a scribe. A once scribe gets the prompt the start dialog shows, as generated or as the
 * operator edited it, in its conversation; `attempt` identifies one start so a retried send is
 * not delivered twice. An ongoing scribe gets its automation, with the run message shown, and its
 * first run is requested unless the automation stays disabled.
 */
export async function startScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  agentId: string,
  setup: ScribeSetup,
  text: string,
  attempt: string,
) {
  if (setup.mode === "once") {
    const sessionKey = await conversation(host, snapshot, agentId);
    await host.request("chat.send", {
      sessionKey,
      agentId,
      message: text,
      idempotencyKey: setupIdempotencyKey(snapshot.scribe.id, sessionKey, attempt),
    });
    return;
  }
  const expr = "schedule" in setup.options ? setup.options.schedule : undefined;
  if (!expr) {
    throw new Error("An ongoing scribe needs a schedule.");
  }
  const job = await declareScribe(host, snapshot, agentId, {
    schedule: { kind: "cron", expr, tz: setup.timezone },
    runMessage: text,
  });
  if (job?.enabled) {
    await runScribeNow(host, job);
  }
}

/** The run message a repair or update keeps: the job's own, an unedited earlier one upgraded. */
function keptRunMessage(snapshot: ScribeSnapshot, job: ScribeJob) {
  const message = job.payload?.message;
  if (message === undefined) {
    const { scribe } = snapshot;
    return runPrompt(scribeSetup(scribe.id, "ongoing", defaultOptions(scribe.id), job.schedule.tz));
  }
  const check = checkRunMessage(snapshot.scribe.id, message, job.schedule);
  return check.state === "outdated" ? check.current : message;
}

/**
 * Repair a scribe so its automation runs again in its own conversation, turned on.
 * - Archived conversation: restore it and turn the automation back on. Archiving turned the
 *   automation off; one paused before archiving also comes back on, a visible change Disable
 *   undoes.
 * - Otherwise its automation is declared again in its conversation (a new one when the old one
 *   was deleted), keeping its schedule, run message and options.
 */
export async function repairScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
) {
  if (snapshot.status === "missing" && snapshot.session?.archived && !isTurnCreated(job)) {
    await conversation(host, snapshot, agentId);
    if (!job.enabled) {
      await setScribePaused(host, job, false);
    }
    return;
  }
  await declareScribe(host, snapshot, agentId, {
    schedule: job.schedule,
    runMessage: keptRunMessage(snapshot, job),
    saved: savedOptions(job),
    enabled: true,
  });
}

// Payload fields the page sets itself, or the scheduler derives; the rest are run options.
// An explicit tool list (not a generated default) is a saved option too: it caps the runs.
const DECLARED_PAYLOAD = new Set(["kind", "message", "toolsAllowIsDefault"]);

/** Options saved on the automation that a replacement would drop unless passed again. */
function savedOptions(job: ScribeJob) {
  const payload: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(job.payload ?? {})) {
    const generatedTools = field === "toolsAllow" && job.payload?.toolsAllowIsDefault === true;
    if (!DECLARED_PAYLOAD.has(field) && !generatedTools && value !== undefined) {
      payload[field] = value;
    }
  }
  const saved: Record<string, unknown> = {};
  for (const field of [
    "activeHours",
    "pacing",
    "idleOnly",
    "trigger",
    "delivery",
    "failureAlert",
  ] as const) {
    if (job[field] !== undefined) {
      saved[field] = job[field];
    }
  }
  return { payload, job: saved };
}

// What a refused run means for the operator, by the scheduler's reason.
const RUN_REFUSALS: Record<string, string> = {
  stopped: "the scheduler is stopped",
  disabled: "the automation is disabled",
  ownerless: "the automation lost its owner; Repair sets it up again",
  "invalid-spec": "its schedule is invalid; Repair sets it up again",
};

/**
 * Run the scribe's automation now, even when it is not due. Rejects unless the scheduler queued
 * or ran it (or one is already running): it can answer `ok` without running.
 */
export async function runScribeNow(host: ScribeHost, job: ScribeJob) {
  const answer = await host.request("cron.run", { id: job.id, mode: "force" });
  if (
    isRecord(answer) &&
    (answer.enqueued === true || answer.ran === true || answer.reason === "already-running")
  ) {
    return;
  }
  const reason = isRecord(answer) && typeof answer.reason === "string" ? answer.reason : "";
  throw new Error(`The run did not start: ${(RUN_REFUSALS[reason] ?? reason) || "not accepted"}.`);
}

/** Disable or enable the automation; rejected if it changed since it was read. */
export const setScribePaused = (host: ScribeHost, job: ScribeJob, paused: boolean) =>
  host.request("cron.update", {
    id: job.id,
    patch: { enabled: !paused },
    ...(job.configRevision ? { expectedConfigRevision: job.configRevision } : {}),
  });

/**
 * Whether the page brings this scribe's automation up to date on its own, in place:
 * - more than one automation of this agent has its declaration key,
 * - it runs in its conversation's own session instead of a fresh child session per run (only the
 *   shape earlier setups generated, its own creating conversation, counts), or
 * - its run message is an unedited one an earlier version generated. An edited one never counts;
 *   the page offers it as an update instead.
 * Missing or running scribes wait: an update must not race a repair or a run in progress. A
 * turn-created automation waits for the administrator's upgrade (`needsUpgrade`).
 */
export function needsUpdate(snapshot: ScribeSnapshot) {
  const { job, runMessage } = snapshot;
  if (!job || !snapshot.session || snapshot.status === "missing" || job.state.runningAtMs) {
    return false;
  }
  // An automation changed to another payload kind is the owner's own; an update would replace
  // its behavior with the scribe's agent turn.
  if (!snapshot.jobs.every((entry) => entry.payload?.kind === "agentTurn")) {
    return false;
  }
  if (snapshot.jobs.some(isTurnCreated)) {
    return false;
  }
  return (
    snapshot.jobs.length > 1 ||
    (Boolean(job.sessionKey) && job.sessionTarget === `session:${job.sessionKey}`) ||
    runMessage?.state === "outdated"
  );
}

/**
 * Bring the scribe's automation up to date: an administrator's automation in its conversation,
 * each run in a fresh session, with `runMessage` (the job's own message by default, an unedited
 * earlier one becoming the current one), or moved to `schedule` with the run message that
 * schedule takes. A disabled automation stays disabled.
 */
export async function updateScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
  change: { runMessage?: string; schedule?: ScribeJob["schedule"] } = {},
) {
  const { schedule } = change;
  const saved = job.payload?.message;
  const runMessage =
    change.runMessage ??
    (schedule && saved
      ? rescheduledRunMessage(snapshot.scribe.id, saved, job.schedule, schedule)
      : keptRunMessage(snapshot, job));
  await declareScribe(host, snapshot, agentId, {
    schedule: schedule ?? job.schedule,
    runMessage,
    saved: savedOptions(job),
  });
}

/** Turn the scribe off: remove its automation and keep its conversation. */
export const turnOffScribe = (host: ScribeHost, job: ScribeJob) =>
  host.request("cron.remove", {
    id: job.id,
    ...(job.configRevision ? { expectedConfigRevision: job.configRevision } : {}),
  });
