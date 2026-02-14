import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CallMode, VoiceCallConfig } from "./config.js";
import type { CallManagerContext } from "./manager/context.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { processEvent as processManagerEvent } from "./manager/events.js";
import {
  type CallId,
  type CallRecord,
  CallRecordSchema,
  type NormalizedEvent,
  type OutboundCallOptions,
  TerminalStates,
  type TranscriptEntry,
} from "./types.js";
import { resolveUserPath } from "./utils.js";
import { escapeXml, mapVoiceToPolly } from "./voice-mapping.js";

function resolveDefaultStoreBase(config: VoiceCallConfig, storePath?: string): string {
  const rawOverride = storePath?.trim() || config.store?.trim();
  if (rawOverride) {
    return resolveUserPath(rawOverride);
  }
  const preferred = path.join(os.homedir(), ".openclaw", "voice-calls");
  const candidates = [preferred].map((dir) => resolveUserPath(dir));
  const existing =
    candidates.find((dir) => {
      try {
        return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
      } catch {
        return false;
      }
    }) ?? resolveUserPath(preferred);
  return existing;
}

/**
 * Manages voice calls: state machine, persistence, and provider coordination.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private providerCallIdMap = new Map<string, CallId>(); // providerCallId -> internal callId
  private processedEventIds = new Set<string>();
  private rejectedProviderCallIds = new Set<string>();
  private provider: VoiceCallProvider | null = null;
  private config: VoiceCallConfig;
  private storePath: string;
  private webhookUrl: string | null = null;
  private transcriptWaiters = new Map<
    CallId,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  /** Max duration timers to auto-hangup calls after configured timeout */
  private maxDurationTimers = new Map<CallId, NodeJS.Timeout>();

  constructor(config: VoiceCallConfig, storePath?: string) {
    this.config = config;
    // Resolve store path with tilde expansion (like other config values)
    this.storePath = resolveDefaultStoreBase(config, storePath);
  }

  /**
   * Initialize the call manager with a provider.
   */
  initialize(provider: VoiceCallProvider, webhookUrl: string): void {
    this.provider = provider;
    this.webhookUrl = webhookUrl;

    // Ensure store directory exists
    fs.mkdirSync(this.storePath, { recursive: true });

    // Load any persisted active calls
    this.loadActiveCalls();
  }

  /**
   * Get the current provider.
   */
  getProvider(): VoiceCallProvider | null {
    return this.provider;
  }

  /**
   * Initiate an outbound call.
   * @param to - The phone number to call
   * @param sessionKey - Optional session key for context
   * @param options - Optional call options (message, mode)
   */
  async initiateCall(
    to: string,
    sessionKey?: string,
    options?: OutboundCallOptions | string,
  ): Promise<{ callId: CallId; success: boolean; error?: string }> {
    // Support legacy string argument for initialMessage
    const opts: OutboundCallOptions =
      typeof options === "string" ? { message: options } : (options ?? {});
    const initialMessage = opts.message;
    const mode = opts.mode ?? this.config.outbound.defaultMode;
    if (!this.provider) {
      return { callId: "", success: false, error: "Provider not initialized" };
    }

    if (!this.webhookUrl) {
      return {
        callId: "",
        success: false,
        error: "Webhook URL not configured",
      };
    }

    // Check concurrent call limit
    const activeCalls = this.getActiveCalls();
    if (activeCalls.length >= this.config.maxConcurrentCalls) {
      return {
        callId: "",
        success: false,
        error: `Maximum concurrent calls (${this.config.maxConcurrentCalls}) reached`,
      };
    }

    const callId = crypto.randomUUID();
    const from =
      this.config.fromNumber || (this.provider?.name === "mock" ? "+15550000000" : undefined);
    if (!from) {
      return { callId: "", success: false, error: "fromNumber not configured" };
    }

    // Create call record with mode in metadata
    const callRecord: CallRecord = {
      callId,
      provider: this.provider.name,
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

    this.activeCalls.set(callId, callRecord);
    this.persistCallRecord(callRecord);

    try {
      // For notify mode with a message, use inline TwiML with <Say>
      let inlineTwiml: string | undefined;
      if (mode === "notify" && initialMessage) {
        const pollyVoice = mapVoiceToPolly(this.config.tts?.openai?.voice);
        inlineTwiml = this.generateNotifyTwiml(initialMessage, pollyVoice);
        console.log(`[voice-call] Using inline TwiML for notify mode (voice: ${pollyVoice})`);
      }

      const result = await this.provider.initiateCall({
        callId,
        from,
        to,
        webhookUrl: this.webhookUrl,
        inlineTwiml,
      });

      callRecord.providerCallId = result.providerCallId;
      this.providerCallIdMap.set(result.providerCallId, callId); // Map providerCallId to internal callId
      this.persistCallRecord(callRecord);

      return { callId, success: true };
    } catch (err) {
      callRecord.state = "failed";
      callRecord.endedAt = Date.now();
      callRecord.endReason = "failed";
      this.persistCallRecord(callRecord);
      this.activeCalls.delete(callId);
      if (callRecord.providerCallId) {
        this.providerCallIdMap.delete(callRecord.providerCallId);
      }

      return {
        callId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Speak to user in an active call.
   */
  async speak(callId: CallId, text: string): Promise<{ success: boolean; error?: string }> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return { success: false, error: "Call not found" };
    }

    if (!this.provider || !call.providerCallId) {
      return { success: false, error: "Call not connected" };
    }

    if (TerminalStates.has(call.state)) {
      return { success: false, error: "Call has ended" };
    }

    try {
      // Update state
      call.state = "speaking";
      this.persistCallRecord(call);

      // Add to transcript
      this.addTranscriptEntry(call, "bot", text);

      // Play TTS
      const voice = this.provider?.name === "twilio" ? this.config.tts?.openai?.voice : undefined;
      await this.provider.playTts({
        callId,
        providerCallId: call.providerCallId,
        text,
        voice,
      });

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Speak the initial message for a call (called when media stream connects).
   * This is used to auto-play the message passed to initiateCall.
   * In notify mode, auto-hangup after the message is delivered.
   */
  async speakInitialMessage(providerCallId: string): Promise<void> {
    const call = this.getCallByProviderCallId(providerCallId);
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

    // Clear the initial message so we don't speak it again
    if (call.metadata) {
      delete call.metadata.initialMessage;
      this.persistCallRecord(call);
    }

    console.log(`[voice-call] Speaking initial message for call ${call.callId} (mode: ${mode})`);
    const result = await this.speak(call.callId, initialMessage);
    if (!result.success) {
      console.warn(`[voice-call] Failed to speak initial message: ${result.error}`);
      return;
    }

    // In notify mode, auto-hangup after delay
    if (mode === "notify") {
      const delaySec = this.config.outbound.notifyHangupDelaySec;
      console.log(`[voice-call] Notify mode: auto-hangup in ${delaySec}s for call ${call.callId}`);
      setTimeout(async () => {
        const currentCall = this.getCall(call.callId);
        if (currentCall && !TerminalStates.has(currentCall.state)) {
          console.log(`[voice-call] Notify mode: hanging up call ${call.callId}`);
          await this.endCall(call.callId);
        }
      }, delaySec * 1000);
    }
  }

  /**
   * Clear max duration timer for a call.
   */
  private clearMaxDurationTimer(callId: CallId): void {
    const timer = this.maxDurationTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.maxDurationTimers.delete(callId);
    }
  }

  private clearTranscriptWaiter(callId: CallId): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (!waiter) {
      return;
    }
    clearTimeout(waiter.timeout);
    this.transcriptWaiters.delete(callId);
  }

  private rejectTranscriptWaiter(callId: CallId, reason: string): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (!waiter) {
      return;
    }
    this.clearTranscriptWaiter(callId);
    waiter.reject(new Error(reason));
  }

  private waitForFinalTranscript(callId: CallId): Promise<string> {
    // Only allow one in-flight waiter per call.
    this.rejectTranscriptWaiter(callId, "Transcript waiter replaced");

    const timeoutMs = this.config.transcriptTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.transcriptWaiters.delete(callId);
        reject(new Error(`Timed out waiting for transcript after ${timeoutMs}ms`));
      }, timeoutMs);

      this.transcriptWaiters.set(callId, { resolve, reject, timeout });
    });
  }

  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string,
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return { success: false, error: "Call not found" };
    }

    if (!this.provider || !call.providerCallId) {
      return { success: false, error: "Call not connected" };
    }

    if (TerminalStates.has(call.state)) {
      return { success: false, error: "Call has ended" };
    }

    try {
      await this.speak(callId, prompt);

      call.state = "listening";
      this.persistCallRecord(call);

      await this.provider.startListening({
        callId,
        providerCallId: call.providerCallId,
      });

      const transcript = await this.waitForFinalTranscript(callId);

      // Best-effort: stop listening after final transcript.
      await this.provider.stopListening({
        callId,
        providerCallId: call.providerCallId,
      });

      return { success: true, transcript };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.clearTranscriptWaiter(callId);
    }
  }

  /**
   * End an active call.
   */
  async endCall(callId: CallId): Promise<{ success: boolean; error?: string }> {
    const call = this.activeCalls.get(callId);
    if (!call) {
      return { success: false, error: "Call not found" };
    }

    if (!this.provider || !call.providerCallId) {
      return { success: false, error: "Call not connected" };
    }

    if (TerminalStates.has(call.state)) {
      return { success: true }; // Already ended
    }

    try {
      await this.provider.hangupCall({
        callId,
        providerCallId: call.providerCallId,
        reason: "hangup-bot",
      });

      call.state = "hangup-bot";
      call.endedAt = Date.now();
      call.endReason = "hangup-bot";
      this.persistCallRecord(call);
      this.clearMaxDurationTimer(callId);
      this.rejectTranscriptWaiter(callId, "Call ended: hangup-bot");
      this.activeCalls.delete(callId);
      if (call.providerCallId) {
        this.providerCallIdMap.delete(call.providerCallId);
      }

      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private getContext(): CallManagerContext {
    return {
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      processedEventIds: this.processedEventIds,
      rejectedProviderCallIds: this.rejectedProviderCallIds,
      onCallAnswered: (call) => {
        this.maybeSpeakInitialMessageOnAnswered(call);
      },
      provider: this.provider,
      config: this.config,
      storePath: this.storePath,
      webhookUrl: this.webhookUrl,
      transcriptWaiters: this.transcriptWaiters,
      maxDurationTimers: this.maxDurationTimers,
    };
  }

  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): void {
    processManagerEvent(this.getContext(), event);
  }

  private maybeSpeakInitialMessageOnAnswered(call: CallRecord): void {
    const initialMessage =
      typeof call.metadata?.initialMessage === "string" ? call.metadata.initialMessage.trim() : "";

    if (!initialMessage) {
      return;
    }

    if (!this.provider || !call.providerCallId) {
      return;
    }

    // Twilio has provider-specific state for speaking (<Say> fallback) and can
    // fail for inbound calls; keep existing Twilio behavior unchanged.
    if (this.provider.name === "twilio") {
      return;
    }

    void this.speakInitialMessage(call.providerCallId);
  }

  /**
   * Get an active call by ID.
   */
  getCall(callId: CallId): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  /**
   * Get an active call by provider call ID (e.g., Twilio CallSid).
   */
  getCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    // Fast path: use the providerCallIdMap for O(1) lookup
    const callId = this.providerCallIdMap.get(providerCallId);
    if (callId) {
      return this.activeCalls.get(callId);
    }

    // Fallback: linear search for cases where map wasn't populated
    // (e.g., providerCallId set directly on call record)
    for (const call of this.activeCalls.values()) {
      if (call.providerCallId === providerCallId) {
        return call;
      }
    }
    return undefined;
  }

  /**
   * Get all active calls.
   */
  getActiveCalls(): CallRecord[] {
    return Array.from(this.activeCalls.values());
  }

  /**
   * Get call history (from persisted logs).
   */
  async getCallHistory(limit = 50): Promise<CallRecord[]> {
    const logPath = path.join(this.storePath, "calls.jsonl");

    try {
      await fsp.access(logPath);
    } catch {
      return [];
    }

    const content = await fsp.readFile(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const calls: CallRecord[] = [];

    // Parse last N lines
    for (const line of lines.slice(-limit)) {
      try {
        const parsed = CallRecordSchema.parse(JSON.parse(line));
        calls.push(parsed);
      } catch {
        // Skip invalid lines
      }
    }

    return calls;
  }

  /**
   * Add an entry to the call transcript.
   */
  private addTranscriptEntry(call: CallRecord, speaker: "bot" | "user", text: string): void {
    const entry: TranscriptEntry = {
      timestamp: Date.now(),
      speaker,
      text,
      isFinal: true,
    };
    call.transcript.push(entry);
  }

  /**
   * Persist a call record to disk (fire-and-forget async).
   */
  private persistCallRecord(call: CallRecord): void {
    const logPath = path.join(this.storePath, "calls.jsonl");
    const line = `${JSON.stringify(call)}\n`;
    // Fire-and-forget async write to avoid blocking event loop
    fsp.appendFile(logPath, line).catch((err) => {
      console.error("[voice-call] Failed to persist call record:", err);
    });
  }

  /**
   * Load active calls from persistence (for crash recovery).
   * Uses streaming to handle large log files efficiently.
   */
  private loadActiveCalls(): void {
    const logPath = path.join(this.storePath, "calls.jsonl");
    if (!fs.existsSync(logPath)) {
      return;
    }

    // Read file synchronously and parse lines
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n");

    // Build map of latest state per call
    const callMap = new Map<CallId, CallRecord>();

    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const call = CallRecordSchema.parse(JSON.parse(line));
        callMap.set(call.callId, call);
      } catch {
        // Skip invalid lines
      }
    }

    // Only keep non-terminal calls
    for (const [callId, call] of callMap) {
      if (!TerminalStates.has(call.state)) {
        this.activeCalls.set(callId, call);
        // Populate providerCallId mapping for lookups
        if (call.providerCallId) {
          this.providerCallIdMap.set(call.providerCallId, callId);
        }
        // Populate processed event IDs
        for (const eventId of call.processedEventIds) {
          this.processedEventIds.add(eventId);
        }
      }
    }
  }

  /**
   * Generate TwiML for notify mode (speak message and hang up).
   */
  private generateNotifyTwiml(message: string, voice: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${voice}">${escapeXml(message)}</Say>
  <Hangup/>
</Response>`;
  }
}
