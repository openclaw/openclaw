/**
 * DESIGN CONTRACT ONLY. There is no issuer, broker, commit implementation,
 * exported constructor, or runnable recovery endpoint in this proposal.
 * TypeScript brands do not provide runtime authority. A future implementation
 * MUST enforce issued identity in a private runtime registry and capture the
 * existing host/native owners; wire data and deserialized records cannot mint it.
 */
declare const authorityBrand: unique symbol;
declare const observationBrand: unique symbol;

export interface ProviderReviewReconciliationAuthority {
  readonly [authorityBrand]: true;
  assertCurrent(): void;
}

export interface NativeThreadReconciliationObservation {
  readonly [observationBrand]: true;
  /** Must fail after revocation, native reload, ownership loss, or policy change. */
  assertCurrent(): void;
  /** Releases only this operation's proven native reservation/subscription. */
  release(): Promise<void>;
}

export type ProviderReviewReconciliationRequest = Readonly<{
  sessionKey: string;
  agentId?: string;
  sessionId: string;
  reviewId: string;
  operationId: string;
  expectedBindingRevision: string;
}>;

/** No client-selected native thread, owner, catalog, policy, or acknowledgment. */
export type ProviderReviewReconciliationResult =
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "conflict"; refreshRequired: true }>
  | Readonly<{ status: "uncertain"; operationId: string; refreshRequired: true }>
  | Readonly<{
      status: "consistent";
      operationId: string;
      bindingRevision: string;
      reviewStillPending: true;
      continuationApproved: false;
    }>;

/**
 * Required OpenClaw-owned broker, NOT implemented here. It must derive the native
 * target from the genuine review under the captured host authority, acquire
 * canonical native ownership and prove the current effective configuration,
 * immutable catalog, authorized executors, and unchanged latest failed turn.
 * If existing native RPC semantics cannot prove those facts, return unavailable;
 * obtain the necessary guarantee from the Codex app-server owner first.
 */
export interface NativeThreadReconciliationBroker {
  prepare(
    authority: ProviderReviewReconciliationAuthority,
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ status: "unavailable"; reason: string }>
    | Readonly<{ status: "prepared"; observation: NativeThreadReconciliationObservation }>
  >;
}

/**
 * Required canonical coordinator, NOT implemented here. Must capture genuine
 * owner/admin + session mutation authority, fence the unchanged review/session,
 * both native identities and the full binding preimage, and use the existing
 * binding owner for commit. It never issues/consumes an acknowledgment capability,
 * edits a review record, or submits any native/model turn.
 */
export interface ProviderReviewReconciliationCoordinator {
  reconcile(
    request: ProviderReviewReconciliationRequest,
    signal: AbortSignal,
  ): Promise<ProviderReviewReconciliationResult>;
}
