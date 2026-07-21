// Voice Call plugin module owns caller speech and generated-response ordering.
import type { CallId } from "../types.js";

export class CallerTurnState {
  private readonly callerActiveCalls = new Set<CallId>();
  private readonly responseGenerationTokens = new Map<CallId, symbol>();

  constructor(private readonly isCallActive: (callId: CallId) => boolean) {}

  beginSpeech(callId: CallId): boolean {
    if (!this.isCallActive(callId) || this.callerActiveCalls.has(callId)) {
      return false;
    }
    this.callerActiveCalls.add(callId);
    this.responseGenerationTokens.delete(callId);
    return true;
  }

  endSpeech(callId: CallId): void {
    this.callerActiveCalls.delete(callId);
  }

  isSpeaking(callId: CallId): boolean {
    return this.callerActiveCalls.has(callId);
  }

  beginResponse(callId: CallId): symbol {
    const token = Symbol(callId);
    this.responseGenerationTokens.set(callId, token);
    return token;
  }

  isResponseCurrent(callId: CallId, token: symbol): boolean {
    return (
      this.isCallActive(callId) &&
      !this.isSpeaking(callId) &&
      this.responseGenerationTokens.get(callId) === token
    );
  }

  finishResponse(callId: CallId, token: symbol): void {
    if (this.responseGenerationTokens.get(callId) === token) {
      this.responseGenerationTokens.delete(callId);
    }
  }

  clear(callId: CallId): void {
    this.callerActiveCalls.delete(callId);
    this.responseGenerationTokens.delete(callId);
  }
}
