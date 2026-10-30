/**
 * In-memory registry for bash exec sessions.
 * Tracks running/backgrounded sessions, bounded pending output, finished
 * session retention, and process cleanup for reconnect/poll flows.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionEventTarget } from "../auto-reply/reply/session-event-contract.js";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import type {
  ManagedRunStdin,
  ProcessRunActivity,
  TerminationReason,
} from "../process/supervisor/types.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { notifyListeners } from "../shared/listeners.js";
import { encodeOwnedBuffer } from "../shared/owned-buffer.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { clampWithDefault, readEnvInt } from "./bash-tools.shared.js";

const DEFAULT_JOB_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MIN_JOB_TTL_MS = 60 * 1000; // 1 minute
const MAX_JOB_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours
const DEFAULT_PENDING_OUTPUT_CHARS = 30_000;
const MAX_FINISHED_SESSION_COUNT = 50;
const MAX_FINISHED_SESSION_OUTPUT_CHARS = 2_000_000;
const EMPTY_OUTPUT = { order: 0, text: Buffer.alloc(0) };

function clampTtl(value: number | undefined) {
  return clampWithDefault(value, DEFAULT_JOB_TTL_MS, MIN_JOB_TTL_MS, MAX_JOB_TTL_MS);
}

const defaultJobTtlMs = clampTtl(readEnvInt("OPENCLAW_BASH_JOB_TTL_MS", "PI_BASH_JOB_TTL_MS"));

/** Resolves the retention duration captured by one admitted exec process. */
export function resolveProcessCleanupMs(value?: number): number {
  return value === undefined ? defaultJobTtlMs : clampTtl(value);
}

/** Lifecycle status recorded for background process sessions. */
type ProcessStatus = "running" | "completed" | "failed" | "killed";

/** Removes one queued notify-on-exit event, if it is still pending. */
type NotifyOnExitRemoval = () => boolean;

type PendingOutputChunk = {
  order: number;
  text: Buffer;
};

// UTF-16 bytes own their storage without round-tripping each append back to a
// string. A head offset makes eviction independent of the retained log's size.
class ProcessOutput {
  private chunks: PendingOutputChunk[] = [];
  private head = 0;
  private offset = 0;
  private finished: string | undefined;
  length = 0;

