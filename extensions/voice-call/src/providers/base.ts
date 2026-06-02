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

/** Provider contract consumed by the call manager for webhook, call-control, and media actions. */
export interface VoiceCallProvider {
  /** Stable provider id stored on call records and used for restore-time status checks. */
  readonly name: ProviderName;

  /** Publish the externally reachable webhook base URL after provider construction. */
  setPublicUrl?(url: string): void;

  /**
   * Verifies provider-signed webhook input before any state mutation.
   *
   * Implementations should fail closed for bad credentials/signatures and return
   * skip metadata only for explicit local-dev bypasses.
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult;

  /**
   * Normalizes a provider webhook into manager events plus an optional immediate response.
   *
   * This must not perform provider side effects; manager replay dedupe happens after parsing.
   */
  parseWebhookEvent(ctx: WebhookContext, options?: WebhookParseOptions): ProviderWebhookParseResult;

  /**
   * Consume one-time TwiML for a provider request.
   *
   * Implementations must return the TwiML at most once per provider call so a
   * replayed webhook cannot repeat pre-connect DTMF or notification playback.
   */
  consumeInitialTwiML?: (ctx: WebhookContext) => string | null;

  /** Starts an outbound call and returns the provider call id that future webhooks will use. */
  initiateCall(input: InitiateCallInput): Promise<InitiateCallResult>;

  /**
   * Answer an accepted inbound call when the provider requires an explicit
   * answer command after the initial webhook.
   */
  answerCall?: (input: AnswerCallInput) => Promise<void>;

  /** Ends an active provider call; callers handle duplicate suppression before invoking this. */
  hangupCall(input: HangupCallInput): Promise<void>;

  /** Plays synthesized speech on the active call leg using the provider's best media path. */
  playTts(input: PlayTtsInput): Promise<void>;

  /**
   * Send already-validated DTMF digits to an active call.
   */
  sendDtmf?: (input: SendDtmfInput) => Promise<void>;

  /**
   * Start listening for user speech and echo `turnToken` in final transcript callbacks when provided.
   */
  startListening(input: StartListeningInput): Promise<void>;

  /** Stops provider speech capture while preserving any already-finalized transcript event. */
  stopListening(input: StopListeningInput): Promise<void>;

  /**
   * Reads provider status during restore and reconciliation.
   *
   * Transient lookup failures must return `isUnknown: true`; the manager keeps
   * the call and relies on max-duration timers instead of ending it speculatively.
   */
  getCallStatus(input: GetCallStatusInput): Promise<GetCallStatusResult>;
}
