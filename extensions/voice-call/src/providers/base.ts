import type {
  GetCallStatusInput,
  GetCallStatusResult,
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  PlayTtsInput,
  ProviderName,
  WebhookParseOptions,
  ProviderWebhookParseResult,
  StartListeningInput,
  StopListeningInput,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";

/**
 * Abstract base interface for voice call providers.
 *
 * Each provider (Telnyx, Twilio, etc.) implements this interface to provide
 * a consistent API for the call manager.
 *
 * Responsibilities:
 * - Webhook verification and event parsing
 * - Outbound call initiation and hangup
 * - Media control (TTS playback, STT listening)
 */
export interface VoiceCallProvider {
  /** Provider identifier */
  readonly name: ProviderName;

  /**
   * Verify webhook signature/HMAC before processing.
   * Must be called before parseWebhookEvent.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  /**
   * Parse provider-specific webhook payload into normalized events.
   * Returns events and optional response to send back to provider.
   */
  parseWebhookEvent(ctx: WebhookContext, options?: WebhookParseOptions): ProviderWebhookParseResult;

  /**
   * Initiate an outbound call.
   * @returns Provider call ID and status
   */
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  /**
   * Hang up an active call.
   */
  hangupCall(input: HangupCallInput): Promise<void>;

  /**
   * Play TTS audio to the caller.
   * The provider should handle streaming if supported.
   */
  playTts(input: PlayTtsInput): Promise<void>;

  /**
   * Start listening for user speech (activate STT).
   */
  startListening(input: StartListeningInput): Promise<void>;

  /**
   * Stop listening for user speech (deactivate STT).
   */
  stopListening(input: StopListeningInput): Promise<void>;

  /**
   * Query provider for current call status.
   * Used to verify persisted calls are still active on restart.
   * Must return `isUnknown: true` for transient errors (network, 5xx)
   * so the caller can keep the call and rely on timer-based fallback.
   */
  getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>;

  /**
   * Answer an inbound call. Required for providers that don't auto-answer
   * via response markup (e.g. Telnyx requires an explicit answer command).
   */
  answerCall?(input: { callId: string; providerCallId: string }): Promise<void>;

  /**
   * Start real-time audio streaming to a WebSocket URL for external STT.
   * Used when streaming mode is enabled (e.g. Deepgram STT instead of native).
   */
  startStreaming?(input: {
    providerCallId: string;
    streamUrl: string;
    clientState?: string;
  }): Promise<void>;

  /**
   * Stop real-time audio streaming.
   */
  stopStreaming?(input: { providerCallId: string }): Promise<void>;

  /**
   * Transfer an active call to another number.
   * Used for [TRANSFER] signal call forwarding on providers that support
   * native call transfer (e.g. Telnyx). Falls back to provider-specific
   * methods (e.g. Twilio TwiML update) when not available.
   */
  transferCall?(input: {
    callId: string;
    providerCallId: string;
    to: string;
    from?: string;
  }): Promise<void>;
}
