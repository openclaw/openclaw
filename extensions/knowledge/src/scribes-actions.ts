/** Gateway writes behind the Scribes controls: start, run now, pause, turn off and repair. */
import type { ControlUiHost } from "openclaw/plugin-sdk/control-ui";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  defaultOptions,
  repairMessage,
  scribeLabel,
  scribeSetup,
  setupIdempotencyKey,
  setupMessage,
  type ScribeSetup,
} from "./scribes-catalog.js";
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
 * Start a scribe: find or create its conversation, then send the fixed setup message.
 * `attempt` identifies one start attempt so a retried send is not delivered twice.
 */
export async function startScribe(
  host: ScribeHost,
  snapshot: ScribeSnapshot,
  setup: ScribeSetup,
  attempt: string,
) {
  const sessionKey = await conversation(host, snapshot, setup.agentId);
  await host.request("chat.send", {
    sessionKey,
    agentId: setup.agentId,
    message: setupMessage(setup),
    idempotencyKey: setupIdempotencyKey(setup.scribe, sessionKey, attempt),
  });
  return sessionKey;
}

/**
 * Ask the scribe's conversation to re-check its setup and recreate its automation. Uses the
 * options of its latest setup message, or the defaults when the transcript no longer shows one.
 */
export async function repairScribe(host: ScribeHost, snapshot: ScribeSnapshot, agentId: string) {
  const { scribe } = snapshot;
  const setup =
    snapshot.setup ?? scribeSetup(scribe.id, scribe.modes[0]!, defaultOptions(scribe.id), agentId);
  const sessionKey = await conversation(host, snapshot, agentId);
  await host.request("chat.send", {
    sessionKey,
    agentId,
    message: repairMessage(setup),
    idempotencyKey: `knowledge:scribe:${scribe.id}:repair:${crypto.randomUUID()}`,
  });
  return sessionKey;
}

/**
 * Send a one-time scribe's setup message again in its conversation, as a new start attempt. Uses
 * the options of its latest setup message, or the defaults when the transcript no longer shows one.
 */
export function retryScribe(host: ScribeHost, snapshot: ScribeSnapshot, agentId: string) {
  const { scribe } = snapshot;
  const setup =
    snapshot.setup ?? scribeSetup(scribe.id, "once", defaultOptions(scribe.id), agentId);
  return startScribe(host, snapshot, setup, crypto.randomUUID());
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
