// Voice Call plugin module implements manager behavior.
import fs from "node:fs";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { VoiceCallConfig, VoiceCallCoreSessionConfig } from "./config.js";
import type { CallEndResult, CallManagerContext, StreamSessionIssuer } from "./manager/context.js";
import { processEvent as processManagerEvent, type ProcessEventResult } from "./manager/events.js";
import { getCallByProviderCallId as getCallByProviderCallIdFromMaps } from "./manager/lookup.js";
import {
  continueCall as continueCallWithContext,
  endCall as endCallWithContext,
  initiateCall as initiateCallWithContext,
  sendDtmf as sendDtmfWithContext,
  speak as speakWithContext,
  speakInitialMessage as speakInitialMessageWithContext,
  type SpeakOptions,
} from "./manager/outbound.js";
import {
  findCallInStore,
  getCallHistoryFromStore,
  loadActiveCallsFromStore,
  persistCallRecord,
} from "./manager/store.js";
import { resolveVoiceCallSecondsTimerDelayMs } from "./manager/timer-delays.js";
import { startMaxDurationTimer } from "./manager/timers.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { resolveDefaultVoiceCallStoreDir } from "./store-path.js";
import {
  TerminalStates,
  type CallId,
  type CallRecord,
  type EndReason,
  type NormalizedEvent,
  type OutboundCallOptions,
} from "./types.js";
import { resolveUserPath } from "./utils.js";

function markRestoredCallSkipped(call: CallRecord, endReason: "completed" | "timeout"): void {
  call.endedAt = Date.now();
  call.endReason = endReason;
  call.state = endReason;
}

