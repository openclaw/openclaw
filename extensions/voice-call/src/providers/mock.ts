import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
  ProviderWebhookParseResult,
  WebhookParseOptions,
} from "../types.js";
import type { VoiceCallProvider } from "./base.js";

export class MockProvider implements VoiceCallProvider {
  readonly name = "mock";

  verifyWebhook(_ctx: WebhookContext): WebhookVerificationResult {
    return { ok: true };
  }

  parseWebhookEvent(_ctx: WebhookContext, _options?: WebhookParseOptions): ProviderWebhookParseResult {
    return { events: [] };
  }

  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    return { providerCallId: input.callId, status: "initiated" };
  }

  async getCallStatus(_input: GetCallStatusInput): Promise<GetCallStatusResult> {
    return { status: "completed", isTerminal: true };
  }

  async hangupCall(_input: HangupCallInput): Promise<void> {
    // No-op for mock
  }

  async playTts(_input: PlayTtsInput): Promise<void> {
    // No-op for mock
  }

  async startListening(_input: StartListeningInput): Promise<void> {
    // No-op for mock
  }

  async stopListening(_input: StopListeningInput): Promise<void> {
    // No-op for mock
  }
}
