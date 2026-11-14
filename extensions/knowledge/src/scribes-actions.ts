/** Gateway writes behind the Scribes controls: start, run now, pause, turn off, repair and update. */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { repairPrompt, scribeLabel, setupIdempotencyKey } from "./scribes-catalog.js";
import type { ScribeJob, ScribeSnapshot } from "./scribes-state.js";

type ScribeHost = Pick<ControlUiHost, "request" | "sessions">;

/**
 * The scribe's conversation, ready for a message: its existing session (restored from the
 * archive if needed), or a new one titled with the scribe's name, recorded on the snapshot. A
 * scribe keeps one conversation, so its automation and history stay in one place.
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
  // A retry after a failed send reuses this conversation instead of creating another.
  snapshot.session = { key, displayName: scribeLabel(snapshot.scribe) };
  return key;
}

/**
 * Start a scribe: find or create its conversation, then send the prompt the start dialog shows,
 * as generated or as the operator edited it. `attempt` identifies one start attempt so a
 * retried send is not delivered twice.
 */
export async function startScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  agentId: string,
  prompt: string,
  attempt: string,
) {
  const sessionKey = await conversation(host, snapshot, agentId);
  await host.request("chat.send", {
    sessionKey,
    agentId,
    message: prompt,
    idempotencyKey: setupIdempotencyKey(snapshot.scribe.id, sessionKey, attempt),
  });
  return sessionKey;
}

/**
 * Repair a scribe so its automation runs again in its own conversation.
 * - Archived conversation: restore it and turn the automation back on, without a model turn.
 *   Archiving turned the automation off; one paused before archiving also comes back on, a
 *   visible change Pause undoes.
 * - Deleted conversation, or a failing scribe: the automation must be owned by the scribe's
 *   conversation, which only a turn there can do, so send it the repair prompt (in a new
 *   conversation when the old one was deleted).
 */
export async function repairScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
  attempt: string,
) {
  const { scribe } = snapshot;
  const sessionKey = await conversation(host, snapshot, agentId);
  if (snapshot.status === "missing" && snapshot.session?.archived) {
    if (!job.enabled) {
      await setScribePaused(host, job, false);
    }
    return sessionKey;
  }
  const prompt = repairPrompt(scribe.id, {
    schedule: job.schedule,
    ...(job.payload?.message ? { runMessage: job.payload.message } : {}),
    saved: savedOptions(job),
  });
  await host.request("chat.send", {
    sessionKey,
    agentId,
    message: prompt,
    idempotencyKey: `knowledge:scribe:${scribe.id}:repair:${attempt}`,
  });
  return sessionKey;
}

// Payload fields a scribe prompt sets itself, or the scheduler derives; the rest are run options.
// An explicit tool list (not a generated default) is a saved option too: it caps the runs.
const DECLARED_PAYLOAD = new Set(["kind", "message", "toolsAllowIsDefault"]);

/** Options saved on the automation that a re-declaration would drop unless passed again. */
function savedOptions(job: ScribeJob) {
  const saved: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(job.payload ?? {})) {
    const generatedTools = field === "toolsAllow" && job.payload?.toolsAllowIsDefault === true;
    if (!DECLARED_PAYLOAD.has(field) && !generatedTools && value !== undefined) {
      saved[field] = value;
    }
  }
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
  return saved;
}

// What a refused run means for the operator, by the scheduler's reason.
const RUN_REFUSALS: Record<string, string> = {
  stopped: "the scheduler is stopped",
  disabled: "the automation is paused",
  ownerless: "the automation lost its owner; open the conversation and ask it to repair its setup",
  "invalid-spec": "its schedule is invalid; open the conversation and ask it to repair its setup",
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

/** Pause or resume the scribe's automation; rejected if it changed since it was read. */
export const setScribePaused = (host: ScribeHost, job: ScribeJob, paused: boolean) =>
  host.request("cron.update", {
    id: job.id,
    patch: { enabled: !paused },
    ...(job.configRevision ? { expectedConfigRevision: job.configRevision } : {}),
  });

/**
 * Whether this scribe's automation is behind this version of Knowledge:
 * - it runs in its conversation's own session instead of a fresh child session per run (only the
 *   shape setup generated, its own creating conversation, counts), or
 * - its run message is an unedited one an earlier version generated. An edited one never counts;
 *   the page offers it as an update instead.
 * Missing or running scribes wait: an update must not race a repair or a run in progress.
 */
export function needsUpdate(snapshot: ScribeSnapshot) {
  const { job, runMessage } = snapshot;
  if (!job || !snapshot.session || snapshot.status === "missing" || job.state.runningAtMs) {
    return false;
  }
  return (
    (Boolean(job.sessionKey) && job.sessionTarget === `session:${job.sessionKey}`) ||
    runMessage?.state === "outdated"
  );
}

/**
 * Ask the scribe's conversation to bring its automation up to date, with `runMessage` (the job's
 * own message by default, an unedited earlier one becoming the current one). The conversation
 * re-declares the automation in a turn, as setup did. A direct edit from the page would drop the
 * owner's turn authority that the automation's runs use. One request per automation revision.
 */
export async function updateScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
  runMessage = job.payload?.message,
  attempt = "1",
) {
  const { scribe } = snapshot;
  const sessionKey = await conversation(host, snapshot, agentId);
  const prompt = repairPrompt(
    scribe.id,
    { schedule: job.schedule, ...(runMessage ? { runMessage } : {}), saved: savedOptions(job) },
    "update",
  );
  await host.request("chat.send", {
    sessionKey,
    agentId,
    message: prompt,
    idempotencyKey: `knowledge:scribe:${scribe.id}:${runMessage === job.payload?.message ? "update" : "reset"}:${job.id}:${job.configRevision ?? ""}:${attempt}`,
  });
  return sessionKey;
}

/** Turn the scribe off: remove its automation and keep its conversation. */
export const turnOffScribe = (host: ScribeHost, job: ScribeJob) =>
  host.request("cron.remove", {
    id: job.id,
    ...(job.configRevision ? { expectedConfigRevision: job.configRevision } : {}),
  });
