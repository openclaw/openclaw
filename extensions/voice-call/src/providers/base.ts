import type {
  AnswerCallInput,
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderName,
  SendDtmfInput,
  WebhookParseOptions,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";

export interface VoiceCallProvider {
  readonly name: ProviderName;

  setPublicUrl?(url: string): void;

  /** Defer conversation greeting/listening until the configured stream connects. */
  isConversationStreamConnectEnabled?(): boolean;

  /**
   * Verify webhook signature/HMAC before processing.
   * Must be called before parseWebhookEvent.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  parseWebhookEvent(ctx: WebhookContext, options?: WebhookParseOptions): ProviderWebhookParseResult;

  /**
   * Consume one-time TwiML that must be served before shortcut handlers such as
   * realtime media streams take over the webhook response.
   */
  consumeInitialTwiML?: (ctx: WebhookContext) => string | null;

  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  /**
   * Answer an accepted inbound call when the provider requires an explicit
   * answer command after the initial webhook.
   */
  answerCall?: (input: AnswerCallInput) => Promise<void>;

  hangupCall(input: HangupCallInput): Promise<void>;

  /**
   * Play TTS audio to the caller.
   * The provider should handle streaming if supported.
   */
  playTts(input: PlayTtsInput): Promise<void>;

  /** Play a message followed by carrier-owned hangup; acceptance is not completion. */
  playMessageAndHangup?(input: PlayTtsInput): Promise<void>;

  /**
   * Send DTMF digits to an active call.
   */
  sendDtmf?: (input: SendDtmfInput) => Promise<void>;

  startListening(input: StartListeningInput): Promise<void>;

  stopListening(input: StopListeningInput): Promise<void>;

  /**
   * Query provider for current call status.
   * Used to verify persisted calls are still active on restart.
   * Must return `isUnknown: true` for transient errors (network, 5xx)
   * so the caller can keep the call and rely on timer-based fallback.
   */
  getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>;
}