  append(chunk: PendingOutputChunk, cap: number, originalLength: number) {
    // A pre-trimmed chunk replaces the old window even if a surrogate-safe
    // boundary shortened its retained suffix by one additional code unit.
    if (originalLength > cap) {
      this.chunks = [];
      this.head = 0;
      this.offset = 0;
      this.length = 0;
    }
    if (chunk.text.length === 0) {
      return;
    }
    this.chunks.push(chunk);
    this.length += chunk.text.length / 2;
    let remove = Math.max(0, this.length - cap);
    while (remove > 0) {
      // Positive retained length guarantees an entry at the live head.
      const first = this.chunks[this.head]!.text;
      const count = Math.min(remove, first.length / 2 - this.offset);
      const last = first.readUInt16LE((this.offset + count - 1) * 2);
      this.offset += count;
      this.length -= count;
      remove -= count;
      if (this.offset * 2 === first.length) {
        this.chunks[this.head++] = EMPTY_OUTPUT;
        this.offset = 0;
      }
      // Also handle a pair split across producer callbacks.
      if (remove === 0 && this.length > 0 && last >= 0xd800 && last <= 0xdbff) {
        const next = this.chunks[this.head]!.text.readUInt16LE(this.offset * 2);
        if (next >= 0xdc00 && next <= 0xdfff) {
          remove = 1;
        }
      }
    }
    if (this.head > 0 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  text(max = this.length): string {
    if (this.finished !== undefined) {
      return tail(this.finished, max);
    }
    let remaining = Math.min(max + 1, this.length);
    const parts: Buffer[] = [];
    for (let index = this.chunks.length - 1; index >= this.head && remaining > 0; index--) {
      const chunk = this.chunks[index]!.text;
      const start = Math.max(
        index === this.head ? this.offset * 2 : 0,
        chunk.length - remaining * 2,
      );
      parts.push(chunk.subarray(start));
      remaining -= (chunk.length - start) / 2;
    }
    // Include the preceding code unit so a tail cut can recognize a surrogate
    // pair even when its halves arrived in separate callbacks.
    const text = Buffer.concat(parts.toReversed()).toString("utf16le");
    return sliceUtf16Safe(text, Math.max(0, text.length - max));
  }

  freeze() {
    this.finished = this.text();
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
  }

  entries(): PendingOutputChunk[] {
    const entries = this.chunks.slice(this.head);
    const first = entries[0];
    if (first && this.offset > 0) {
      entries[0] = { ...first, text: first.text.subarray(this.offset * 2) };
    }
    return entries;
  }
}

type PendingPollDelivery = {
  output: string;
  outputDropped: boolean;
  scope: object;
};

/** One process record from execution through completed retention. */
export interface ProcessSession {
  id: string;
  command: string;
  scopeKey?: string;
  sessionKey?: string;
  /** Admission-owned duration; another agent's tools cannot change this result's lifetime. */
  readonly cleanupMs: number;
  /** Agent owner frozen when the exec process starts. */
  agentId?: string;
  /** Systemd hosts the tree; the registry still owns observation and retention. */
  durable?: {
    observe: () => Promise<void>;
    cancel: (assertCurrent?: () => void) => void;
    remove: () => void;
    finalize: () => Promise<void>;
    drain: () => Promise<void>;
  };
  /** Run whose exec call started this process; completion provenance only, never authority. */
  originRunId?: string;
  /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  notifyDeliveryContext?: DeliveryContext;
  notifySessionTarget?: SessionEventTarget;
  assertExitNotificationAcceptanceCurrent?: () => void;
  notifyOnExit?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  exitNotified?: boolean;
  /** Set only after a terminal poll result is delivered or persisted. */
  terminalPollObserved?: boolean;
  notifyOnExitRemoval?: NotifyOnExitRemoval;
  // Deprecated declaration-closure compatibility only; runtime never uses this.
  // ProcessSupervisor owns raw processes. Remove when the public Plugin SDK closure no
  // longer reaches registry types, or at the next compatible boundary change.
  child?: ChildProcessWithoutNullStreams;
  /** Retain the exact process producer while backend finalization is pending. */
  processActivity?: ProcessRunActivity;
  stdin?: ManagedRunStdin;
  pid?: number;
  startedAt: number;
  /** Set only on admission to completed retention; survives index removal. */
  endedAt?: number;
  expiresAt?: number;
  cwd?: string;
  maxOutputChars: number;
  pendingMaxOutputChars?: number;
  totalOutputChars: number;
  /** Live chunks become frozen text at completion, releasing the chunk graph. */
  pendingOutput: { stdout: ProcessOutput; stderr: ProcessOutput } | string;
  pendingStdoutChars: number;
  pendingStderrChars: number;
  /** Output was dropped from the pending poll buffers since their last drain. */
  pendingOutputDropped: boolean;
  /** Output prepared for a poll but not yet attached to the agent transcript. */
  pendingPollDelivery?: PendingPollDelivery;
  output: ProcessOutput;
  readonly aggregated: string;
  readonly tail: string;
  exitCode?: number | null;
  exitSignal?: NodeJS.Signals | number | null;
  exitReason?: TerminationReason;
  /** Explicit process/task stop intent; the terminal reason still owns confirmation. */
  cancellationRequested?: boolean;
  requestCancelled?: boolean;
  cleanupUncertain?: boolean;
  /** Cleanup failure prevents an intentional stop from being treated as successful observation. */
  finalizationFailed?: boolean;
  /** Preserve the lifecycle owner's verdict for polls that captured the running session. */
  terminalStatus?: Exclude<ProcessStatus, "running">;
  noOutputTimedOut?: boolean;
  exited: boolean;
  /** Process exit observed; backend cleanup still owns the terminal transition. */
  finalizing?: boolean;
  truncated: boolean;
  backgrounded: boolean;
  /** PTY cursor key mode: unknown until a PTY reports smkx/rmkx. */
  cursorKeyMode: "unknown" | "normal" | "application";
}

/** Creates one output owner; string views are materialized only by readers. */
export function createProcessSession(
  params: Omit<ProcessSession, "output" | "aggregated" | "tail" | "pendingOutput">,
): ProcessSession {
  const output = new ProcessOutput();
  return {
    ...params,
    output,
    pendingOutput: { stdout: new ProcessOutput(), stderr: new ProcessOutput() },
    get aggregated() {
      return output.text();
    },
    get tail() {
      return output.text(2000);
    },
  };
}

const runningSessions = new Map<string, ProcessSession>();
const finishedSessions = new Map<string, ProcessSession & { endedAt: number; expiresAt: number }>();
// Display uses start chronology; retained records are evicted in completion order.
let processSessionStartOrders = new WeakMap<object, number>();
let nextProcessSessionStartOrder = 0;
const processInstanceIds = new WeakMap<ProcessSession, string>();
// Promotion stays live when process removal clears its presentation state.
const activeExecSessions = new Map<
  string,
  { session: ProcessSession; promoted: boolean; settled?: Deferred }
>();
let finishedSessionOutputChars = 0;

let sweeper: NodeJS.Timeout | null = null;
let observeDurableProcesses: (() => Promise<void>) | undefined;

/** Reuse the retention timer for bounded durable-unit observation. */
export function setDurableProcessObserver(observer: (() => Promise<void>) | undefined) {
  observeDurableProcesses = observer;
  scheduleSweeper();
}
type ProcessChange = { sessionKey: string; agentId?: string };
const changeListeners = new Set<(target: ProcessChange) => void>();
const pendingChanges = new Map<string, ProcessChange>();
let changeTimer: NodeJS.Timeout | undefined;

/** Process observation is independent of the creating turn's lifetime. */
export function onBackgroundProcessesChanged(listener: (target: ProcessChange) => void) {
  changeListeners.add(listener);
  return () => {
    changeListeners.delete(listener);
    if (changeListeners.size === 0) {
      clearTimeout(changeTimer);
      changeTimer = undefined;
      pendingChanges.clear();
    }
  };
}

function queueProcessChange(session: ProcessSession) {
  const sessionKey = session.scopeKey ?? session.sessionKey;
  if (!sessionKey || changeListeners.size === 0) {
    return;
  }
  const target = { sessionKey, agentId: session.agentId };
  pendingChanges.set(JSON.stringify([sessionKey, session.agentId]), target);
  // Bound chatty output to the former five-second polling cadence. Later writes
  // never postpone the signal, and no command text or output crosses this bus.
  changeTimer ??= runInDetachedAsyncContext(() =>
    setTimeout(() => {
      changeTimer = undefined;
      const changes = [...pendingChanges.values()];
      pendingChanges.clear();
      for (const change of changes) {
        notifyListeners(changeListeners, change);
      }
    }, 5_000),
  );
  changeTimer.unref();
}

/** Return whether a process session id is live, retained, or reserved for notification. */
export function isProcessSessionIdTaken(id: string): boolean {
  return runningSessions.has(id) || finishedSessions.has(id) || activeExecSessions.has(id);
}

/** Adds a running session; retention starts only after background completion. */
export function addSession(session: ProcessSession) {
  processSessionStartOrders.set(session, nextProcessSessionStartOrder++);
  processInstanceIds.set(session, randomUUID());
  runningSessions.set(session.id, session);
  activeExecSessions.set(session.id, { session, promoted: session.backgrounded });
  if (session.backgrounded) {
    queueProcessChange(session);
  }
  if (session.durable) {
    scheduleSweeper();
  }
}

/** Sorts registered process records newest-first, including same-millisecond starts. */
export function compareProcessSessionStartOrder(
  left: { startedAt: number },
  right: { startedAt: number },
): number {
  return (
    right.startedAt - left.startedAt ||
    processSessionStartOrders.get(right)! - processSessionStartOrders.get(left)!
  );
}

/** Stable while this exact process is retained, including after its friendly ID is reused. */
export function processSessionInstanceId(session: ProcessSession): string {
  const id = processInstanceIds.get(session);
  if (!id) {
    throw new Error("Process is not registered");
  }
  return id;
}

/** Returns a running session by id. */
export function getSession(id: string) {
  return runningSessions.get(id);
}

/** Returns a retained finished background session by id. */
export function getFinishedSession(id: string) {
  return finishedSessions.get(id);
}

function deleteFinishedSession(id: string): boolean {
  const session = finishedSessions.get(id);
  if (!session) {
    return false;
  }
  finishedSessions.delete(id);
  finishedSessionOutputChars -= session.output.length;
  session.durable?.remove();
  queueProcessChange(session);
  return true;
}

/** Removes visible session records without changing live-process activity. */
export function deleteSession(id: string) {
  const session = runningSessions.get(id);
  runningSessions.delete(id);
  if (session && (session.backgrounded || activeExecSessions.get(id)?.promoted)) {
    queueProcessChange(session);
  }
  deleteFinishedSession(id);
  scheduleSweeper();
}

/** Removes completed process records belonging to retired session identities. */
export function clearFinishedSessionsForScopes(scopeKeys: Iterable<string>): void {
  const retiredScopes = new Set<string>();
  for (const scopeKey of scopeKeys) {
    const normalizedScope = scopeKey.trim();
    if (normalizedScope) {
      retiredScopes.add(normalizedScope);
    }
  }
  if (retiredScopes.size === 0) {
    return;
  }
  for (const [id, session] of finishedSessions) {
    if (session.scopeKey && retiredScopes.has(session.scopeKey)) {
      deleteFinishedSession(id);
    }
  }
  scheduleSweeper();
}

/** Appends process output while enforcing aggregate and pending-output caps. */
export function appendOutput(session: ProcessSession, stream: "stdout" | "stderr", chunk: string) {
  if (!chunk || typeof session.pendingOutput === "string") {
    return;
  }
  const streamChars = stream === "stdout" ? session.pendingStdoutChars : session.pendingStderrChars;
  const pendingCap = Math.min(
    session.pendingMaxOutputChars ?? DEFAULT_PENDING_OUTPUT_CHARS,
    session.maxOutputChars,
  );
  // Own only the retained suffix; producer strings may borrow a large callback.
  const ownedChunk = {
    order: session.totalOutputChars,
    text: encodeOwnedBuffer(
      sliceUtf16Safe(chunk, Math.max(0, chunk.length - session.maxOutputChars)),
      "utf16le",
    ),
  };
  const pending = session.pendingOutput[stream];
  pending.append(ownedChunk, pendingCap, chunk.length);
  const pendingChars = pending.length;
  if (pendingChars < streamChars + chunk.length) {
    session.truncated = true;
    session.pendingOutputDropped = true;
  }
  if (stream === "stdout") {
    session.pendingStdoutChars = pendingChars;
  } else {
    session.pendingStderrChars = pendingChars;
  }
  session.totalOutputChars += chunk.length;
  const previousLength = session.output.length;
  session.output.append(ownedChunk, session.maxOutputChars, chunk.length);
  session.truncated ||= session.output.length < previousLength + chunk.length;
  if (session.backgrounded) {
    queueProcessChange(session);
  }
}

/** Drains pending chunks in producer callback order for a process poll. */
function drainSession(session: ProcessSession) {
  const pending = session.pendingOutput;
  const output =
    typeof pending === "string"
      ? pending
      : Buffer.concat(
          [...pending.stdout.entries(), ...pending.stderr.entries()]
            .toSorted((a, b) => a.order - b.order)
            .map((chunk) => chunk.text),
        ).toString("utf16le");
  const outputDropped = session.pendingOutputDropped;
  // Draining a terminal record must not reopen it to late producer callbacks.
  session.pendingOutput =
    typeof pending === "string" ? "" : { stdout: new ProcessOutput(), stderr: new ProcessOutput() };
  session.pendingStdoutChars = 0;
  session.pendingStderrChars = 0;
  session.pendingOutputDropped = false;
  return { output, outputDropped };
}

/** Stages one poll result until the agent transcript acknowledges its attachment. */
export function prepareSessionPoll(session: ProcessSession, scope: object | undefined) {
  if (!scope) {
    return { ...drainSession(session), acknowledge() {} };
  }
  let delivery = session.pendingPollDelivery;
  if (delivery) {
    // The first retry claims the staged bytes for its turn. Parallel siblings then
    // observe that scope and cannot duplicate the recovery result.
    if (delivery.scope === scope) {
      return { output: "", outputDropped: false, acknowledge() {} };
    }
    delivery.scope = scope;
  } else {
    const drained = drainSession(session);
    if (drained.output.length === 0 && !drained.outputDropped) {
      return { ...drained, acknowledge() {} };
    }
    delivery = { ...drained, scope };
    session.pendingPollDelivery = delivery;
  }
  return {
    output: delivery.output,
    outputDropped: delivery.outputDropped,
    acknowledge() {
      if (session.pendingPollDelivery === delivery) {
        session.pendingPollDelivery = undefined;
      }
    },
  };
}

/** Returns whether a prior poll has output ready for immediate replay. */
export function hasPendingPollDelivery(session: ProcessSession): boolean {
  return session.pendingPollDelivery !== undefined;
}

/** Moves a session to finished state and records exit metadata. */
export function markExited(
  session: ProcessSession,
  exitCode: number | null,
  exitSignal: NodeJS.Signals | number | null,
  status: Exclude<ProcessStatus, "running">,
  exitReason?: TerminationReason,
  noOutputTimedOut?: boolean,
) {
  // Visibility can be cleared before process termination. Keep suspension
  // blocked until the process owner reports the actual terminal transition.
  session.terminalStatus = status;
  session.exited = true;
  delete session.processActivity;
  session.exitCode = exitCode;
  session.exitSignal = exitSignal;
  session.exitReason = exitReason;
  session.noOutputTimedOut = noOutputTimedOut;
  // Finalizer diagnostics are already appended. Freeze output before retention
  // accounts for its size, and release the live per-callback chunk objects.
  const pending = drainSession(session);
  session.pendingOutput = pending.output;
  session.pendingOutputDropped = pending.outputDropped;
  session.output.freeze();
  moveToFinished(session);
  if (session.backgrounded) {
    queueProcessChange(session);
  }
  if (!session.finalizing) {
    settleExecSessionFinalization(session);
  }
}

/** Releases scope joins after the process owner's task and notification work settles. */
export function settleExecSessionFinalization(session: ProcessSession): void {
  session.finalizing = false;
  const active = activeExecSessions.get(session.id);
  if (active?.session === session) {
    activeExecSessions.delete(session.id);
    active.settled?.resolve();
  }
}

/** Publish accepted Stop while cleanup still owns the terminal transition. */
export function markCancellationRequested(session: ProcessSession) {
  if (session.cancellationRequested) {
    return;
  }
  session.cancellationRequested = true;
  if (session.backgrounded) {
    queueProcessChange(session);
  }
}

/** Marks a running session as reconnectable after the exec call returns. */
export function markBackgrounded(session: ProcessSession) {
  if (!session.backgrounded) {
    queueProcessChange(session);
  }
  session.backgrounded = true;
  const active = activeExecSessions.get(session.id);
  if (active?.session === session) {
    active.promoted = true;
  }
}

/** Retains the precise completion-event removal handle on its process owner. */
export function recordNotifyOnExitRemoval(
  session: ProcessSession,
  remove: NotifyOnExitRemoval,
): void {
  if (session.terminalPollObserved || session.requestCancelled) {
    remove();
    return;
  }
  session.notifyOnExitRemoval = remove;
}

/** Acknowledges one completion event without touching unrelated queue entries. */
export function acknowledgeNotifyOnExit(record: {
  notifyOnExitRemoval?: NotifyOnExitRemoval;
  terminalPollObserved?: boolean;
}): void {
  record.terminalPollObserved = true;
  removeNotifyOnExit(record);
}

/** Retire notification custody without claiming that retained output was observed. */
export function removeNotifyOnExit(record: { notifyOnExitRemoval?: NotifyOnExitRemoval }): void {
  const remove = record.notifyOnExitRemoval;
  if (!remove) {
    return;
  }
  remove();
  record.notifyOnExitRemoval = undefined;
}

/** Returns the number of live background exec sessions without exposing process details. */
export function getActiveBackgroundExecSessionCount(): number {
  let count = 0;
  for (const { promoted, session } of activeExecSessions.values()) {
    if (promoted && !session.durable) {
      count += 1;
    }
  }
  return count;
}

/** Joins registered exec cleanup, including foreground and hidden processes. */
export async function waitForExecScope(scopeKey: string): Promise<void> {
  while (true) {
    const pending = Array.from(activeExecSessions.values())
      .filter(({ session }) => session.scopeKey === scopeKey)
      .map((active) => (active.settled ??= createDeferredCore()).promise);
    if (pending.length === 0) {
      return;
    }
    await Promise.all(pending);
  }
}

/** Cancellation captures exact records, including startup, hidden work and queued completions. */
export function listExecSessionsForCancellation(): ProcessSession[] {
  return [
    ...new Set(
      [...activeExecSessions.values()]
        .map(({ session }) => session)
        .concat([...finishedSessions.values()]),
    ),
  ];
}

export async function waitForExecSession(session: ProcessSession): Promise<void> {
  const active = activeExecSessions.get(session.id);
  if (active?.session === session) {
    await (active.settled ??= createDeferredCore()).promise;
  }
}

function moveToFinished(session: ProcessSession) {
  runningSessions.delete(session.id);

  // The supervisor owns the raw process. The registry releases only the
  // prepared stdin wrapper retained for process-tool input.
  const stdin = session.stdin;
  if (stdin) {
    if (typeof stdin.destroy === "function") {
      stdin.destroy();
    } else {
      stdin.end();
    }
    delete session.stdin;
  }

  if (!session.backgrounded) {
    return;
  }
  // Keep full completed logs; evict older records rather than silently
  // truncating the process poll/log contract or dropping the newest result.
  deleteFinishedSession(session.id);
  const endedAt = session.endedAt ?? Date.now();
  finishedSessions.set(
    session.id,
    Object.assign(session, { endedAt, expiresAt: endedAt + session.cleanupMs }),
  );
  finishedSessionOutputChars += session.output.length;
  while (
    finishedSessions.size > MAX_FINISHED_SESSION_COUNT ||
    (finishedSessions.size > 1 && finishedSessionOutputChars > MAX_FINISHED_SESSION_OUTPUT_CHARS)
  ) {
    const oldestSessionId = finishedSessions.keys().next().value;
    if (oldestSessionId === undefined) {
      break;
    }
    deleteFinishedSession(oldestSessionId);
  }
  scheduleSweeper();
}

/** Returns the last `max` characters of text without adding ellipses. */
export function tail(text: string, max = 2000) {
  if (text.length <= max) {
    return text;
  }
  return Buffer.from(sliceUtf16Safe(text, text.length - max), "utf16le").toString("utf16le");
}

/** Lists backgrounded running sessions visible to reconnect/poll callers. */
export function listRunningSessions() {
  return Array.from(runningSessions.values()).filter((s) => s.backgrounded);
}

/** Lists retained finished background sessions. */
export function listFinishedSessions() {
  return Array.from(finishedSessions.values());
}

/** Test-only reset for in-memory registry state and retention timers. */
function resetProcessRegistryForTests() {
  clearTimeout(changeTimer);
  changeTimer = undefined;
  pendingChanges.clear();
  runningSessions.clear();
  finishedSessions.clear();
  processSessionStartOrders = new WeakMap();
  nextProcessSessionStartOrder = 0;
  finishedSessionOutputChars = 0;
  for (const active of activeExecSessions.values()) {
    active.settled?.resolve();
  }
  activeExecSessions.clear();
  observeDurableProcesses = undefined;
  stopSweeper();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.bashProcessRegistryTestApi")] =
    { resetProcessRegistryForTests };
}

function scheduleSweeper() {
  stopSweeper();
  const now = Date.now();
  let nextExpiration = Number.POSITIVE_INFINITY;
  for (const [id, session] of finishedSessions) {
    if (session.expiresAt <= now) {
      deleteFinishedSession(id);
    } else {
      nextExpiration = Math.min(nextExpiration, session.expiresAt);
    }
  }
  if (
    observeDurableProcesses &&
    [...activeExecSessions.values()].some(({ session }) => session.durable)
  ) {
    nextExpiration = Math.min(nextExpiration, now + 5_000);
  }
  if (!Number.isFinite(nextExpiration)) {
    return;
  }
  sweeper = runInDetachedAsyncContext(() =>
    setTimeout(() => {
      const observation = observeDurableProcesses?.();
      if (observation) {
        void observation.then(scheduleSweeper, scheduleSweeper);
      } else {
        scheduleSweeper();
      }
    }, nextExpiration - now),
  );
  sweeper.unref();
}

function stopSweeper() {
  if (!sweeper) {
    return;
  }
  clearTimeout(sweeper);
  sweeper = null;
}
