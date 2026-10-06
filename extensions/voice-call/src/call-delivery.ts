import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { VoiceCallConfig } from "./config.js";
import { copyCallRecord } from "./manager/state.js";
import { TerminalStates, type CallRecord } from "./types.js";

type TranscriptEntry = CallRecord["transcript"][number];

export type CallDeliveryMessage = {
  sessionKey: string;
  callId: string;
  kind: "live" | "report";
  text: string;
  idempotencyKey: string;
};

type LiveCallDelivery = {
  call: CallRecord;
  cursor: number;
  lines: TranscriptEntry[];
  start: number;
  timer?: ReturnType<typeof setTimeout>;
  work: Promise<void>;
};

function requesterSession(call: CallRecord, config: VoiceCallConfig): string | undefined {
  const session = call.metadata?.requesterSessionKey;
  return typeof session === "string" && session.trim()
    ? session.trim()
    : call.direction === "inbound"
      ? config.reports.inboundSessionKey?.trim() || undefined
      : undefined;
}

/** Transcript index already handed to a live batch by an earlier process, if any. */
function persistedLiveCursor(call: CallRecord): number {
  const delivery = call.metadata?.liveTranscriptDelivery;
  const cursor =
    delivery !== null && typeof delivery === "object" && "cursor" in delivery
      ? delivery.cursor
      : undefined;
  return typeof cursor === "number" && Number.isInteger(cursor) && cursor >= 0
    ? Math.min(cursor, call.transcript.length)
    : 0;
}

export function formatCallTranscript(entries: readonly TranscriptEntry[]): string {
  return entries
    .filter((entry) => entry.isFinal)
    .map((entry) => `${entry.speaker === "bot" ? "Assistant" : "Callee"}: ${entry.text}`)
    .join("\n");
}

function formatReport(call: CallRecord, summary: string, includeTranscript: boolean): string {
  const duration = Math.max(0, Math.round(((call.endedAt ?? Date.now()) - call.startedAt) / 1000));
  const lines = [
    `Voice call ${call.callId}`,
    summary,
    `Duration: ${duration} seconds`,
    `End reason: ${call.endReason ?? call.state}`,
  ];
  if (typeof call.metadata?.answeredBy === "string") {
    lines.push(`Answered by: ${call.metadata.answeredBy}`);
  }
  if (typeof call.metadata?.callbackOfCallId === "string") {
    lines.push(`Callback to call: ${call.metadata.callbackOfCallId}`);
  }
  if (typeof call.metadata?.voicemailStatus === "string") {
    lines.push(`Voicemail: ${call.metadata.voicemailStatus}`);
  }
  if (typeof call.metadata?.voicemailError === "string") {
    lines.push(`Voicemail error: ${call.metadata.voicemailError}`);
  }
  if (typeof call.metadata?.notifyStatus === "string") {
    lines.push(`Notification: ${call.metadata.notifyStatus}`);
  }
  if (typeof call.metadata?.notifyError === "string") {
    lines.push(`Notification error: ${call.metadata.notifyError}`);
  }
  if (includeTranscript) {
    lines.push(
      "",
      "Transcript:",
      formatCallTranscript(call.transcript) || "(No final speech recorded)",
    );
  }
  return lines.join("\n");
}

