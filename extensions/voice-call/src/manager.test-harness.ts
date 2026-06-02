import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateSyncKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import { persistCallRecord } from "./manager/store.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { getOptionalVoiceCallStateRuntime, setVoiceCallStateRuntime } from "./runtime-state.js";
import { CallRecordSchema } from "./types.js";
import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "./types.js";

/** In-memory provider double that records call-control side effects for manager tests. */
export class FakeProvider implements VoiceCallProvider {
  readonly name: "plivo" | "twilio" | "telnyx";
  twilioStreamConnectEnabled = true;
  readonly playTtsCalls: PlayTtsInput[] = [];
  readonly hangupCalls: HangupCallInput[] = [];
  readonly startListeningCalls: StartListeningInput[] = [];
  readonly stopListeningCalls: StopListeningInput[] = [];
  getCallStatusResult: GetCallStatusResult = { status: "in-progress", isTerminal: false };

  constructor(name: "plivo" | "twilio" | "telnyx" = "plivo") {
    this.name = name;
  }

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(_ctx: WebhookContext): ProviderWebhookParseResult {
    return { events: [], statusCode: 200 };
  }

  async initiateCall(_input: InitiateCallInput): Promise<InitiateCallResult> {
    return { providerCallId: "request-uuid", status: "initiated" };
  }

  async hangupCall(input: HangupCallInput): Promise<void> {
    this.hangupCalls.push(input);
  }

  async playTts(input: PlayTtsInput): Promise<void> {
    this.playTtsCalls.push(input);
  }

  async startListening(input: StartListeningInput): Promise<void> {
    this.startListeningCalls.push(input);
  }

  async stopListening(input: StopListeningInput): Promise<void> {
    this.stopListeningCalls.push(input);
  }

  async getCallStatus(_input: GetCallStatusInput): Promise<GetCallStatusResult> {
    return this.getCallStatusResult;
  }

  isConversationStreamConnectEnabled(): boolean {
    return this.name === "twilio" && this.twilioStreamConnectEnabled;
  }
}

/** Create an isolated temp directory for voice-call state tests. */
export function createTestStorePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-voice-call-test-"));
}

/** Install the synchronous plugin-state runtime used by voice-call manager tests. */
export function installVoiceCallStateRuntimeForTests(): void {
  if (getOptionalVoiceCallStateRuntime()) {
    return;
  }
  setVoiceCallStateRuntime({
    state: {
      resolveStateDir: () => "",
      openKeyedStore: (() => {
        throw new Error("openKeyedStore is not used by voice-call manager tests");
      }) as never,
      openSyncKeyedStore: (options: OpenKeyedStoreOptions) =>
        createPluginStateSyncKeyedStoreForTests("voice-call", options),
      openChannelIngressQueue: (() => {
        throw new Error("openChannelIngressQueue is not used by voice-call manager tests");
      }) as never,
    },
  });
}

/** Build and initialize a CallManager with an isolated store and fake provider. */
export async function createManagerHarness(
  configOverrides: Record<string, unknown> = {},
  provider = new FakeProvider(),
): Promise<{
  manager: CallManager;
  provider: FakeProvider;
}> {
  const config = VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    ...configOverrides,
  });
  installVoiceCallStateRuntimeForTests();
  const manager = new CallManager(config, createTestStorePath());
  await manager.initialize(provider, "https://example.com/voice/webhook");
  return { manager, provider };
}

/** Drive the manager through a provider answered event for an existing call. */
export function markCallAnswered(manager: CallManager, callId: string, eventId: string): void {
  manager.processEvent({
    id: eventId,
    type: "call.answered",
    callId,
    providerCallId: "request-uuid",
    timestamp: Date.now(),
  });
}

/** Persist canonical call snapshots into the plugin-state store for restore tests. */
export function writeCallsToStore(storePath: string, calls: Record<string, unknown>[]): void {
  fs.mkdirSync(storePath, { recursive: true });
  for (const call of calls) {
    persistCallRecord(storePath, CallRecordSchema.parse(call));
  }
}

/** Write retired JSONL call records for tests that prove runtime ignores legacy logs. */
export function writeLegacyCallsJsonl(storePath: string, calls: Record<string, unknown>[]): void {
  fs.mkdirSync(storePath, { recursive: true });
  const logPath = path.join(storePath, "calls.jsonl");
  const lines = calls.map((c) => JSON.stringify(c)).join("\n") + "\n";
  fs.writeFileSync(logPath, lines);
}

/** Produce a schema-shaped persisted call with override hooks for restore fixtures. */
export function makePersistedCall(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    callId: `call-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    providerCallId: `prov-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    provider: "plivo",
    direction: "outbound",
    state: "answered",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now() - 30_000,
    answeredAt: Date.now() - 25_000,
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}
