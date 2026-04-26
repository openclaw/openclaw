// Polls the orchestrator agent's main session JSONL for `subagent_done`
// events that correspond to a dispatched task. Per recon Open Question 2
// — the `api.registerHook("sessions.spawn.complete", ...)` SDK seam is
// undefined, so we tail the file at 500ms and look for the
// terminal event whose payload references our task id.
//
// This is the v0 fallback; if a real hook seam is exposed later, this
// module is the only thing that needs to change.

import { readFileSync, statSync } from "node:fs";

export const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * Shape of the events we look for. We do not know the exact runtime
 * event format yet — verifying it is the Unit 5 follow-up listed in
 * RECON-NOTES Open Question 2. The discriminator is `type` and the task
 * id lives under `data.parentTaskId`. If the runtime ships a different
 * shape, the watcher needs only to update this matcher.
 */
export interface SubagentDoneEnvelope {
  type: string;
  data?: {
    parentTaskId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type SubagentDoneOutcome =
  | { kind: "done"; data: SubagentDoneEnvelope }
  | { kind: "failed"; data: SubagentDoneEnvelope; reason: string };

export interface WatchOptions {
  /** Path of the agent's session JSONL to tail (e.g. `…/sessions/<sid>.jsonl`). */
  sessionFile: string;
  /** Task id we are waiting for. Match `data.parentTaskId` against this. */
  parentTaskId: string;
  /** Called once when a matching `subagent_done` (or `subagent_failed`) event is seen. */
  onOutcome: (outcome: SubagentDoneOutcome) => void;
  /** Override poll interval (default 500ms). */
  pollIntervalMs?: number;
  /** Override `setInterval` for tests. */
  setIntervalFn?: (handler: () => void, ms: number) => unknown;
  /** Override `clearInterval` for tests. */
  clearIntervalFn?: (handle: unknown) => void;
  /** Override fs.statSync / readFileSync for tests. */
  readFile?: (path: string) => string;
  fileSize?: (path: string) => number;
}

export interface Watcher {
  /** Stop polling. Idempotent. */
  stop(): void;
  /** True after `onOutcome` has fired. */
  readonly fired: boolean;
}

const DONE_TYPES = new Set(["subagent_done", "subagent.done", "sessions.spawn.complete"]);
const FAILED_TYPES = new Set(["subagent_failed", "subagent.failed", "sessions.spawn.failed"]);

function readSafe(opts: WatchOptions): string {
  const reader = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  try {
    return reader(opts.sessionFile);
  } catch {
    return "";
  }
}

function fileSize(opts: WatchOptions): number {
  const sizer =
    opts.fileSize ??
    ((p: string) => {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    });
  return sizer(opts.sessionFile);
}

function classify(envelope: SubagentDoneEnvelope): SubagentDoneOutcome | null {
  if (DONE_TYPES.has(envelope.type)) {
    return { kind: "done", data: envelope };
  }
  if (FAILED_TYPES.has(envelope.type)) {
    const reason =
      typeof envelope.data?.["reason"] === "string"
        ? (envelope.data["reason"] as string)
        : envelope.type;
    return { kind: "failed", data: envelope, reason };
  }
  return null;
}

function scanLines(text: string, parentTaskId: string): SubagentDoneOutcome | null {
  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let parsed: SubagentDoneEnvelope;
    try {
      parsed = JSON.parse(trimmed) as SubagentDoneEnvelope;
    } catch {
      continue;
    }
    if (parsed.data?.parentTaskId !== parentTaskId) {
      continue;
    }
    const outcome = classify(parsed);
    if (outcome) {
      return outcome;
    }
  }
  return null;
}

/**
 * Begin watching `sessionFile` for the spawn outcome of `parentTaskId`.
 * Fires `onOutcome` exactly once; further file growth is ignored after
 * the first match.
 */
export function watchForSpawnOutcome(opts: WatchOptions): Watcher {
  const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const setIntervalImpl = opts.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
  const clearIntervalImpl =
    opts.clearIntervalFn ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let fired = false;
  let lastSize = 0;
  let handle: unknown = null;

  const tick = (): void => {
    if (fired) {
      return;
    }
    const size = fileSize(opts);
    if (size === lastSize) {
      return;
    }
    lastSize = size;
    const text = readSafe(opts);
    const outcome = scanLines(text, opts.parentTaskId);
    if (outcome) {
      fired = true;
      if (handle != null) {
        clearIntervalImpl(handle);
        handle = null;
      }
      opts.onOutcome(outcome);
    }
  };

  // Initial scan synchronously — the file may already contain the event.
  tick();
  if (!fired) {
    handle = setIntervalImpl(tick, interval);
  }

  return {
    stop() {
      if (handle != null) {
        clearIntervalImpl(handle);
        handle = null;
      }
    },
    get fired() {
      return fired;
    },
  };
}

/**
 * One-shot scan of an existing session file for the spawn outcome.
 * Used by tests and by the dispatch path when the file is known to be
 * settled (e.g. synthetic-harness-supplied fixtures).
 */
export function findSpawnOutcome(
  sessionFile: string,
  parentTaskId: string,
  options: { readFile?: (path: string) => string } = {},
): SubagentDoneOutcome | null {
  const reader = options.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let text: string;
  try {
    text = reader(sessionFile);
  } catch {
    return null;
  }
  return scanLines(text, parentTaskId);
}