/** Observe committed manager records; all notification work belongs to this runtime lifecycle. */
export function createCallDelivery(params: {
  config: VoiceCallConfig;
  deliver: (message: CallDeliveryMessage) => Promise<void>;
  summarize: (call: CallRecord, model?: string) => Promise<string>;
  persist: (call: CallRecord) => Promise<void>;
  onError?: (error: unknown) => void;
}): { observe: (call: CallRecord) => Promise<void>; stop: () => Promise<void> } {
  const live = new Map<string, LiveCallDelivery>();
  const ended = new WeakMap<CallRecord, Promise<void>>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  let stopping: Promise<void> | undefined;

  const track = (work: Promise<void>): Promise<void> => {
    pending.add(work);
    const remove = () => pending.delete(work);
    void work.then(remove, remove);
    return work;
  };
  const assertActive = () => {
    if (closed) {
      throw new Error("Voice Call delivery stopped");
    }
  };
  const saveStatus = async (call: CallRecord, key: string, value: Record<string, unknown>) => {
    call.metadata = { ...call.metadata, [key]: value };
    await params.persist(call);
  };
  const recordFailure = async (
    call: CallRecord,
    key: string,
    error: unknown,
    extra?: Record<string, unknown>,
  ) => {
    params.onError?.(error);
    await saveStatus(call, key, {
      status: "failed",
      error: formatErrorMessage(error),
      at: Date.now(),
      ...extra,
    }).catch((failure: unknown) => params.onError?.(failure));
  };

  const flush = (state: LiveCallDelivery, sessionKey: string): Promise<void> => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    if (state.lines.length === 0) {
      return state.work;
    }
    const entries = state.lines.splice(0);
    const range = `${state.start}-${state.cursor}`;
    const cursor = state.cursor;
    state.start = state.cursor;
    const snapshot = copyCallRecord(state.call);
    state.work = track(
      state.work.then(async () => {
        try {
          assertActive();
          // Persist the batch end before sending: after a restart the restored call resumes
          // from this cursor, so a delivered or uncertain batch is never sent twice.
          await saveStatus(snapshot, "liveTranscriptDelivery", {
            status: "sent",
            cursor,
            at: Date.now(),
          });
          assertActive();
          await params.deliver({
            sessionKey,
            callId: snapshot.callId,
            kind: "live",
            text: `Voice call ${snapshot.callId}, live transcript:\n${formatCallTranscript(entries)}`,
            idempotencyKey: `voice-call:${snapshot.callId}:live:${range}`,
          });
        } catch (error) {
          await recordFailure(snapshot, "liveTranscriptDelivery", error, { cursor });
        }
      }),
    );
    return state.work;
  };

  const report = async (call: CallRecord, sessionKey: string | undefined): Promise<void> => {
    const previousStatus = call.metadata?.callReport;
    if (!params.config.reports.enabled || previousStatus !== undefined) {
      return;
    }
    if (!sessionKey) {
      await saveStatus(call, "callReport", {
        status: "skipped",
        reason: "No requester session",
        at: Date.now(),
      });
      return;
    }
    try {
      assertActive();
      // Persist before inference or sending so a restart records the interrupted attempt.
      await saveStatus(call, "callReport", { status: "pending", at: Date.now() });
      assertActive();
      let summary = "Outcome: needs follow-up. Summary unavailable; review the transcript.";
      let summaryError: string | undefined;
      try {
        summary =
          (await params.summarize(call, params.config.reports.summaryModel)).trim() || summary;
      } catch (error) {
        summaryError = formatErrorMessage(error);
        params.onError?.(error);
      }
      assertActive();
      await params.deliver({
        sessionKey,
        callId: call.callId,
        kind: "report",
        text: formatReport(call, summary, params.config.reports.includeTranscript),
        idempotencyKey: `voice-call:${call.callId}:report`,
      });
      await saveStatus(call, "callReport", {
        status: "delivered",
        at: Date.now(),
        ...(summaryError ? { summaryError } : {}),
      });
    } catch (error) {
      await recordFailure(call, "callReport", error);
    }
  };

  const observe = (call: CallRecord): Promise<void> => {
    const existing = ended.get(call);
    if (existing) {
      return existing;
    }
    if (closed) {
      return Promise.resolve();
    }
    const snapshot = copyCallRecord(call);
    const sessionKey = requesterSession(snapshot, params.config);
    let state = live.get(call.callId);
    if (params.config.live.transcript && sessionKey) {
      if (!state) {
        const cursor = persistedLiveCursor(snapshot);
        state = { call: snapshot, cursor, start: cursor, lines: [], work: Promise.resolve() };
        live.set(call.callId, state);
      }
      state.call = snapshot;
      state.lines.push(...snapshot.transcript.slice(state.cursor).filter((entry) => entry.isFinal));
      state.cursor = snapshot.transcript.length;
      if (state.lines.length > 0 && !state.timer && !TerminalStates.has(snapshot.state)) {
        const current = state;
        state.timer = setTimeout(() => {
          void flush(current, sessionKey);
        }, params.config.live.minIntervalMs);
      }
    }
    if (!TerminalStates.has(snapshot.state)) {
      return Promise.resolve();
    }
    const lastBatch = state && sessionKey ? flush(state, sessionKey) : Promise.resolve();
    live.delete(call.callId);
    const completion = track(
      lastBatch
        .then(() => report(snapshot, sessionKey))
        .catch((error: unknown) => {
          params.onError?.(error);
        }),
    );
    ended.set(call, completion);
    return completion;
  };

  return {
    observe,
    stop() {
      if (!stopping) {
        closed = true;
        for (const state of live.values()) {
          if (state.timer) {
            clearTimeout(state.timer);
          }
        }
        live.clear();
        stopping = (async () => {
          while (pending.size > 0) {
            await Promise.allSettled(pending);
          }
        })();
      }
      return stopping;
    },
  };
}
