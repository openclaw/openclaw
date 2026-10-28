/** Gateway writes behind the Scribes controls: start, run now, pause, turn off and repair. */
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
 * Ask the scribe's conversation to re-check its setup and take over its automation, keeping the
 * automation's schedule and run message.
 */
export async function repairScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  job: ScribeJob,
  agentId: string,
) {
  const { scribe } = snapshot;
  const prompt = repairPrompt(scribe.id, {
    schedule: job.schedule,
    ...(job.payload?.message ? { runMessage: job.payload.message } : {}),
  });
  const sessionKey = await conversation(host, snapshot, agentId);
  await host.request("chat.send", {
    sessionKey,
    agentId,
    message: prompt,
    idempotencyKey: `knowledge:scribe:${scribe.id}:repair:${crypto.randomUUID()}`,
  });
  return sessionKey;
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

/** Turn the scribe off: remove its automation and keep its conversation. */
export const turnOffScribe = (host: ScribeHost, job: ScribeJob) =>
  host.request("cron.remove", {
    id: job.id,
    ...(job.configRevision ? { expectedConfigRevision: job.configRevision } : {}),
  });
