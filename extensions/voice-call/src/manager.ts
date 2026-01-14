import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveUserPath } from "./utils.js";
import type { VoiceCallConfig } from "./config.js";
import type { VoiceCallProvider } from "./providers/base.js";
import {
  type CallId,
  type CallRecord,
  type NormalizedEvent,
  type OutboundCallOptions,
} from "./types.js";
import type { CallManagerContext } from "./manager/context.js";
import { processEvent } from "./manager/events.js";
import { getCallByProviderCallId } from "./manager/lookup.js";
import {
  continueCall,
  endCall,
  initiateCall,
  speak,
  speakInitialMessage,
} from "./manager/outbound.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./manager/store.js";

/**
 * Manages voice calls: state machine, persistence, and provider coordination.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private providerCallIdMap = new Map<string, CallId>(); // providerCallId -> internal callId
  private processedEventIds = new Set<string>();
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
    const rawPath =
      storePath ||
      config.store ||
      path.join(os.homedir(), "clawd", "voice-calls");
    this.storePath = resolveUserPath(rawPath);
  }

  private buildContext(): CallManagerContext {
    return {
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      processedEventIds: this.processedEventIds,
      provider: this.provider,
      config: this.config,
      storePath: this.storePath,
      webhookUrl: this.webhookUrl,
      transcriptWaiters: this.transcriptWaiters,
      maxDurationTimers: this.maxDurationTimers,
    };
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
    const restored = loadActiveCallsFromStore(this.storePath);
    this.activeCalls = restored.activeCalls;
    this.providerCallIdMap = restored.providerCallIdMap;
    this.processedEventIds = restored.processedEventIds;
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
    return await initiateCall(this.buildContext(), to, sessionKey, options);
  }

  /**
   * Speak to user in an active call.
   */
  async speak(
    callId: CallId,
    text: string,
  ): Promise<{ success: boolean; error?: string }> {
    return await speak(this.buildContext(), callId, text);
  }

  /**
   * Speak the initial message for a call (called when media stream connects).
   * This is used to auto-play the message passed to initiateCall.
   * In notify mode, auto-hangup after the message is delivered.
   */
  async speakInitialMessage(providerCallId: string): Promise<void> {
    await speakInitialMessage(this.buildContext(), providerCallId);
  }

  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string,
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return await continueCall(this.buildContext(), callId, prompt);
  }

  /**
   * End an active call.
   */
  async endCall(callId: CallId): Promise<{ success: boolean; error?: string }> {
    return await endCall(this.buildContext(), callId);
  }

  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): void {
    processEvent(this.buildContext(), event);
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
    return getCallByProviderCallId({
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
    return await getCallHistoryFromStore(this.storePath, limit);
  }
}
