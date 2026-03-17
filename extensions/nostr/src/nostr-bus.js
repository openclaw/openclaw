import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  nip19
} from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import {
  createMetrics,
  createNoopMetrics
} from "./metrics.js";
import { publishProfile as publishProfileFn } from "./nostr-profile.js";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
  readNostrProfileState,
  writeNostrProfileState
} from "./nostr-state-store.js";
import { createSeenTracker } from "./seen-tracker.js";
const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];
const STARTUP_LOOKBACK_SEC = 120;
const MAX_PERSISTED_EVENT_IDS = 5e3;
const STATE_PERSIST_DEBOUNCE_MS = 5e3;
const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_RESET_MS = 3e4;
const HEALTH_WINDOW_MS = 6e4;
function createCircuitBreaker(relay, metrics, threshold = CIRCUIT_BREAKER_THRESHOLD, resetMs = CIRCUIT_BREAKER_RESET_MS) {
  const state = {
    state: "closed",
    failures: 0,
    lastFailure: 0,
    lastSuccess: Date.now()
  };
  return {
    canAttempt() {
      if (state.state === "closed") {
        return true;
      }
      if (state.state === "open") {
        if (Date.now() - state.lastFailure >= resetMs) {
          state.state = "half_open";
          metrics.emit("relay.circuit_breaker.half_open", 1, { relay });
          return true;
        }
        return false;
      }
      return true;
    },
    recordSuccess() {
      if (state.state === "half_open") {
        state.state = "closed";
        state.failures = 0;
        metrics.emit("relay.circuit_breaker.close", 1, { relay });
      } else if (state.state === "closed") {
        state.failures = 0;
      }
      state.lastSuccess = Date.now();
    },
    recordFailure() {
      state.failures++;
      state.lastFailure = Date.now();
      if (state.state === "half_open") {
        state.state = "open";
        metrics.emit("relay.circuit_breaker.open", 1, { relay });
      } else if (state.state === "closed" && state.failures >= threshold) {
        state.state = "open";
        metrics.emit("relay.circuit_breaker.open", 1, { relay });
      }
    },
    getState() {
      return state.state;
    }
  };
}
function createRelayHealthTracker() {
  const stats = /* @__PURE__ */ new Map();
  function getOrCreate(relay) {
    let s = stats.get(relay);
    if (!s) {
      s = {
        successCount: 0,
        failureCount: 0,
        latencySum: 0,
        latencyCount: 0,
        lastSuccess: 0,
        lastFailure: 0
      };
      stats.set(relay, s);
    }
    return s;
  }
  return {
    recordSuccess(relay, latencyMs) {
      const s = getOrCreate(relay);
      s.successCount++;
      s.latencySum += latencyMs;
      s.latencyCount++;
      s.lastSuccess = Date.now();
    },
    recordFailure(relay) {
      const s = getOrCreate(relay);
      s.failureCount++;
      s.lastFailure = Date.now();
    },
    getScore(relay) {
      const s = stats.get(relay);
      if (!s) {
        return 0.5;
      }
      const total = s.successCount + s.failureCount;
      if (total === 0) {
        return 0.5;
      }
      const successRate = s.successCount / total;
      const now = Date.now();
      const recencyBonus = s.lastSuccess > s.lastFailure ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * 0.2 : 0;
      const avgLatency = s.latencyCount > 0 ? s.latencySum / s.latencyCount : 1e3;
      const latencyPenalty = Math.min(0.2, avgLatency / 1e4);
      return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
    },
    getSortedRelays(relays) {
      return [...relays].toSorted((a, b) => this.getScore(b) - this.getScore(a));
    }
  };
}
function validatePrivateKey(key) {
  const trimmed = key.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("Invalid nsec key: wrong type");
    }
    return decoded.data;
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Private key must be 64 hex characters or nsec bech32 format");
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
function getPublicKeyFromPrivate(privateKey) {
  const sk = validatePrivateKey(privateKey);
  return getPublicKey(sk);
}
async function startNostrBus(options) {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    onMessage,
    onError,
    onEose,
    onMetric,
    maxSeenEntries = 1e5,
    seenTtlMs = 60 * 60 * 1e3
  } = options;
  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const pool = new SimplePool();
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1e3);
  const metrics = onMetric ? createMetrics(onMetric) : createNoopMetrics();
  const seen = createSeenTracker({
    maxEntries: maxSeenEntries,
    ttlMs: seenTtlMs
  });
  const circuitBreakers = /* @__PURE__ */ new Map();
  const healthTracker = createRelayHealthTracker();
  for (const relay of relays) {
    circuitBreakers.set(relay, createCircuitBreaker(relay, metrics));
  }
  const state = await readNostrBusState({ accountId });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);
  if (state?.recentEventIds?.length) {
    seen.seed(state.recentEventIds);
  }
  await writeNostrBusState({
    accountId,
    lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
    gatewayStartedAt,
    recentEventIds: state?.recentEventIds ?? []
  });
  let pendingWrite;
  let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
  let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);
  function scheduleStatePersist(eventCreatedAt, eventId) {
    lastProcessedAt = Math.max(lastProcessedAt, eventCreatedAt);
    recentEventIds.push(eventId);
    if (recentEventIds.length > MAX_PERSISTED_EVENT_IDS) {
      recentEventIds = recentEventIds.slice(-MAX_PERSISTED_EVENT_IDS);
    }
    if (pendingWrite) {
      clearTimeout(pendingWrite);
    }
    pendingWrite = setTimeout(() => {
      writeNostrBusState({
        accountId,
        lastProcessedAt,
        gatewayStartedAt,
        recentEventIds
      }).catch((err) => onError?.(err, "persist state"));
    }, STATE_PERSIST_DEBOUNCE_MS);
  }
  const inflight = /* @__PURE__ */ new Set();
  async function handleEvent(event) {
    try {
      metrics.emit("event.received");
      if (seen.peek(event.id) || inflight.has(event.id)) {
        metrics.emit("event.duplicate");
        return;
      }
      inflight.add(event.id);
      if (event.pubkey === pk) {
        metrics.emit("event.rejected.self_message");
        return;
      }
      if (event.created_at < since) {
        metrics.emit("event.rejected.stale");
        return;
      }
      let targetsUs = false;
      for (const t of event.tags) {
        if (t[0] === "p" && t[1] === pk) {
          targetsUs = true;
          break;
        }
      }
      if (!targetsUs) {
        metrics.emit("event.rejected.wrong_kind");
        return;
      }
      if (!verifyEvent(event)) {
        metrics.emit("event.rejected.invalid_signature");
        onError?.(new Error("Invalid signature"), `event ${event.id}`);
        return;
      }
      seen.add(event.id);
      metrics.emit("memory.seen_tracker_size", seen.size());
      let plaintext;
      try {
        plaintext = decrypt(sk, event.pubkey, event.content);
        metrics.emit("decrypt.success");
      } catch (err) {
        metrics.emit("decrypt.failure");
        metrics.emit("event.rejected.decrypt_failed");
        onError?.(err, `decrypt from ${event.pubkey}`);
        return;
      }
      const replyTo = async (text) => {
        await sendEncryptedDm(
          pool,
          sk,
          event.pubkey,
          text,
          relays,
          metrics,
          circuitBreakers,
          healthTracker,
          onError
        );
      };
      await onMessage(event.pubkey, plaintext, replyTo);
      metrics.emit("event.processed");
      scheduleStatePersist(event.created_at, event.id);
    } catch (err) {
      onError?.(err, `event ${event.id}`);
    } finally {
      inflight.delete(event.id);
    }
  }
  const sub = pool.subscribeMany(
    relays,
    [{ kinds: [4], "#p": [pk], since }],
    {
      onevent: handleEvent,
      oneose: () => {
        for (const relay of relays) {
          metrics.emit("relay.message.eose", 1, { relay });
        }
        onEose?.(relays.join(", "));
      },
      onclose: (reason) => {
        for (const relay of relays) {
          metrics.emit("relay.message.closed", 1, { relay });
          options.onDisconnect?.(relay);
        }
        onError?.(new Error(`Subscription closed: ${reason.join(", ")}`), "subscription");
      }
    }
  );
  const sendDm = async (toPubkey, text) => {
    await sendEncryptedDm(
      pool,
      sk,
      toPubkey,
      text,
      relays,
      metrics,
      circuitBreakers,
      healthTracker,
      onError
    );
  };
  const publishProfile = async (profile) => {
    const profileState = await readNostrProfileState({ accountId });
    const lastPublishedAt = profileState?.lastPublishedAt ?? void 0;
    const result = await publishProfileFn(pool, sk, relays, profile, lastPublishedAt);
    const publishResults = {};
    for (const relay of result.successes) {
      publishResults[relay] = "ok";
    }
    for (const { relay, error } of result.failures) {
      publishResults[relay] = error === "timeout" ? "timeout" : "failed";
    }
    await writeNostrProfileState({
      accountId,
      lastPublishedAt: result.createdAt,
      lastPublishedEventId: result.eventId,
      lastPublishResults: publishResults
    });
    return result;
  };
  const getProfileState = async () => {
    const state2 = await readNostrProfileState({ accountId });
    return {
      lastPublishedAt: state2?.lastPublishedAt ?? null,
      lastPublishedEventId: state2?.lastPublishedEventId ?? null,
      lastPublishResults: state2?.lastPublishResults ?? null
    };
  };
  return {
    close: () => {
      sub.close();
      seen.stop();
      if (pendingWrite) {
        clearTimeout(pendingWrite);
        writeNostrBusState({
          accountId,
          lastProcessedAt,
          gatewayStartedAt,
          recentEventIds
        }).catch((err) => onError?.(err, "persist state on close"));
      }
    },
    publicKey: pk,
    sendDm,
    getMetrics: () => metrics.getSnapshot(),
    publishProfile,
    getProfileState
  };
}
async function sendEncryptedDm(pool, sk, toPubkey, text, relays, metrics, circuitBreakers, healthTracker, onError) {
  const ciphertext = encrypt(sk, toPubkey, text);
  const reply = finalizeEvent(
    {
      kind: 4,
      content: ciphertext,
      tags: [["p", toPubkey]],
      created_at: Math.floor(Date.now() / 1e3)
    },
    sk
  );
  const sortedRelays = healthTracker.getSortedRelays(relays);
  let lastError;
  for (const relay of sortedRelays) {
    const cb = circuitBreakers.get(relay);
    if (cb && !cb.canAttempt()) {
      continue;
    }
    const startTime = Date.now();
    try {
      await pool.publish([relay], reply);
      const latency = Date.now() - startTime;
      cb?.recordSuccess();
      healthTracker.recordSuccess(relay, latency);
      return;
    } catch (err) {
      lastError = err;
      const latency = Date.now() - startTime;
      cb?.recordFailure();
      healthTracker.recordFailure(relay);
      metrics.emit("relay.error", 1, { relay, latency });
      onError?.(lastError, `publish to ${relay}`);
    }
  }
  throw new Error(`Failed to publish to any relay: ${lastError?.message}`);
}
function isValidPubkey(input) {
  if (typeof input !== "string") {
    return false;
  }
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub";
    } catch {
      return false;
    }
  }
  return /^[0-9a-fA-F]{64}$/.test(trimmed);
}
function normalizePubkey(input) {
  const trimmed = input.trim();
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("Invalid npub key");
    }
    return Array.from(decoded.data).map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Pubkey must be 64 hex characters or npub format");
  }
  return trimmed.toLowerCase();
}
function pubkeyToNpub(hexPubkey) {
  const normalized = normalizePubkey(hexPubkey);
  return nip19.npubEncode(normalized);
}
export {
  DEFAULT_RELAYS,
  getPublicKeyFromPrivate,
  isValidPubkey,
  normalizePubkey,
  pubkeyToNpub,
  startNostrBus,
  validatePrivateKey
};
