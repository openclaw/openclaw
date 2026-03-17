import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processEvent as processManagerEvent } from "./manager/events.js";
import { getCallByProviderCallId as getCallByProviderCallIdFromMaps } from "./manager/lookup.js";
import {
  continueCall as continueCallWithContext,
  endCall as endCallWithContext,
  initiateCall as initiateCallWithContext,
  speak as speakWithContext,
  speakInitialMessage as speakInitialMessageWithContext
} from "./manager/outbound.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./manager/store.js";
import { startMaxDurationTimer } from "./manager/timers.js";
import {
  TerminalStates
} from "./types.js";
import { resolveUserPath } from "./utils.js";
function resolveDefaultStoreBase(config, storePath) {
  const rawOverride = storePath?.trim() || config.store?.trim();
  if (rawOverride) {
    return resolveUserPath(rawOverride);
  }
  const preferred = path.join(os.homedir(), ".openclaw", "voice-calls");
  const candidates = [preferred].map((dir) => resolveUserPath(dir));
  const existing = candidates.find((dir) => {
    try {
      return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
    } catch {
      return false;
    }
  }) ?? resolveUserPath(preferred);
  return existing;
}
class CallManager {
  constructor(config, storePath) {
    this.activeCalls = /* @__PURE__ */ new Map();
    this.providerCallIdMap = /* @__PURE__ */ new Map();
    this.processedEventIds = /* @__PURE__ */ new Set();
    this.rejectedProviderCallIds = /* @__PURE__ */ new Set();
    this.provider = null;
    this.webhookUrl = null;
    this.activeTurnCalls = /* @__PURE__ */ new Set();
    this.transcriptWaiters = /* @__PURE__ */ new Map();
    this.maxDurationTimers = /* @__PURE__ */ new Map();
    this.config = config;
    this.storePath = resolveDefaultStoreBase(config, storePath);
  }
  /**
   * Initialize the call manager with a provider.
   * Verifies persisted calls with the provider and restarts timers.
   */
  async initialize(provider, webhookUrl) {
    this.provider = provider;
    this.webhookUrl = webhookUrl;
    fs.mkdirSync(this.storePath, { recursive: true });
    const persisted = loadActiveCallsFromStore(this.storePath);
    this.processedEventIds = persisted.processedEventIds;
    this.rejectedProviderCallIds = persisted.rejectedProviderCallIds;
    const verified = await this.verifyRestoredCalls(provider, persisted.activeCalls);
    this.activeCalls = verified;
    this.providerCallIdMap = /* @__PURE__ */ new Map();
    for (const [callId, call] of verified) {
      if (call.providerCallId) {
        this.providerCallIdMap.set(call.providerCallId, callId);
      }
    }
    for (const [callId, call] of verified) {
      if (call.answeredAt && !TerminalStates.has(call.state)) {
        const elapsed = Date.now() - call.answeredAt;
        const maxDurationMs = this.config.maxDurationSeconds * 1e3;
        if (elapsed >= maxDurationMs) {
          verified.delete(callId);
          if (call.providerCallId) {
            this.providerCallIdMap.delete(call.providerCallId);
          }
          console.log(
            `[voice-call] Skipping restored call ${callId} (max duration already elapsed)`
          );
          continue;
        }
        startMaxDurationTimer({
          ctx: this.getContext(),
          callId,
          onTimeout: async (id) => {
            await endCallWithContext(this.getContext(), id);
          }
        });
        console.log(`[voice-call] Restarted max-duration timer for restored call ${callId}`);
      }
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
  async verifyRestoredCalls(provider, candidates) {
    if (candidates.size === 0) {
      return /* @__PURE__ */ new Map();
    }
    const maxAgeMs = this.config.maxDurationSeconds * 1e3;
    const now = Date.now();
    const verified = /* @__PURE__ */ new Map();
    const verifyTasks = [];
    for (const [callId, call] of candidates) {
      if (!call.providerCallId) {
        console.log(`[voice-call] Skipping restored call ${callId} (no providerCallId)`);
        continue;
      }
      if (now - call.startedAt > maxAgeMs) {
        console.log(
          `[voice-call] Skipping restored call ${callId} (older than maxDurationSeconds)`
        );
        continue;
      }
      const task = {
        callId,
        call,
        promise: provider.getCallStatus({ providerCallId: call.providerCallId }).then((result) => {
          if (result.isTerminal) {
            console.log(
              `[voice-call] Skipping restored call ${callId} (provider status: ${result.status})`
            );
          } else if (result.isUnknown) {
            console.log(
              `[voice-call] Keeping restored call ${callId} (provider status unknown, relying on timer)`
            );
            verified.set(callId, call);
          } else {
            verified.set(callId, call);
          }
        }).catch(() => {
          console.log(
            `[voice-call] Keeping restored call ${callId} (verification failed, relying on timer)`
          );
          verified.set(callId, call);
        })
      };
      verifyTasks.push(task);
    }
    await Promise.allSettled(verifyTasks.map((t) => t.promise));
    return verified;
  }
  /**
   * Get the current provider.
   */
  getProvider() {
    return this.provider;
  }
  /**
   * Initiate an outbound call.
   */
  async initiateCall(to, sessionKey, options) {
    return initiateCallWithContext(this.getContext(), to, sessionKey, options);
  }
  /**
   * Speak to user in an active call.
   */
  async speak(callId, text) {
    return speakWithContext(this.getContext(), callId, text);
  }
  /**
   * Speak the initial message for a call (called when media stream connects).
   */
  async speakInitialMessage(providerCallId) {
    return speakInitialMessageWithContext(this.getContext(), providerCallId);
  }
  /**
   * Continue call: speak prompt, then wait for user's final transcript.
   */
  async continueCall(callId, prompt) {
    return continueCallWithContext(this.getContext(), callId, prompt);
  }
  /**
   * End an active call.
   */
  async endCall(callId) {
    return endCallWithContext(this.getContext(), callId);
  }
  getContext() {
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
      }
    };
  }
  /**
   * Process a webhook event.
   */
  processEvent(event) {
    processManagerEvent(this.getContext(), event);
  }
  maybeSpeakInitialMessageOnAnswered(call) {
    const initialMessage = typeof call.metadata?.initialMessage === "string" ? call.metadata.initialMessage.trim() : "";
    if (!initialMessage) {
      return;
    }
    if (!this.provider || !call.providerCallId) {
      return;
    }
    void this.speakInitialMessage(call.providerCallId);
  }
  /**
   * Get an active call by ID.
   */
  getCall(callId) {
    return this.activeCalls.get(callId);
  }
  /**
   * Get an active call by provider call ID (e.g., Twilio CallSid).
   */
  getCallByProviderCallId(providerCallId) {
    return getCallByProviderCallIdFromMaps({
      activeCalls: this.activeCalls,
      providerCallIdMap: this.providerCallIdMap,
      providerCallId
    });
  }
  /**
   * Get all active calls.
   */
  getActiveCalls() {
    return Array.from(this.activeCalls.values());
  }
  /**
   * Get call history (from persisted logs).
   */
  async getCallHistory(limit = 50) {
    return getCallHistoryFromStore(this.storePath, limit);
  }
}
export {
  CallManager
};
