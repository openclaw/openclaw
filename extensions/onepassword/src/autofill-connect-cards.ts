import type { AutofillConnectSnapshot } from "../approval-contract.js";
import type { AutofillClock } from "./autofill-poll.js";
import { AutofillError, type RelaySession } from "./autofill-relay.js";

// Pickup failures that end a consent; transient relay or authority errors leave the card pending.
const finalConnectErrors = new Set([
  "connectExpired",
  "pickupUnavailable",
  "invalidRelayResponse",
  "invalidIntegrationKey",
  "connectionMismatch",
  "integrationKeyMissingReconnect",
  "disconnectExistingConnectionFirst",
]);

/**
 * Memory-only state for connect cards started in chat. The service owns relay sessions;
 * this records which chat may view each one, its click, and its short-lived outcome.
 */
export class AutofillConnectCards {
  private readonly cards = new Map<string, { scope: string; at: number; openedAt?: number }>();
  private readonly outcomes = new Map<
    string,
    { scope: string; state: "connected" | "failed"; code?: string }
  >();

  private readonly inFlight = new Map<string, number>();

  constructor(private readonly clock: Pick<AutofillClock, "now">) {}

  /** Surface a stopped checker rather than advertising active polling indefinitely. */
  stopped(sessionId: string): void {
    this.settle(sessionId, "failed", "connectCheckStopped");
  }

  /** CLI consents are never tracked, so no chat card can show them. */
  track(sessionId: string, scope: string): void {
    this.prune();
    if (this.cards.size >= 64) {
      const oldest = this.cards.keys().next().value!;
      this.cards.delete(oldest);
      this.outcomes.delete(oldest);
    }
    this.cards.set(sessionId, { scope, at: this.clock.now() });
  }

  /** Every chat pickup goes through here so the card learns the outcome, whoever picked up. */
  async pickup<T extends { state: string }>(sessionId: string, run: () => Promise<T>): Promise<T> {
    this.inFlight.set(sessionId, (this.inFlight.get(sessionId) ?? 0) + 1);
    try {
      const result = await run();
      if (result.state === "connected" || result.state === "failed") {
        this.settle(sessionId, result.state);
      }
      return result;
    } catch (error) {
      this.fail(sessionId, error);
      throw error;
    } finally {
      const remaining = (this.inFlight.get(sessionId) ?? 1) - 1;
      if (remaining > 0) {
        this.inFlight.set(sessionId, remaining);
      } else {
        this.inFlight.delete(sessionId);
      }
    }
  }

  /** Definitive outcomes win; a stopped checker can still be resolved by explicit pickup. */
  private settle(sessionId: string, state: "connected" | "failed", code?: string): void {
    const card = this.cards.get(sessionId);
    const previous = this.outcomes.get(sessionId);
    if (card && (!previous || previous.code === "connectCheckStopped")) {
      this.outcomes.set(sessionId, { scope: card.scope, state, code });
    }
  }

  /** Record only failures that end the consent. */
  private fail(sessionId: string, error: unknown): void {
    if (error instanceof AutofillError && finalConnectErrors.has(error.code)) {
      this.settle(sessionId, "failed", error.code);
    }
  }

  /** Record the card click once; true only for the click that should start a checker. */
  opened(sessionId: string, scope: string): boolean {
    const card = this.cards.get(sessionId);
    if (!card || card.scope !== scope || card.openedAt !== undefined) {
      return false;
    }
    card.openedAt = this.clock.now();
    return true;
  }

  /** Project the service's live consent (undefined once retired) for the chat that started it. */
  snapshot(
    sessionId: string,
    scope: string,
    session: RelaySession | undefined,
  ): AutofillConnectSnapshot {
    this.prune();
    const card = this.cards.get(sessionId);
    if (card?.scope !== scope) {
      return { state: "unavailable" };
    }
    const outcome = this.outcomes.get(sessionId);
    if (outcome) {
      return { state: outcome.state, ...(outcome.code ? { code: outcome.code } : {}) };
    }
    if (!session) {
      return { state: "unavailable" };
    }
    const expiresAt = Date.parse(session.expiresAt);
    if (expiresAt <= this.clock.now() && !this.inFlight.has(sessionId)) {
      return { state: "expired" };
    }
    return {
      state: "pending",
      connectUrl: session.connectUrl,
      confirmationCode: session.confirmationCode,
      expiresAt,
      ...(card.openedAt !== undefined ? { openedAt: card.openedAt } : {}),
    };
  }

  /** Cards outlive their ten-minute consent briefly so a finished card still reads its outcome. */
  prune(): void {
    for (const [id, card] of this.cards) {
      if (card.at + 1_200_000 <= this.clock.now()) {
        this.cards.delete(id);
        this.outcomes.delete(id);
      }
    }
  }

  clear(): void {
    this.cards.clear();
    this.outcomes.clear();
  }
}
