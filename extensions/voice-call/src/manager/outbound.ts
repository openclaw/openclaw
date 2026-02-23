import crypto from "node:crypto";
import type { CallMode } from "../config.js";
import {
  TerminalStates,
  type CallId,
  type CallRecord,
  type OutboundCallOptions,
} from "../types.js";
import { mapVoiceToPolly } from "../voice-mapping.js";
import type { CallManagerContext } from "./context.js";
import { getCallByProviderCallId } from "./lookup.js";
import { addTranscriptEntry, transitionState } from "./state.js";
import { persistCallRecord } from "./store.js";
import {
  clearMaxDurationTimer,
  clearTranscriptWaiter,
  rejectTranscriptWaiter,
  waitForFinalTranscript,
} from "./timers.js";
import { generateNotifyTwiml } from "./twiml.js";

type InitiateContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "provider" | "config" | "storePath" | "webhookUrl"
>;

type SpeakContext = Pick<
  CallManagerContext,
  "activeCalls" | "providerCallIdMap" | "provider" | "config" | "storePath"
>;

type ConversationContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "config"
  | "storePath"
  | "activeTurnCalls"
  | "transcriptWaiters"
  | "maxDurationTimers"
>;

type EndCallContext = Pick<
  CallManagerContext,
  | "activeCalls"
  | "providerCallIdMap"
  | "provider"
  | "storePath"
  | "transcriptWaiters"
  | "maxDurationTimers"
>;

type ConnectedCallContext = Pick<CallManagerContext, "activeCalls" | "provider">;

type ConnectedCallLookup =
  | { kind: "error"; error: string }
  | { kind: "ended"; call: CallRecord }
  | {
      kind: "ok";
      call: CallRecord;
      providerCallId: string;
      provider: NonNullable<ConnectedCallContext["provider"]>;
    };

type ConnectedCallResolution =
  | { ok: false; error: string }
  | {
      ok: true;
      call: CallRecord;
      providerCallId: string;
      provider: NonNullable<ConnectedCallContext["provider"]>;
    };

function lookupConnectedCall(ctx: ConnectedCallContext, callId: CallId): ConnectedCallLookup {
  const call = ctx.activeCalls.get(callId);
  if (!call) {
    return { kind: "error", error: "Call not found" };
  }
  if (!ctx.provider || !call.providerCallId) {
    return { kind: "error", error: "Call not connected" };
  }
  if (TerminalStates.has(call.state)) {
    return { kind: "ended", call };
  }
  return { kind: "ok", call, providerCallId: call.providerCallId, provider: ctx.provider };
}

function requireConnectedCall(ctx: ConnectedCallContext, callId: CallId): ConnectedCallResolution {
  const lookup = lookupConnectedCall(ctx, callId);
  if (lookup.kind === "error") {
    return { ok: false, error: lookup.error };
  }
  if (lookup.kind === "ended") {
    return { ok: false, error: "Call has ended" };
  }
  return {
    ok: true,
    call: lookup.call,
    providerCallId: lookup.providerCallId,
    provider: lookup.provider,
  };
}