function incrementRestoreStatusCount(
  counts: Map<string, number>,
  status: string | undefined,
): void {
  const key = normalizeOptionalString(status) ?? "terminal";
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function resolveRestoredMaxDurationAnchor(call: CallRecord): number | undefined {
  return (
    call.answeredAt ??
    (call.state === "speaking" || call.state === "listening" ? call.startedAt : undefined)
  );
}

function resolveDefaultStoreBase(config: VoiceCallConfig, storePath?: string): string {
  const rawOverride = storePath?.trim() || config.store?.trim();
  if (rawOverride) {
    return resolveUserPath(rawOverride);
  }
  return resolveDefaultVoiceCallStoreDir();
}

/**
 * Manages voice calls: state ownership and delegation to manager helper modules.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private providerCallIdMap = new Map<string, CallId>();
  private processedEventIds = new Set<string>();
  private rejectedProviderCallIds = new Map<string, symbol>();
  private provider: VoiceCallProvider | null = null;
  private config: VoiceCallConfig;
  private coreSession: VoiceCallCoreSessionConfig | undefined;
  private storePath: string;
  private webhookUrl: string | null = null;
  private activeTurnCalls = new Set<CallId>();
  private endCallOperations = new Map<CallId, Promise<CallEndResult>>();
  private transcriptWaiters = new Map<
    CallId,
    {
      resolve: (text: string) => void;
      reject: (err: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();
  private maxDurationTimers = new Map<CallId, NodeJS.Timeout>();
  private initialMessageInFlight = new Set<CallId>();
  private autoResponseOwners = new WeakMap<CallRecord, symbol>();
  private readonly mutationQueue = new KeyedAsyncQueue();
  private readonly pendingCallAdmissions = new Set<CallId>();
  private readonly pendingWork = new Set<Promise<unknown>>();
  private readonly notifyHangupTimers = new Map<CallId, NodeJS.Timeout>();
  private initialization: Promise<void> | null = null;
  private closing = false;
  private stopPromise: Promise<void> | null = null;

  private trackCallWork = (work: Promise<unknown>): void => {
    this.pendingWork.add(work);
    const settled = () => this.pendingWork.delete(work);
    void work.then(settled, settled);
  };

  private runOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) {
      return Promise.reject(new Error("Voice Call manager is stopping"));
    }
    const pending = this.initialization
      ? this.initialization.then(() => {
          if (this.closing) {
            throw new Error("Voice Call manager is stopping");
          }
          return operation();
        })
      : operation();
    this.trackCallWork(pending);
    return pending;
  }

  /** Stop is owned by runtime shutdown, after webhook and stream producers have closed. */
  stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.closing = true;
    for (const timers of [this.maxDurationTimers, this.notifyHangupTimers]) {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    }
    for (const waiter of this.transcriptWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Voice Call runtime stopped"));
    }
    this.transcriptWaiters.clear();
    this.stopPromise = (async () => {
      const failures: unknown[] = [];
      while (this.pendingWork.size > 0) {
        const results = await Promise.allSettled(this.pendingWork);
        for (const result of results) {
          if (result.status === "rejected") {
            failures.push(result.reason);
          }
        }
      }
      for (const timers of [this.maxDurationTimers, this.notifyHangupTimers]) {
        for (const timer of timers.values()) {
          clearTimeout(timer);
        }
        timers.clear();
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, "Voice Call work failed during shutdown");
      }
    })();
    return this.stopPromise;
  }

  /** Serialize transient metadata with persisted updates without adding event-store writes. */
  updateCallMetadata(
    call: CallRecord,
    update: (metadata: CallRecord["metadata"]) => CallRecord["metadata"],
  ): Promise<void> {
    return this.runOperation(() =>
      this.mutationQueue.enqueue("state", async () => {
        if (this.activeCalls.get(call.callId) === call && !TerminalStates.has(call.state)) {
          call.metadata = update(call.metadata ? { ...call.metadata } : undefined);
        }
      }),
    );
  }

  /**
   * Carrier-side stream session issuer. Wired by the runtime when realtime is
   * enabled so the manager can pre-issue stream URLs for providers (e.g.
   * Telnyx) that attach Media Streaming at dial or answer time.
   */
  streamSessionIssuer: StreamSessionIssuer | undefined;

  constructor(
    config: VoiceCallConfig,
    storePath?: string,
    coreSession?: VoiceCallCoreSessionConfig,
  ) {
    this.config = config;
    this.coreSession = coreSession;
    this.storePath = resolveDefaultStoreBase(config, storePath);
  }

  /**
   * Initialize the call manager with a provider.
   * Verifies persisted calls with the provider and restarts timers.
   */
  initialize(provider: VoiceCallProvider, webhookUrl: string): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error("Voice Call manager is stopping"));
    }
    const pending = this.initializeFromStore(provider, webhookUrl);
    this.initialization = pending;
    this.trackCallWork(pending);
    void pending.then(
      () => {
        if (this.initialization === pending) {
          this.initialization = null;
        }
      },
      () => {},
    );
    return pending;
  }

  private async initializeFromStore(
    provider: VoiceCallProvider,
    webhookUrl: string,
  ): Promise<void> {
    this.provider = provider;
    this.webhookUrl = webhookUrl;

    fs.mkdirSync(this.storePath, { recursive: true });

    const persisted = await loadActiveCallsFromStore(this.storePath);
    if (this.closing) {
      return;
    }
    this.processedEventIds = persisted.processedEventIds;
    this.rejectedProviderCallIds = new Map();

    const verified = await this.verifyRestoredCalls(provider, persisted.activeCalls);
    if (this.closing) {
      return;
    }
    const timers: Array<{ callId: CallId; deadline: number }> = [];
    let skippedAlreadyElapsedTimers = 0;
    for (const [callId, call] of verified) {
      const maxDurationAnchor = resolveRestoredMaxDurationAnchor(call);
      if (maxDurationAnchor !== undefined && !TerminalStates.has(call.state)) {
        const elapsed = Date.now() - maxDurationAnchor;
        const maxDurationMs = resolveVoiceCallSecondsTimerDelayMs(this.config.maxDurationSeconds);
        if (elapsed >= maxDurationMs) {
          // Already expired — remove instead of keeping
          verified.delete(callId);
          skippedAlreadyElapsedTimers += 1;
          continue;
        }
        if (call.answeredAt === undefined) {
          // Twilio streams can restore directly in speaking/listening without an
          // answered webhook; anchoring at startedAt preserves bounded duration.
          call.answeredAt = maxDurationAnchor;
          await persistCallRecord(this.storePath, call);
        }
        if (this.closing) {
          return;
        }
        timers.push({ callId, deadline: maxDurationAnchor + maxDurationMs });
      }
    }
    // Publish one restored view after every required write has completed.
    this.activeCalls = verified;
    this.providerCallIdMap = new Map();
    for (const [callId, call] of verified) {
      if (call.providerCallId) {
        this.providerCallIdMap.set(call.providerCallId, callId);
      }
    }
    for (const { callId, deadline } of timers) {
      startMaxDurationTimer({
        ctx: this.getContext(),
        callId,
        timeoutMs: Math.max(0, deadline - Date.now()),
        onTimeout: (id) => this.endCall(id, { reason: "timeout" }),
      });
      console.log(`[voice-call] Restarted max-duration timer for restored call ${callId}`);
    }
    if (skippedAlreadyElapsedTimers > 0) {
      console.log(
        `[voice-call] Skipped ${skippedAlreadyElapsedTimers} restored call(s) whose max-duration timer already elapsed`,
      );
    }

    if (verified.size > 0) {
      console.log(`[voice-call] Restored ${verified.size} active call(s) from store`);
    }
  }

  /**
   * Verify persisted calls with the provider before restoring.
   * Calls without providerCallId or older than maxDurationSeconds are skipped.
   * Transient provider errors keep the call (rely on timer fallback).
   */
  private async verifyRestoredCalls(
    provider: VoiceCallProvider,
    candidates: Map<CallId, CallRecord>,
  ): Promise<Map<CallId, CallRecord>> {
    if (candidates.size === 0) {
      return new Map();
    }

    const maxAgeMs = resolveVoiceCallSecondsTimerDelayMs(this.config.maxDurationSeconds);
    const now = Date.now();
    const verified = new Map<CallId, CallRecord>();
    const verifyTasks: Promise<void>[] = [];
    let skippedNoProviderCallId = 0;
    let skippedOlderThanMaxDuration = 0;
    const skippedTerminalStatuses = new Map<string, number>();
    let keptVerifiedActive = 0;
    let keptUnknownProviderStatus = 0;
    let keptVerificationFailures = 0;

    let admissionFailure: { error: unknown } | undefined;
    try {
      for (const [callId, call] of candidates) {
        if (this.closing) {
          break;
        }
        // Skip calls without a provider ID — can't verify
        if (!call.providerCallId) {
          skippedNoProviderCallId += 1;
          continue;
        }

        // Skip calls older than maxDurationSeconds (time-based fallback)
        if (now - call.startedAt > maxAgeMs) {
          skippedOlderThanMaxDuration += 1;
          markRestoredCallSkipped(call, "timeout");
          await persistCallRecord(this.storePath, call);
          if (this.closing) {
            break;
          }
          await provider
            .hangupCall({
              callId,
              providerCallId: call.providerCallId,
              reason: "timeout",
            })
            .catch((err: unknown) => {
              console.warn(
                `[voice-call] Failed to hang up expired restored call ${callId}:`,
                err instanceof Error ? err.message : String(err),
              );
            });
          continue;
        }

        const task = provider.getCallStatus({ providerCallId: call.providerCallId }).then(
          async (result) => {
            if (result.isTerminal) {
              incrementRestoreStatusCount(skippedTerminalStatuses, result.status);
              markRestoredCallSkipped(call, "completed");
              await persistCallRecord(this.storePath, call);
            } else if (result.isUnknown) {
              keptUnknownProviderStatus += 1;
              verified.set(callId, call);
            } else {
              keptVerifiedActive += 1;
              verified.set(callId, call);
            }
          },
          () => {
            // A failed provider check keeps the call; failed persistence still rejects restore.
            keptVerificationFailures += 1;
            verified.set(callId, call);
          },
        );
        // Later calls can await carrier work before the final drain observes this task.
        void task.catch(() => {});
        verifyTasks.push(task);
      }
    } catch (error) {
      admissionFailure = { error };
    }
    const outcomes = await Promise.allSettled(verifyTasks);
    if (admissionFailure) {
      throw admissionFailure.error;
    }
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        throw outcome.reason;
      }
    }
    if (skippedNoProviderCallId > 0) {
      console.log(
        `[voice-call] Skipped ${skippedNoProviderCallId} restored call(s) with no providerCallId`,
      );
    }
    if (skippedOlderThanMaxDuration > 0) {
      console.log(
        `[voice-call] Skipped ${skippedOlderThanMaxDuration} restored call(s) older than maxDurationSeconds`,
      );
    }
    for (const [status, count] of [...skippedTerminalStatuses].toSorted(([a], [b]) =>
      a.localeCompare(b),
    )) {
      console.log(`[voice-call] Skipped ${count} restored call(s) with provider status: ${status}`);
    }
    if (keptVerifiedActive > 0) {
      console.log(
        `[voice-call] Kept ${keptVerifiedActive} restored call(s) confirmed active by provider`,
      );
    }
    if (keptUnknownProviderStatus > 0) {
      console.log(
        `[voice-call] Kept ${keptUnknownProviderStatus} restored call(s) with unknown provider status (relying on timer)`,
      );
    }
    if (keptVerificationFailures > 0) {
      console.log(
        `[voice-call] Kept ${keptVerificationFailures} restored call(s) after verification failure (relying on timer)`,
      );
    }
    return verified;
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
    return this.runOperation(() =>
      initiateCallWithContext(this.getContext(), to, sessionKey, options),
    );
  }

  /**
   * Speak to user in an active call.
   */
  async speak(
    callId: CallId,
    text: string,
    options?: SpeakOptions,
  ): Promise<{ success: boolean; error?: string }> {
    return this.runOperation(() => speakWithContext(this.getContext(), callId, text, options));
  }

  /**
   * Send DTMF digits to an active call.
   */
  async sendDtmf(callId: CallId, digits: string): Promise<{ success: boolean; error?: string }> {
    return this.runOperation(() => sendDtmfWithContext(this.getContext(), callId, digits));
  }

  /**
   * Speak the initial message for a call (called when media stream connects).
   */
  async speakInitialMessage(providerCallId: string): Promise<void> {
    return this.runOperation(() =>
      speakInitialMessageWithContext(this.getContext(), providerCallId),
    );
  }

  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string,
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    return this.runOperation(() => continueCallWithContext(this.getContext(), callId, prompt));
  }

  /**
   * End an active call.
   */
  endCall(callId: CallId, options?: { reason?: EndReason }): Promise<CallEndResult> {
    return this.runOperation(() => endCallWithContext(this.getContext(), callId, options));
  }

  private getContext(): CallManagerContext {
    return {
      mutationQueue: this.mutationQueue,
      pendingCallAdmissions: this.pendingCallAdmissions,
      trackCallWork: this.trackCallWork,
      isStopping: () => this.closing,
      notifyHangupTimers: this.notifyHangupTimers,
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      processedEventIds: this.processedEventIds,
      rejectedProviderCallIds: this.rejectedProviderCallIds,
      provider: this.provider,
      config: this.config,
      coreSession: this.coreSession,
      storePath: this.storePath,
      webhookUrl: this.webhookUrl,
      activeTurnCalls: this.activeTurnCalls,
      endCallOperations: this.endCallOperations,
      transcriptWaiters: this.transcriptWaiters,
      maxDurationTimers: this.maxDurationTimers,
      initialMessageInFlight: this.initialMessageInFlight,
      onCallerSpeech: (call) => this.invalidateAutoResponse(call),
      onCallAnswered: (call) => {
        this.maybeSpeakInitialMessageOnAnswered(call);
      },
      streamSessionIssuer: this.streamSessionIssuer,
    };
  }

  /**
   * Process a webhook event.
   */
  processEvent(event: NormalizedEvent): Promise<ProcessEventResult> {
    return this.runOperation(() => processManagerEvent(this.getContext(), event));
  }

  createAutoResponseGuard(call: CallRecord): { isCurrent: () => boolean; release: () => void } {
    // Call identity fences restored/replaced records; generation identity fences
    // newer speech without cancelling agent work that was already accepted.
    const owner = Symbol("automatic response");
    this.autoResponseOwners.set(call, owner);
    return {
      isCurrent: () =>
        !this.closing &&
        this.activeCalls.get(call.callId) === call &&
        !TerminalStates.has(call.state) &&
        this.autoResponseOwners.get(call) === owner,
      release: () => {
        if (this.autoResponseOwners.get(call) === owner) {
          this.autoResponseOwners.delete(call);
        }
      },
    };
  }

  invalidateAutoResponse(call: CallRecord): void {
    this.autoResponseOwners.delete(call);
  }

  private shouldDeferConversationInitialMessageUntilStreamConnect(): boolean {
    if (!this.provider || this.provider.name !== "twilio" || !this.config.streaming.enabled) {
      return false;
    }

    const streamAwareProvider = this.provider as VoiceCallProvider & {
      isConversationStreamConnectEnabled?: () => boolean;
    };
    if (typeof streamAwareProvider.isConversationStreamConnectEnabled !== "function") {
      return false;
    }

    return streamAwareProvider.isConversationStreamConnectEnabled();
  }

  private maybeSpeakInitialMessageOnAnswered(call: CallRecord): void {
    const initialMessage = normalizeOptionalString(call.metadata?.initialMessage) ?? "";

    if (!initialMessage) {
      return;
    }

    // Notify mode should speak as soon as the provider reports "answered".
    // Conversation mode should defer only when the Twilio stream-connect path
    // is actually available; otherwise speak immediately on answered.
    const mode = (call.metadata?.mode as string | undefined) ?? "conversation";
    if (mode === "conversation") {
      if (this.config.realtime.enabled) {
        return;
      }
      const shouldWaitForStreamConnect =
        this.shouldDeferConversationInitialMessageUntilStreamConnect();
      if (shouldWaitForStreamConnect) {
        return;
      }
    } else if (mode !== "notify") {
      return;
    }

    if (!this.provider || !call.providerCallId) {
      return;
    }

    void this.speakInitialMessage(call.providerCallId).catch((err: unknown) => {
      console.warn(
        `[voice-call] Failed to speak initial message for call ${call.callId}: ${formatErrorMessage(err)}`,
      );
    });
  }

  /**
   * Get an active call by ID.
   */
  getCall(callId: CallId): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  /** Await admitted identity updates before resolving a token-bound stream's active call. */
  getCallForStream(callId: CallId): Promise<CallRecord | undefined> {
    return this.runOperation(() =>
      this.mutationQueue.enqueue("state", async () =>
        this.closing ? undefined : this.activeCalls.get(callId),
      ),
    );
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

  /** Resolve a status record from active state or the retained event store. */
  async getCallFromMemoryOrStore(callId: CallId): Promise<CallRecord | undefined> {
    const active = this.getCall(callId) ?? this.getCallByProviderCallId(callId);
    if (active) {
      return active;
    }
    return this.runOperation(() => findCallInStore(this.storePath, callId));
  }

  /**
   * Get call history (from persisted logs).
   */
  async getCallHistory(limit = 50): Promise<CallRecord[]> {
    return this.runOperation(() => getCallHistoryFromStore(this.storePath, limit));
  }
}
