import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { VoiceCallConfig } from "./config.js";
import type { CallManagerContext } from "./manager/context.js";
import { processEvent as processManagerEvent } from "./manager/events.js";
import { getCallByProviderCallId as getCallByProviderCallIdFromMaps } from "./manager/lookup.js";
import {
  continueCall as continueCallWithContext,
  endCall as endCallWithContext,
  initiateCall as initiateCallWithContext,
  speak as speakWithContext,
  speakInitialMessage as speakInitialMessageWithContext,
} from "./manager/outbound.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./manager/store.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { CallId, CallRecord, NormalizedEvent, OutboundCallOptions } from "./types.js";
import { resolveUserPath } from "./utils.js";

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
 * Manages voice calls: state ownership and delegation to manager helper modules.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private providerCallIdMap = new Map<string, CallId>();
  private processedEventIds = new Set<string>();
  private rejectedProviderCallIds = new Set<string>();
  private provider: VoiceCallProvider | null = null;
  private config: VoiceCallConfig;
  private storePath: string;
  private webhookUrl: string | null = null;
  private activeTurnCalls = new Set<CallId>();
  private transcriptWaiters = new Map<
    CallId,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private maxDurationTimers = new Map<CallId, NodeJS.Timeout>();

  constructor(config: VoiceCallConfig, storePath?: string) {
    this.config = config;
    this.storePath = resolveDefaultStoreBase(config, storePath);
  }

  /**
   * Initialize the call manager with a provider.
   */
  initialize(provider: VoiceCallProvider, webhookUrl: string): void {
    this.provider = provider;
    this.webhookUrl = webhookUrl;

    fs.mkdirSync(this.storePath, { recursive: true });

    const persisted = loadActiveCallsFromStore(this.storePath);
    this.activeCalls = persisted.activeCalls;
    this.providerCallIdMap = persisted.providerCallIdMap;
    this.processedEventIds = persisted.processedEventIds;
    this.rejectedProviderCallIds = persisted.rejectedProviderCallIds;
  }

  /**
   * Get the current provider.
   */
  getProvider(): VoiceCallProvider | null {
    return this.provider;
  }

  /**
   * Initiate an outbound call.
   */
  async initiateCall(
    to: string,
    sessionKey?: string,
    options?: OutboundCallOptions | string,
  ): Promise<{ callId: CallId; success: boolean; error?: string }> {
    return initiateCallWithContext(this.getContext(), to, sessionKey, options);
  }

  /**
   * Speak to user in an active call.
   */
  async speak(callId: CallId, text: string): Promise<{ success: boolean; error?: string }> {
    return speakWithContext(this.getContext(), callId, text);
  }

  /**
   * Speak the initial message for a call (called when media stream connects).
   */
  async speakInitialMessage(providerCallId: string): Promise<void> {
    return speakInitialMessageWithContext(this.getContext(), providerCallId);
  }

  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string,
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return continueCallWithContext(this.getContext(), callId, prompt);
  }

  /**
   * End an active call.
   */
  async endCall(callId: CallId): Promise<{ success: boolean; error?: string }> {
    return endCallWithContext(this.getContext(), callId);
  }

  private getContext(): CallManagerContext {
    return {
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      processedEventIds: this.processedEventIds,
      rejectedProviderCallIds: this.rejectedProviderCallIds,
      provider: this.provider,
      config: this.config,
      storePath: this.storePath,
      webhookUrl: this.webhookUrl,
      activeTurnCalls: this.activeTurnCalls,
      transcriptWaiters: this.transcriptWaiters,
      maxDurationTimers: this.maxDurationTimers,
      onCallAnswered: (call) => {
        this.maybeSpeakInitialMessageOnAnswered(call);
      },
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
    return getCallByProviderCallIdFromMaps({
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      providerCallId,
    });
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
    return getCallHistoryFromStore(this.storePath, limit);
  }
}
