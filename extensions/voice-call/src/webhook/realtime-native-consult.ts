import type { RealtimeVoiceBridgeSession } from "openclaw/plugin-sdk/realtime-voice";

const CONSULT_TRANSCRIPT_SETTLE_MS = 350;
const CONSULT_TRANSCRIPT_SETTLE_MAX_MS = 1_000;

export type UserTranscriptState = {
  partial?: string;
  partialOwner?: object;
  rawPartial?: string;
  partialUpdatedAt?: number;
  recentFinal?: string;
  recentFinalOwner?: object;
  recentFinalTimer?: ReturnType<typeof setTimeout>;
  nativeConsultInvocation?: { id: string };
};

type TranscriptSnapshot = { text: string | undefined; owner: object | undefined };

export type NativeConsultTranscript = () => TranscriptSnapshot;

/** Capture before persistence yields; later invocations must not change an earlier question. */
export function captureNativeConsultTranscript(
  state: UserTranscriptState,
  invocationId: string,
): NativeConsultTranscript {
  const previous = state.nativeConsultInvocation;
  const invocation =
    invocationId.trim() && previous?.id === invocationId ? previous : { id: invocationId };
  const read = (): TranscriptSnapshot => ({
    text: state.partial ?? state.recentFinal,
    owner: state.partial !== undefined ? state.partialOwner : state.recentFinalOwner,
  });
  const initial = read();
  state.nativeConsultInvocation = invocation;
  // Exact replays retain the same marker and normal ASR settling. An empty frozen
  // snapshot is meaningful: never replace it with a later caller's transcript.
  return () => (state.nativeConsultInvocation === invocation ? read() : initial);
}

function remainingNativeConsultTranscript(
  current: string | undefined,
  consumed: string | undefined,
): string | undefined {
  const prefix = consumed?.trim();
  if (!prefix || !current?.toLowerCase().startsWith(prefix.toLowerCase())) {
    return current;
  }
  return current.slice(prefix.length).trimStart() || undefined;
}

export function consumeNativeConsultTranscript(
  state: UserTranscriptState | undefined,
  consumed: TranscriptSnapshot | undefined,
  clearPartial: () => void,
  clearRecentFinal: () => void,
): void {
  if (!state || !consumed?.owner) {
    return;
  }
  const partial =
    state.partialOwner === consumed.owner
      ? remainingNativeConsultTranscript(state.partial, consumed.text)
      : state.partial;
  if (partial !== state.partial) {
    if (partial) {
      state.partial = partial;
      state.rawPartial = partial;
    } else {
      clearPartial();
    }
  }
  // Repeated words do not establish lineage. Only the admitted ASR buffer or its
  // finalization may be consumed; an independently replaced final belongs to B.
  const final =
    state.recentFinalOwner === consumed.owner
      ? remainingNativeConsultTranscript(state.recentFinal, consumed.text)
      : state.recentFinal;
  if (final !== state.recentFinal) {
    if (final) {
      // The original timer still owns expiry; consuming A must not extend B's lifetime.
      state.recentFinal = final;
    } else {
      clearRecentFinal();
    }
  }
}

export async function waitForNativeConsultTranscriptSettle(
  readUpdatedAt: () => number | undefined,
  startedAt: number,
): Promise<void> {
  const deadline = startedAt + CONSULT_TRANSCRIPT_SETTLE_MAX_MS;
  while (true) {
    const updatedAt = readUpdatedAt();
    if (!updatedAt) {
      return;
    }
    const now = Date.now();
    const quietFor = now - updatedAt;
    if (quietFor >= CONSULT_TRANSCRIPT_SETTLE_MS || now >= deadline) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(CONSULT_TRANSCRIPT_SETTLE_MS - quietFor, deadline - now));
    });
  }
}

export type NativeConsultState = {
  owner: RealtimeVoiceBridgeSession;
  readonly invocationId: string;
  startedAt: number;
  promise: Promise<unknown>;
  cancellation: Promise<void>;
  readonly cancelled: boolean;
  cancel: () => void;
  transcript?: TranscriptSnapshot;
};

type NativeConsultOutcome = { kind: "completed"; result: unknown } | { kind: "cancelled" };

export async function waitForNativeConsult(
  state: NativeConsultState,
): Promise<NativeConsultOutcome> {
  return await Promise.race([
    state.promise.then((result) => ({ kind: "completed", result }) as const),
    state.cancellation.then(() => ({ kind: "cancelled" }) as const),
  ]);
}