export async function initiateCall(
  ctx: InitiateContext,
  to: string,
  sessionKey?: string,
  options?: OutboundCallOptions | string,
): Promise<{ callId: CallId; success: boolean; error?: string }> {
  const opts: OutboundCallOptions =
    typeof options === "string" ? { message: options } : (options ?? {});
  const initialMessage = opts.message;
  const mode = opts.mode ?? ctx.config.outbound.defaultMode;

  if (!ctx.provider) {
    return { callId: "", success: false, error: "Provider not initialized" };
  }
  if (!ctx.webhookUrl) {
    return { callId: "", success: false, error: "Webhook URL not configured" };
  }

  if (ctx.activeCalls.size >= ctx.config.maxConcurrentCalls) {
    return {
      callId: "",
      success: false,
      error: `Maximum concurrent calls (${ctx.config.maxConcurrentCalls}) reached`,
    };
  }

  const callId = crypto.randomUUID();
  const from =
    ctx.config.fromNumber || (ctx.provider?.name === "mock" ? "+15550000000" : undefined);
  if (!from) {
    return { callId: "", success: false, error: "fromNumber not configured" };
  }

  const callRecord: CallRecord = {
    callId,
    provider: ctx.provider.name,
    direction: "outbound",
    state: "initiated",
    from,
    to,
    sessionKey,
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      ...(initialMessage && { initialMessage }),
      mode,
    },
  };

  ctx.activeCalls.set(callId, callRecord);
  persistCallRecord(ctx.storePath, callRecord);

  try {
    // For notify mode with a message, use inline TwiML with <Say>.
    let inlineTwiml: string | undefined;
    if (mode === "notify" && initialMessage) {
      const pollyVoice = mapVoiceToPolly(ctx.config.tts?.openai?.voice);
      inlineTwiml = generateNotifyTwiml(initialMessage, pollyVoice);
      console.log(`[voice-call] Using inline TwiML for notify mode (voice: ${pollyVoice})`);
    }

    const result = await ctx.provider.initiateCall({
      callId,
      from,
      to,
      webhookUrl: ctx.webhookUrl,
      inlineTwiml,
    });

    callRecord.providerCallId = result.providerCallId;
    ctx.providerCallIdMap.set(result.providerCallId, callId);
    persistCallRecord(ctx.storePath, callRecord);

    return { callId, success: true };
  } catch (err) {
    callRecord.state = "failed";
    callRecord.endedAt = Date.now();
    callRecord.endReason = "failed";
    persistCallRecord(ctx.storePath, callRecord);
    ctx.activeCalls.delete(callId);
    if (callRecord.providerCallId) {
      ctx.providerCallIdMap.delete(callRecord.providerCallId);
    }

    return {
      callId,
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function speak(
  ctx: SpeakContext,
  callId: CallId,
  text: string,
): Promise<{ success: boolean; error?: string }> {
  const connected = requireConnectedCall(ctx, callId);
  if (!connected.ok) {
    return { success: false, error: connected.error };
  }
  const { call, providerCallId, provider } = connected;

  try {
    transitionState(call, "speaking");
    persistCallRecord(ctx.storePath, call);

    addTranscriptEntry(call, "bot", text);

    const voice = provider.name === "twilio" ? ctx.config.tts?.openai?.voice : undefined;
    await provider.playTts({
      callId,
      providerCallId,
      text,
      voice,
    });

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function speakInitialMessage(
  ctx: ConversationContext,
  providerCallId: string,
): Promise<void> {
  const call = getCallByProviderCallId({
    activeCalls: ctx.activeCalls,
    providerCallIdMap: ctx.providerCallIdMap,
    providerCallId,
  });
  if (!call) {
    console.warn(`[voice-call] speakInitialMessage: no call found for ${providerCallId}`);
    return;
  }

  const initialMessage = call.metadata?.initialMessage as string | undefined;
  const mode = (call.metadata?.mode as CallMode) ?? "conversation";

  if (!initialMessage) {
    console.log(`[voice-call] speakInitialMessage: no initial message for ${call.callId}`);
    return;
  }

  // Clear so we don't speak it again if the provider reconnects.
  if (call.metadata) {
    delete call.metadata.initialMessage;
    persistCallRecord(ctx.storePath, call);
  }

  console.log(`[voice-call] Speaking initial message for call ${call.callId} (mode: ${mode})`);
  const result = await speak(ctx, call.callId, initialMessage);
  if (!result.success) {
    console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
    return;
  }

  if (mode === "notify") {
    const delaySec = ctx.config.outbound.notifyHangupDelaySec;
    console.log(`[voice-call] Notify mode: auto-hangup in ${delaySec}s for call ${call.callId}`);
    setTimeout(async () => {
      const currentCall = ctx.activeCalls.get(call.callId);
      if (currentCall && !TerminalStates.has(currentCall.state)) {
        console.log(`[voice-call] Notify mode: hanging up call ${call.callId}`);
        await endCall(ctx, call.callId);
      }
    }, delaySec * 1000);
  }
}

export async function continueCall(
  ctx: ConversationContext,
  callId: CallId,
  prompt: string,
): Promise<{ success: boolean; transcript?: string; error?: string }> {
  const connected = requireConnectedCall(ctx, callId);
  if (!connected.ok) {
    return { success: false, error: connected.error };
  }
  const { call, providerCallId, provider } = connected;

  if (ctx.activeTurnCalls.has(callId) || ctx.transcriptWaiters.has(callId)) {
    return { success: false, error: "Already waiting for transcript" };
  }
  ctx.activeTurnCalls.add(callId);

  const turnStartedAt = Date.now();

  try {
    await speak(ctx, callId, prompt);

    transitionState(call, "listening");
    persistCallRecord(ctx.storePath, call);

    const listenStartedAt = Date.now();
    await provider.startListening({ callId, providerCallId });

    const transcript = await waitForFinalTranscript(ctx, callId);
    const transcriptReceivedAt = Date.now();

    // Best-effort: stop listening after final transcript.
    await provider.stopListening({ callId, providerCallId });

    const lastTurnLatencyMs = transcriptReceivedAt - turnStartedAt;
    const lastTurnListenWaitMs = transcriptReceivedAt - listenStartedAt;
    const turnCount =
      call.metadata && typeof call.metadata.turnCount === "number"
        ? call.metadata.turnCount + 1
        : 1;

    call.metadata = {
      ...(call.metadata ?? {}),
      turnCount,
      lastTurnLatencyMs,
      lastTurnListenWaitMs,
      lastTurnCompletedAt: transcriptReceivedAt,
    };
    persistCallRecord(ctx.storePath, call);

    console.log(
      "[voice-call] continueCall latency call=" +
        call.callId +
        " totalMs=" +
        String(lastTurnLatencyMs) +
        " listenWaitMs=" +
        String(lastTurnListenWaitMs),
    );

    return { success: true, transcript };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    ctx.activeTurnCalls.delete(callId);
    clearTranscriptWaiter(ctx, callId);
  }
}

export async function endCall(
  ctx: EndCallContext,
  callId: CallId,
): Promise<{ success: boolean; error?: string }> {
  const lookup = lookupConnectedCall(ctx, callId);
  if (lookup.kind === "error") {
    return { success: false, error: lookup.error };
  }
  if (lookup.kind === "ended") {
    return { success: true };
  }
  const { call, providerCallId, provider } = lookup;

  try {
    await provider.hangupCall({
      callId,
      providerCallId,
      reason: "hangup-bot",
    });

    call.state = "hangup-bot";
    call.endedAt = Date.now();
    call.endReason = "hangup-bot";
    persistCallRecord(ctx.storePath, call);

    clearMaxDurationTimer(ctx, callId);
    rejectTranscriptWaiter(ctx, callId, "Call ended: hangup-bot");

    ctx.activeCalls.delete(callId);
    ctx.providerCallIdMap.delete(providerCallId);

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
