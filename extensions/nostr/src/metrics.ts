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

type RelayMetrics = {
  connects: number;
  disconnects: number;
  reconnects: number;
  errors: number;
  messagesReceived: {
    event: number;
    eose: number;
    closed: number;
    notice: number;
    ok: number;
    auth: number;
  };
  circuitBreakerState: "closed" | "open" | "half_open";
  circuitBreakerOpens: number;
  circuitBreakerCloses: number;
};

export interface MetricEvent {
  /** Metric name (e.g., "event.received", "relay.connect") */
  name: MetricName;
  /** Metric value (usually 1 for counters, or a measured value) */
  value: number;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Optional labels for additional context */
  labels?: Record<string, string | number>;
}

type OnMetricCallback = (event: MetricEvent) => void;

function createZeroMetricsState() {
  return {
    eventsReceived: 0,
    eventsProcessed: 0,
    eventsDuplicate: 0,
    eventsRejected: {
      invalidShape: 0,
      wrongKind: 0,
      stale: 0,
      future: 0,
      rateLimited: 0,
      invalidSignature: 0,
      oversizedCiphertext: 0,
      oversizedPlaintext: 0,
      decryptFailed: 0,
      selfMessage: 0,
    },
    relays: new Map<string, RelayMetrics>(),
    rateLimiting: { perSenderHits: 0, globalHits: 0 },
    decrypt: { success: 0, failure: 0 },
    memory: { seenTrackerSize: 0, rateLimiterEntries: 0 },
  };
}

type MetricsState = ReturnType<typeof createZeroMetricsState>;

function createMetricsSnapshot(state: MetricsState, snapshotAt?: number) {
  const relays: Record<string, RelayMetrics> = {};
  for (const [url, stats] of state.relays) {
    relays[url] = { ...stats, messagesReceived: { ...stats.messagesReceived } };
  }

  return {
    ...state,
    eventsRejected: { ...state.eventsRejected },
    relays,
    rateLimiting: { ...state.rateLimiting },
    decrypt: { ...state.decrypt },
    memory: { ...state.memory },
    snapshotAt: snapshotAt ?? Date.now(),
  };
}

/**
 * Create a metrics collector instance.
 * Optionally pass an onMetric callback to receive real-time metric events.
 */
export function createMetrics(onMetric?: OnMetricCallback) {
  let state = createZeroMetricsState();

  function getOrCreateRelay(url: string) {
    let relay = state.relays.get(url);
    if (!relay) {
      relay = {
        connects: 0,
        disconnects: 0,
        reconnects: 0,
        errors: 0,
        messagesReceived: {
          event: 0,
          eose: 0,
          closed: 0,
          notice: 0,
          ok: 0,
          auth: 0,
        },
        circuitBreakerState: "closed",
        circuitBreakerOpens: 0,
        circuitBreakerCloses: 0,
      };
      state.relays.set(url, relay);
    }
    return relay;
  }

  const relayMetric =
    (update: (relay: RelayMetrics, value: number) => void) =>
    (value: number, relayUrl?: string): void => {
      if (relayUrl) {
        update(getOrCreateRelay(relayUrl), value);
      }
    };
  const updates = new Map<MetricName, (value: number, relayUrl?: string) => void>([
    ["event.received", (value) => (state.eventsReceived += value)],
    ["event.processed", (value) => (state.eventsProcessed += value)],
    ["event.duplicate", (value) => (state.eventsDuplicate += value)],
    ["event.rejected.invalid_shape", (value) => (state.eventsRejected.invalidShape += value)],
    ["event.rejected.wrong_kind", (value) => (state.eventsRejected.wrongKind += value)],
    ["event.rejected.stale", (value) => (state.eventsRejected.stale += value)],
    ["event.rejected.future", (value) => (state.eventsRejected.future += value)],
    ["event.rejected.rate_limited", (value) => (state.eventsRejected.rateLimited += value)],
    [
      "event.rejected.invalid_signature",
      (value) => (state.eventsRejected.invalidSignature += value),
    ],
    [
      "event.rejected.oversized_ciphertext",
      (value) => (state.eventsRejected.oversizedCiphertext += value),
    ],
    [
      "event.rejected.oversized_plaintext",
      (value) => (state.eventsRejected.oversizedPlaintext += value),
    ],
    ["event.rejected.decrypt_failed", (value) => (state.eventsRejected.decryptFailed += value)],
    ["event.rejected.self_message", (value) => (state.eventsRejected.selfMessage += value)],
    ["rate_limit.per_sender", (value) => (state.rateLimiting.perSenderHits += value)],
    ["rate_limit.global", (value) => (state.rateLimiting.globalHits += value)],
    ["decrypt.success", (value) => (state.decrypt.success += value)],
    ["decrypt.failure", (value) => (state.decrypt.failure += value)],
    ["memory.seen_tracker_size", (value) => (state.memory.seenTrackerSize = value)],
    ["memory.rate_limiter_entries", (value) => (state.memory.rateLimiterEntries = value)],
    ["relay.connect", relayMetric((relay, value) => (relay.connects += value))],
    ["relay.disconnect", relayMetric((relay, value) => (relay.disconnects += value))],
    ["relay.reconnect", relayMetric((relay, value) => (relay.reconnects += value))],
    ["relay.error", relayMetric((relay, value) => (relay.errors += value))],
    ["relay.message.event", relayMetric((relay, value) => (relay.messagesReceived.event += value))],
    ["relay.message.eose", relayMetric((relay, value) => (relay.messagesReceived.eose += value))],
    [
      "relay.message.closed",
      relayMetric((relay, value) => (relay.messagesReceived.closed += value)),
    ],
    [
      "relay.message.notice",
      relayMetric((relay, value) => (relay.messagesReceived.notice += value)),
    ],
    ["relay.message.ok", relayMetric((relay, value) => (relay.messagesReceived.ok += value))],
    ["relay.message.auth", relayMetric((relay, value) => (relay.messagesReceived.auth += value))],
    [
      "relay.circuit_breaker.open",
      relayMetric((relay, value) => {
        relay.circuitBreakerState = "open";
        relay.circuitBreakerOpens += value;
      }),
    ],
    [
      "relay.circuit_breaker.close",
      relayMetric((relay, value) => {
        relay.circuitBreakerState = "closed";
        relay.circuitBreakerCloses += value;
      }),
    ],
    [
      "relay.circuit_breaker.half_open",
      relayMetric((relay) => {
        relay.circuitBreakerState = "half_open";
      }),
    ],
  ]);

  function emit(name: MetricName, value = 1, labels?: Record<string, string | number>): void {
    onMetric?.({ name, value, timestamp: Date.now(), labels });
    updates.get(name)?.(value, labels?.relay as string | undefined);
  }

  function getSnapshot(): MetricsSnapshot {
    return createMetricsSnapshot(state);
  }

  function reset(): void {
    state = createZeroMetricsState();
  }

  return { emit, getSnapshot, reset };
}

export type MetricsSnapshot = ReturnType<typeof createMetricsSnapshot>;
export type NostrMetrics = ReturnType<typeof createMetrics>;

/**
 * Create a no-op metrics instance (for when metrics are disabled).
 */
export function createNoopMetrics(): NostrMetrics {
  const emptySnapshot = createMetricsSnapshot(createZeroMetricsState(), 0);

  return {
    emit: () => {},
    getSnapshot: () => ({ ...emptySnapshot, snapshotAt: Date.now() }),
    reset: () => {},
  };
}
