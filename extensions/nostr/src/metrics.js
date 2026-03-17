function createMetrics(onMetric) {
  let eventsReceived = 0;
  let eventsProcessed = 0;
  let eventsDuplicate = 0;
  const eventsRejected = {
    invalidShape: 0,
    wrongKind: 0,
    stale: 0,
    future: 0,
    rateLimited: 0,
    invalidSignature: 0,
    oversizedCiphertext: 0,
    oversizedPlaintext: 0,
    decryptFailed: 0,
    selfMessage: 0
  };
  const relays = /* @__PURE__ */ new Map();
  const rateLimiting = {
    perSenderHits: 0,
    globalHits: 0
  };
  const decrypt = {
    success: 0,
    failure: 0
  };
  const memory = {
    seenTrackerSize: 0,
    rateLimiterEntries: 0
  };
  function getOrCreateRelay(url) {
    let relay = relays.get(url);
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
          auth: 0
        },
        circuitBreakerState: "closed",
        circuitBreakerOpens: 0,
        circuitBreakerCloses: 0
      };
      relays.set(url, relay);
    }
    return relay;
  }
  function emit(name, value = 1, labels) {
    if (onMetric) {
      onMetric({
        name,
        value,
        timestamp: Date.now(),
        labels
      });
    }
    const relayUrl = labels?.relay;
    switch (name) {
      // Event metrics
      case "event.received":
        eventsReceived += value;
        break;
      case "event.processed":
        eventsProcessed += value;
        break;
      case "event.duplicate":
        eventsDuplicate += value;
        break;
      case "event.rejected.invalid_shape":
        eventsRejected.invalidShape += value;
        break;
      case "event.rejected.wrong_kind":
        eventsRejected.wrongKind += value;
        break;
      case "event.rejected.stale":
        eventsRejected.stale += value;
        break;
      case "event.rejected.future":
        eventsRejected.future += value;
        break;
      case "event.rejected.rate_limited":
        eventsRejected.rateLimited += value;
        break;
      case "event.rejected.invalid_signature":
        eventsRejected.invalidSignature += value;
        break;
      case "event.rejected.oversized_ciphertext":
        eventsRejected.oversizedCiphertext += value;
        break;
      case "event.rejected.oversized_plaintext":
        eventsRejected.oversizedPlaintext += value;
        break;
      case "event.rejected.decrypt_failed":
        eventsRejected.decryptFailed += value;
        break;
      case "event.rejected.self_message":
        eventsRejected.selfMessage += value;
        break;
      // Relay metrics
      case "relay.connect":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).connects += value;
        }
        break;
      case "relay.disconnect":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).disconnects += value;
        }
        break;
      case "relay.reconnect":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).reconnects += value;
        }
        break;
      case "relay.error":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).errors += value;
        }
        break;
      case "relay.message.event":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.event += value;
        }
        break;
      case "relay.message.eose":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.eose += value;
        }
        break;
      case "relay.message.closed":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.closed += value;
        }
        break;
      case "relay.message.notice":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.notice += value;
        }
        break;
      case "relay.message.ok":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.ok += value;
        }
        break;
      case "relay.message.auth":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).messagesReceived.auth += value;
        }
        break;
      case "relay.circuit_breaker.open":
        if (relayUrl) {
          const r = getOrCreateRelay(relayUrl);
          r.circuitBreakerState = "open";
          r.circuitBreakerOpens += value;
        }
        break;
      case "relay.circuit_breaker.close":
        if (relayUrl) {
          const r = getOrCreateRelay(relayUrl);
          r.circuitBreakerState = "closed";
          r.circuitBreakerCloses += value;
        }
        break;
      case "relay.circuit_breaker.half_open":
        if (relayUrl) {
          getOrCreateRelay(relayUrl).circuitBreakerState = "half_open";
        }
        break;
      // Rate limiting
      case "rate_limit.per_sender":
        rateLimiting.perSenderHits += value;
        break;
      case "rate_limit.global":
        rateLimiting.globalHits += value;
        break;
      // Decrypt
      case "decrypt.success":
        decrypt.success += value;
        break;
      case "decrypt.failure":
        decrypt.failure += value;
        break;
      // Memory (gauge-style - value replaces, not adds)
      case "memory.seen_tracker_size":
        memory.seenTrackerSize = value;
        break;
      case "memory.rate_limiter_entries":
        memory.rateLimiterEntries = value;
        break;
    }
  }
  function getSnapshot() {
    const relaysObj = {};
    for (const [url, stats] of relays) {
      relaysObj[url] = { ...stats, messagesReceived: { ...stats.messagesReceived } };
    }
    return {
      eventsReceived,
      eventsProcessed,
      eventsDuplicate,
      eventsRejected: { ...eventsRejected },
      relays: relaysObj,
      rateLimiting: { ...rateLimiting },
      decrypt: { ...decrypt },
      memory: { ...memory },
      snapshotAt: Date.now()
    };
  }
  function reset() {
    eventsReceived = 0;
    eventsProcessed = 0;
    eventsDuplicate = 0;
    Object.assign(eventsRejected, {
      invalidShape: 0,
      wrongKind: 0,
      stale: 0,
      future: 0,
      rateLimited: 0,
      invalidSignature: 0,
      oversizedCiphertext: 0,
      oversizedPlaintext: 0,
      decryptFailed: 0,
      selfMessage: 0
    });
    relays.clear();
    rateLimiting.perSenderHits = 0;
    rateLimiting.globalHits = 0;
    decrypt.success = 0;
    decrypt.failure = 0;
    memory.seenTrackerSize = 0;
    memory.rateLimiterEntries = 0;
  }
  return { emit, getSnapshot, reset };
}
function createNoopMetrics() {
  const emptySnapshot = {
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
      selfMessage: 0
    },
    relays: {},
    rateLimiting: { perSenderHits: 0, globalHits: 0 },
    decrypt: { success: 0, failure: 0 },
    memory: { seenTrackerSize: 0, rateLimiterEntries: 0 },
    snapshotAt: 0
  };
  return {
    emit: () => {
    },
    getSnapshot: () => ({ ...emptySnapshot, snapshotAt: Date.now() }),
    reset: () => {
    }
  };
}
export {
  createMetrics,
  createNoopMetrics
};
