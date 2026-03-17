import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
class FakeProvider {
  constructor(name = "plivo") {
    this.playTtsCalls = [];
    this.hangupCalls = [];
    this.startListeningCalls = [];
    this.stopListeningCalls = [];
    this.getCallStatusResult = { status: "in-progress", isTerminal: false };
    this.name = name;
  }
  verifyWebhook(_ctx) {
    return { ok: true };
  }
  parseWebhookEvent(_ctx) {
    return { events: [], statusCode: 200 };
  }
  async initiateCall(_input) {
    return { providerCallId: "request-uuid", status: "initiated" };
  }
  async hangupCall(input) {
    this.hangupCalls.push(input);
  }
  async playTts(input) {
    this.playTtsCalls.push(input);
  }
  async startListening(input) {
    this.startListeningCalls.push(input);
  }
  async stopListening(input) {
    this.stopListeningCalls.push(input);
  }
  async getCallStatus(_input) {
    return this.getCallStatusResult;
  }
}
let storeSeq = 0;
function createTestStorePath() {
  storeSeq += 1;
  return path.join(os.tmpdir(), `openclaw-voice-call-test-${Date.now()}-${storeSeq}`);
}
async function createManagerHarness(configOverrides = {}, provider = new FakeProvider()) {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    ...configOverrides
  });
  const manager = new CallManager(config, createTestStorePath());
  await manager.initialize(provider, "https://example.com/voice/webhook");
  return { manager, provider };
}
function markCallAnswered(manager, callId, eventId) {
  manager.processEvent({
    id: eventId,
    type: "call.answered",
    callId,
    providerCallId: "request-uuid",
    timestamp: Date.now()
  });
}
function writeCallsToStore(storePath, calls) {
  fs.mkdirSync(storePath, { recursive: true });
  const logPath = path.join(storePath, "calls.jsonl");
  const lines = calls.map((c) => JSON.stringify(c)).join("\n") + "\n";
  fs.writeFileSync(logPath, lines);
}
function makePersistedCall(overrides = {}) {
  return {
    callId: `call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    providerCallId: `prov-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    provider: "plivo",
    direction: "outbound",
    state: "answered",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now() - 3e4,
    answeredAt: Date.now() - 25e3,
    transcript: [],
    processedEventIds: [],
    ...overrides
  };
}
export {
  FakeProvider,
  createManagerHarness,
  createTestStorePath,
  makePersistedCall,
  markCallAnswered,
  writeCallsToStore
};
