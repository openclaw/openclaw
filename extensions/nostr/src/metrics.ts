type EventMetricName =
  | "event.received"
  | "event.processed"
  | "event.duplicate"
  | "event.rejected.invalid_shape"
  | "event.rejected.wrong_kind"
  | "event.rejected.stale"
  | "event.rejected.future"
  | "event.rejected.rate_limited"
  | "event.rejected.invalid_signature"
  | "event.rejected.oversized_ciphertext"
  | "event.rejected.oversized_plaintext"
  | "event.rejected.decrypt_failed"
  | "event.rejected.self_message";

type RelayMetricName =
  | "relay.connect"
  | "relay.disconnect"
  | "relay.reconnect"
  | "relay.error"
  | "relay.message.event"
  | "relay.message.eose"
  | "relay.message.closed"
  | "relay.message.notice"
  | "relay.message.ok"
  | "relay.message.auth"
  | "relay.circuit_breaker.open"
  | "relay.circuit_breaker.close"
  | "relay.circuit_breaker.half_open";

type RateLimitMetricName = "rate_limit.per_sender" | "rate_limit.global";

type DecryptMetricName = "decrypt.success" | "decrypt.failure";

type MemoryMetricName = "memory.seen_tracker_size" | "memory.rate_limiter_entries";

type MetricName =
  | EventMetricName
  | RelayMetricName
  | RateLimitMetricName
  | DecryptMetricName
  | MemoryMetricName;

export interface MetricEvent {
  name: MetricName;
  /** Metric value (usually 1 for counters, or a measured value) */
  value: number;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  labels?: Record<string, string | number>;
}

type OnMetricCallback = (event: MetricEvent) => void;

export function createMetrics(onMetric?: OnMetricCallback) {
  return {
    emit(name: MetricName, value = 1, labels?: Record<string, string | number>): void {
      onMetric?.({ name, value, timestamp: Date.now(), labels });
    },
  };
}

export type NostrMetrics = ReturnType<typeof createMetrics>;
