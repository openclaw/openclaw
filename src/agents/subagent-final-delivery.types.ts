export type FinalDeliveryError = {
  message: string;
  retryability: "transient" | "permanent" | "unknown";
  path: "queued" | "steered" | "direct" | "none";
};

export type FinalDeliveryState =
  | { kind: "not_required" }
  | { kind: "pending"; attemptCount: number; lastError?: FinalDeliveryError }
  | {
      kind: "retrying";
      attemptCount: number;
      nextRetryAt: number;
      lastError?: FinalDeliveryError;
    }
  | { kind: "delivered"; deliveredAt: number }
  | { kind: "terminal_failed"; reason: "permanent-failure"; error: FinalDeliveryError }
  | { kind: "expired"; expiredAt: number; lastError?: FinalDeliveryError };

export type FinalDeliveryTerminalReason = "permanent-failure" | "expiry";
