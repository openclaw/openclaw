import {
  SimplePool,
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  nip19,
  type Event,
} from "nostr-tools";
import { decrypt as decryptNip04, encrypt as encryptNip04 } from "nostr-tools/nip04";
import { decrypt, encrypt, getConversationKey } from "nostr-tools/nip44";
import type { NostrProfile } from "./config-schema.js";
import {
  createMetrics,
  createNoopMetrics,
  type NostrMetrics,
  type MetricsSnapshot,
  type MetricEvent,
} from "./metrics.js";
import {
  publishAiInfo as publishAiInfoFn,
  type AiInfoContent,
  type AiInfoPublishResult,
} from "./nostr-ai-info.js";
import { publishProfile as publishProfileFn, type ProfilePublishResult } from "./nostr-profile.js";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
  readNostrProfileState,
  writeNostrProfileState,
} from "./nostr-state-store.js";
import { createSeenTracker, type SeenTracker } from "./seen-tracker.js";

export const DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol"];

// ============================================================================
// Constants
// ============================================================================

const STARTUP_LOOKBACK_SEC = 120; // tolerate relay lag / clock skew
const MAX_PERSISTED_EVENT_IDS = 5000;
const STATE_PERSIST_DEBOUNCE_MS = 5000; // Debounce state writes
const REPLAY_POLL_INTERVAL_MS = 5000;
const REPLAY_POLL_MAX_WAIT_MS = 3000;
const REPLAY_POLL_OVERLAP_SEC = 30;

// Circuit breaker configuration
const CIRCUIT_BREAKER_THRESHOLD = 5; // failures before opening
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds before half-open

// Health tracker configuration
const HEALTH_WINDOW_MS = 60000; // 1 minute window for health stats

// ============================================================================
// Types
// ============================================================================

const NIP63_PROTOCOL_VERSION = 1;
const NIP63_ENCRYPTION_SCHEME = "nip44";
const NIP04_DM_KIND = 4;
const NIP63_PROMPT_KIND = 25802;
const NIP63_CANCEL_KIND = 25806;
const NIP63_RESPONSE_KIND_STATUS = 25800;
const NIP63_RESPONSE_KIND_FINAL = 25803;
const NIP63_RESPONSE_KIND_TOOL = 25804;
const NIP63_RESPONSE_KIND_BLOCK = 25801;
const NIP63_RESPONSE_KIND_ERROR = 25805;
const RELAY_PUBLISH_TIMEOUT_MS = 3500;
const NIP63_SUBSCRIBE_KINDS = [
  NIP04_DM_KIND,
  25800,
  25801,
  25802,
  25803,
  25804,
  25805,
  25806,
  31340,
] as const;

export interface NostrBusOptions {
  /** Private key in hex or nsec format */
  privateKey: string;
  /** WebSocket relay URLs (defaults to damus + nos.lol).
   * Accepts legacy string forms for backward compatibility.
   */
  relays?: string[] | string;
  /** Account ID for state persistence (optional, defaults to pubkey prefix) */
  accountId?: string;
  /** Called when a NIP-63 prompt is received */
  onMessage: (
    message: NostrInboundMessage,
    reply: (
      content: NostrOutboundContent,
      options: NostrOutboundMessageOptions | undefined,
      responseKind?: number,
    ) => Promise<void>,
  ) => Promise<void>;
  /** Called on errors (optional) */
  onError?: (error: Error, context: string) => void;
  /** Called when an outbound response is successfully published (optional) */
  onSend?: (event: {
    senderPubkey: string;
    recipientPubkey: string;
    senderRole: string;
    recipientRole: string;
    responseKind: number;
    relays: string[];
    eventId: string;
    decryptedPayload?: string;
  }) => void;
  /** Called on connection status changes (optional) */
  onConnect?: (relay: string) => void;
  /** Called on disconnection (optional) */
  onDisconnect?: (relay: string) => void;
  /** Called on EOSE (end of stored events) for initial sync (optional) */
  onEose?: (relay: string) => void;
  /** Called on each metric event (optional) */
  onMetric?: (event: MetricEvent) => void;
  /** Called with inbound event lifecycle/rejection details for diagnostics (optional) */
  onInboundTrace?: (event: NostrInboundTraceEvent) => void;
  /** Maximum entries in seen tracker (default: 100,000) */
  maxSeenEntries?: number;
  /** Seen tracker TTL in ms (default: 1 hour) */
  seenTtlMs?: number;
}

export interface NostrBusHandle {
  /** Stop the bus and close connections */
  close: () => void;
  /** Get the bot's public key */
  publicKey: string;
  /** Send a NIP-63 response to a pubkey */
  sendDm: (
    toPubkey: string,
    content: NostrOutboundContent,
    options?: NostrOutboundMessageOptions,
    responseKind?: number,
  ) => Promise<void>;
  /** Get current metrics snapshot */
  getMetrics: () => MetricsSnapshot;
  /** Publish a profile (kind:0) to all relays */
  publishProfile: (profile: NostrProfile) => Promise<ProfilePublishResult>;
  /** Publish AI info (kind:31340) to all relays */
  publishAiInfo: (payload: AiInfoContent) => Promise<AiInfoPublishResult>;
  /** Get the last profile publish state */
  getProfileState: () => Promise<{
    lastPublishedAt: number | null;
    lastPublishedEventId: string | null;
    lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
  }>;
}

export interface NostrInboundMessage {
  senderPubkey: string;
  text: string;
  createdAt: number;
  eventId: string;
  kind: number;
  sessionId?: string;
  inReplyTo?: string;
  cancelReason?: "user_cancel" | "timeout" | "policy";
}

export interface NostrOutboundMessageOptions {
  sessionId?: string;
  inReplyTo?: string;
}

type NostrOutboundContent = string | Record<string, unknown>;

interface NostrPromptPayload {
  ver: number;
  message: string;
}

interface NostrCancelPayload {
  ver: number;
  reason: "user_cancel" | "timeout" | "policy";
}

export interface NostrInboundTraceEvent {
  stage:
    | "received"
    | "duplicate"
    | "self_message"
    | "stale"
    | "missing_target"
    | "unsupported_kind"
    | "unsupported_encryption"
    | "invalid_signature"
    | "decrypt_failed"
    | "invalid_prompt"
    | "accepted";
  eventId: string;
  kind: number;
  senderPubkey: string;
  createdAt: number;
  reason?: string;
  details?: Record<string, unknown>;
}

export function normalizeRelayUrls(rawRelays: unknown): string[] {
  const relays = new Set<string>();

  const pushRelay = (rawRelay: unknown): void => {
    if (typeof rawRelay !== "string") {
      return;
    }
    const relay = rawRelay.trim();
    if (relay) {
      relays.add(relay);
    }
  };

  if (Array.isArray(rawRelays)) {
    for (const relay of rawRelays) {
      pushRelay(relay);
    }
    return [...relays];
  }

  if (typeof rawRelays === "string") {
    const trimmed = rawRelays.trim();
    if (!trimmed) {
      return [];
    }

    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          for (const relay of parsed) {
            pushRelay(relay);
          }
          return [...relays];
        }
      } catch {
        // If JSON parse fails, treat it as a delimiter-separated list below.
      }
    }

    for (const relay of trimmed.split(/[\n,;]+/g)) {
      pushRelay(relay);
    }
  }

  return [...relays];
}

// ============================================================================
// Circuit Breaker
// ============================================================================

interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  failures: number;
  lastFailure: number;
  lastSuccess: number;
}

interface CircuitBreaker {
  /** Check if requests should be allowed */
  canAttempt: () => boolean;
  /** Record a success */
  recordSuccess: () => void;
  /** Record a failure */
  recordFailure: () => void;
  /** Get current state */
  getState: () => CircuitBreakerState["state"];
}

function createCircuitBreaker(
  relay: string,
  metrics: NostrMetrics,
  threshold: number = CIRCUIT_BREAKER_THRESHOLD,
  resetMs: number = CIRCUIT_BREAKER_RESET_MS,
): CircuitBreaker {
  const state: CircuitBreakerState = {
    state: "closed",
    failures: 0,
    lastFailure: 0,
    lastSuccess: Date.now(),
  };

  return {
    canAttempt(): boolean {
      if (state.state === "closed") {
        return true;
      }

      if (state.state === "open") {
        // Check if enough time has passed to try half-open
        if (Date.now() - state.lastFailure >= resetMs) {
          state.state = "half_open";
          metrics.emit("relay.circuit_breaker.half_open", 1, { relay });
          return true;
        }
        return false;
      }

      // half_open: allow one attempt
      return true;
    },

    recordSuccess(): void {
      if (state.state === "half_open") {
        state.state = "closed";
        state.failures = 0;
        metrics.emit("relay.circuit_breaker.close", 1, { relay });
      } else if (state.state === "closed") {
        state.failures = 0;
      }
      state.lastSuccess = Date.now();
    },

    recordFailure(): void {
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

    getState(): CircuitBreakerState["state"] {
      return state.state;
    },
  };
}

// ============================================================================
// Relay Health Tracker
// ============================================================================

interface RelayHealthStats {
  successCount: number;
  failureCount: number;
  latencySum: number;
  latencyCount: number;
  lastSuccess: number;
  lastFailure: number;
}

interface RelayHealthTracker {
  /** Record a successful operation */
  recordSuccess: (relay: string, latencyMs: number) => void;
  /** Record a failed operation */
  recordFailure: (relay: string) => void;
  /** Get health score (0-1, higher is better) */
  getScore: (relay: string) => number;
  /** Get relays sorted by health (best first) */
  getSortedRelays: (relays: string[]) => string[];
}

function createRelayHealthTracker(): RelayHealthTracker {
  const stats = new Map<string, RelayHealthStats>();

  function getOrCreate(relay: string): RelayHealthStats {
    let s = stats.get(relay);
    if (!s) {
      s = {
        successCount: 0,
        failureCount: 0,
        latencySum: 0,
        latencyCount: 0,
        lastSuccess: 0,
        lastFailure: 0,
      };
      stats.set(relay, s);
    }
    return s;
  }

  return {
    recordSuccess(relay: string, latencyMs: number): void {
      const s = getOrCreate(relay);
      s.successCount++;
      s.latencySum += latencyMs;
      s.latencyCount++;
      s.lastSuccess = Date.now();
    },

    recordFailure(relay: string): void {
      const s = getOrCreate(relay);
      s.failureCount++;
      s.lastFailure = Date.now();
    },

    getScore(relay: string): number {
      const s = stats.get(relay);
      if (!s) {
        return 0.5;
      } // Unknown relay gets neutral score

      const total = s.successCount + s.failureCount;
      if (total === 0) {
        return 0.5;
      }

      // Success rate (0-1)
      const successRate = s.successCount / total;

      // Recency bonus (prefer recently successful relays)
      const now = Date.now();
      const recencyBonus =
        s.lastSuccess > s.lastFailure
          ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * 0.2
          : 0;

      // Latency penalty (lower is better)
      const avgLatency = s.latencyCount > 0 ? s.latencySum / s.latencyCount : 1000;
      const latencyPenalty = Math.min(0.2, avgLatency / 10000);

      return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
    },

    getSortedRelays(relays: string[]): string[] {
      return [...relays].toSorted((a, b) => this.getScore(b) - this.getScore(a));
    },
  };
}

// ============================================================================
// Key Validation
// ============================================================================

/**
 * Validate and normalize a private key (accepts hex or nsec format)
 */
export function validatePrivateKey(key: string): Uint8Array {
  const trimmed = key.trim();

  // Handle nsec (bech32) format
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") {
      throw new Error("Invalid nsec key: wrong type");
    }
    return decoded.data;
  }

  // Handle hex format
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Private key must be 64 hex characters or nsec bech32 format");
  }

  // Convert hex string to Uint8Array
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Get public key from private key (hex or nsec format)
 */
export function getPublicKeyFromPrivate(privateKey: string): string {
  const sk = validatePrivateKey(privateKey);
  return getPublicKey(sk);
}

// ============================================================================
// Main Bus
// ============================================================================

/**
 * Start the Nostr agent bus - subscribes to NIP-63 events
 */
export async function startNostrBus(options: NostrBusOptions): Promise<NostrBusHandle> {
  const {
    privateKey,
    relays,
    onMessage,
    onError,
    onSend,
    onConnect,
    onDisconnect,
    onEose,
    onMetric,
    onInboundTrace,
    maxSeenEntries = 100_000,
    seenTtlMs = 60 * 60 * 1000,
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const normalizedRelays = normalizeRelayUrls(relays ?? DEFAULT_RELAYS);
  if (normalizedRelays.length === 0) {
    throw new Error("At least one Nostr relay is required");
  }

  // Initialize metrics
  const metrics = onMetric ? createMetrics(onMetric) : createNoopMetrics();
  const pool = new SimplePool({
    enableReconnect: true,
    enablePing: true,
    onRelayConnectionSuccess: (relay: string) => {
      metrics.emit("relay.connect", 1, { relay });
      onConnect?.(relay);
    },
    onRelayConnectionFailure: (relay: string) => {
      metrics.emit("relay.connect.failure", 1, { relay });
      onDisconnect?.(relay);
    },
  } as ConstructorParameters<typeof SimplePool>[0]);
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1000);
  let lastAiInfoPublishedAt: number | undefined;

  // Initialize seen tracker with LRU
  const seen: SeenTracker = createSeenTracker({
    maxEntries: maxSeenEntries,
    ttlMs: seenTtlMs,
  });

  // Initialize circuit breakers and health tracker
  const circuitBreakers = new Map<string, CircuitBreaker>();
  const healthTracker = createRelayHealthTracker();

  for (const relay of normalizedRelays) {
    circuitBreakers.set(relay, createCircuitBreaker(relay, metrics));
  }

  // Read persisted state and compute `since` timestamp (with small overlap)
  const state = await readNostrBusState({ accountId });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);

  // Seed in-memory dedupe with recent IDs from disk (prevents restart replay)
  if (state?.recentEventIds?.length) {
    seen.seed(state.recentEventIds);
  }

  // Persist startup timestamp
  await writeNostrBusState({
    accountId,
    lastProcessedAt: state?.lastProcessedAt ?? gatewayStartedAt,
    gatewayStartedAt,
    recentEventIds: state?.recentEventIds ?? [],
  });

  // Debounced state persistence
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let lastProcessedAt = state?.lastProcessedAt ?? gatewayStartedAt;
  let recentEventIds = (state?.recentEventIds ?? []).slice(-MAX_PERSISTED_EVENT_IDS);

  function scheduleStatePersist(eventCreatedAt: number, eventId: string): void {
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
        recentEventIds,
      }).catch((err) => onError?.(err as Error, "persist state"));
    }, STATE_PERSIST_DEBOUNCE_MS);
  }

  const inflight = new Set<string>();

  const traceInbound = (
    stage: NostrInboundTraceEvent["stage"],
    event: Event,
    details?: Record<string, unknown>,
  ): void => {
    if (!onInboundTrace) {
      return;
    }
    try {
      onInboundTrace({
        stage,
        eventId: event.id,
        kind: event.kind,
        senderPubkey: event.pubkey,
        createdAt: event.created_at,
        ...(details?.reason ? { reason: String(details.reason) } : {}),
        ...(details ? { details } : {}),
      });
    } catch {
      // Keep diagnostics side-effects from impacting protocol flow.
    }
  };

  // Event handler
  async function handleEvent(event: Event, source: "live" | "poll" = "live"): Promise<void> {
    try {
      metrics.emit("event.received");
      const alreadySeen = seen.peek(event.id) || inflight.has(event.id);
      if (alreadySeen) {
        // Fast dedupe check (handles relay reconnections)
        metrics.emit("event.duplicate");
        traceInbound("duplicate", event, { source });
        return;
      }
      traceInbound("received", event, { source });
      inflight.add(event.id);

      // Self-message loop prevention: skip our own messages
      if (event.pubkey === pk) {
        metrics.emit("event.rejected.self_message");
        traceInbound("self_message", event, { source });
        return;
      }

      // Skip events older than our `since` (relay may ignore filter)
      if (event.created_at < since) {
        metrics.emit("event.rejected.stale");
        traceInbound("stale", event, { source, since });
        return;
      }

      // Fast p-tag check BEFORE crypto (no allocation, cheaper)
      let targetsUs = false;
      for (const t of event.tags) {
        if (t[0] === "p" && t[1] === pk) {
          targetsUs = true;
          break;
        }
      }
      if (!targetsUs) {
        metrics.emit("event.rejected.wrong_kind");
        traceInbound("missing_target", event, { source, targetPubkey: pk });
        return;
      }

      // Process only supported inbound kinds.
      if (
        event.kind !== NIP63_PROMPT_KIND &&
        event.kind !== NIP63_CANCEL_KIND &&
        event.kind !== NIP04_DM_KIND
      ) {
        metrics.emit("event.rejected.wrong_kind");
        traceInbound("unsupported_kind", event, {
          source,
          expectedKinds: [NIP63_PROMPT_KIND, NIP63_CANCEL_KIND, NIP04_DM_KIND],
        });
        return;
      }

      if (event.kind === NIP63_PROMPT_KIND || event.kind === NIP63_CANCEL_KIND) {
        // Validate required encryption scheme tag for NIP-63.
        const encryptionScheme = resolveNip63EncryptionScheme(event.tags);
        if (encryptionScheme !== NIP63_ENCRYPTION_SCHEME) {
          metrics.emit("event.rejected.invalid_shape");
          traceInbound("unsupported_encryption", event, {
            source,
            encryptionScheme: encryptionScheme ?? "missing",
            expected: NIP63_ENCRYPTION_SCHEME,
          });
          onError?.(
            new Error(`Unsupported encryption scheme ${encryptionScheme ?? "missing"}`),
            `event ${event.id}`,
          );
          return;
        }
      }

      // Verify signature (must pass before we trust the event)
      if (!verifyEvent(event)) {
        metrics.emit("event.rejected.invalid_signature");
        traceInbound("invalid_signature", event, { source });
        onError?.(new Error("Invalid signature"), `event ${event.id}`);
        return;
      }

      // Mark seen AFTER verify (don't cache invalid IDs)
      seen.add(event.id);
      metrics.emit("memory.seen_tracker_size", seen.size());

      // Decrypt the message
      let plaintext: string;
      try {
        if (event.kind === NIP04_DM_KIND) {
          plaintext = decryptNip04(sk, event.pubkey, event.content);
        } else {
          const conversationKey = getConversationKey(sk, event.pubkey);
          plaintext = decrypt(event.content, conversationKey);
        }
        metrics.emit("decrypt.success");
      } catch (err) {
        metrics.emit("decrypt.failure");
        metrics.emit("event.rejected.decrypt_failed");
        traceInbound("decrypt_failed", event, {
          source,
          reason: err instanceof Error ? err.message : String(err),
        });
        onError?.(err as Error, `decrypt from ${event.pubkey}`);
        return;
      }

      let cancelReason: NostrInboundMessage["cancelReason"];
      const inboundText =
        event.kind === NIP04_DM_KIND
          ? plaintext
          : (() => {
              if (event.kind === NIP63_PROMPT_KIND) {
                // Parse NIP-63 prompt content from encrypted JSON payload.
                let parsed: NostrPromptPayload;
                try {
                  parsed = parseNip63PromptPayload(plaintext, event.id);
                } catch (err) {
                  metrics.emit("event.rejected.invalid_shape");
                  traceInbound("invalid_prompt", event, {
                    source,
                    reason: err instanceof Error ? err.message : String(err),
                  });
                  onError?.(err as Error, `parse prompt ${event.id}`);
                  return undefined;
                }
                return parsed.message;
              }

              let parsed: NostrCancelPayload;
              try {
                parsed = parseNip63CancelPayload(plaintext, event.id);
              } catch (err) {
                metrics.emit("event.rejected.invalid_shape");
                traceInbound("invalid_prompt", event, {
                  source,
                  reason: err instanceof Error ? err.message : String(err),
                });
                onError?.(err as Error, `parse cancel ${event.id}`);
                return undefined;
              }
              cancelReason = parsed.reason;
              return parsed.reason;
            })();
      if (inboundText === undefined) {
        return;
      }

      // Create reply function (try relays by health score)
      const replyTo = async (
        content: NostrOutboundContent,
        replyOptions?: NostrOutboundMessageOptions,
        responseKind?: number,
      ): Promise<void> => {
        const normalizedResponseKind = event.kind === NIP04_DM_KIND ? NIP04_DM_KIND : responseKind;
        await sendEncryptedDm(
          pool,
          sk,
          event.pubkey,
          content,
          replyOptions,
          normalizedRelays,
          metrics,
          circuitBreakers,
          healthTracker,
          pk,
          normalizedResponseKind,
          onSend,
          onError,
        );
      };

      const sessionId = getTagValue(event.tags, "s");
      const inReplyTo = getTagValue(event.tags, "e");

      traceInbound("accepted", event, {
        source,
        sessionId,
        inReplyTo,
        kind: event.kind,
        ...(cancelReason ? { cancelReason } : {}),
      });

      // Call the message handler
      await onMessage(
        {
          senderPubkey: event.pubkey,
          text: inboundText,
          createdAt: event.created_at,
          eventId: event.id,
          kind: event.kind,
          sessionId,
          inReplyTo,
          cancelReason,
        },
        replyTo,
      );

      // Mark as processed
      metrics.emit("event.processed");

      // Persist progress (debounced)
      scheduleStatePersist(event.created_at, event.id);
    } catch (err) {
      onError?.(err as Error, `event ${event.id}`);
    } finally {
      inflight.delete(event.id);
    }
  }

  const sub = pool.subscribeMany(
    normalizedRelays,
    {
      kinds: [...NIP63_SUBSCRIBE_KINDS],
      "#p": [pk],
      since,
    } as Parameters<typeof pool.subscribeMany>[1],
    {
      onevent: handleEvent,
      oneose: () => {
        // EOSE handler - called when all stored events have been received
        for (const relay of normalizedRelays) {
          metrics.emit("relay.message.eose", 1, { relay });
        }
        onEose?.(normalizedRelays.join(", "));
      },
      onclose: (reason) => {
        // Handle subscription close
        for (const relay of normalizedRelays) {
          metrics.emit("relay.message.closed", 1, { relay });
          onDisconnect?.(relay);
        }
        const reasonText = reason.join(", ");
        if (reasonText.toLowerCase().includes("closed by caller")) {
          return;
        }
        onError?.(new Error(`Subscription closed: ${reasonText}`), "subscription");
      },
    },
  );

  let replayPollInFlight = false;
  const runReplayPoll = async (): Promise<void> => {
    if (replayPollInFlight) {
      return;
    }
    replayPollInFlight = true;
    try {
      const replaySince = Math.max(0, lastProcessedAt - REPLAY_POLL_OVERLAP_SEC);
      const replayEvents = await pool.querySync(
        normalizedRelays,
        {
          kinds: [NIP63_PROMPT_KIND, NIP04_DM_KIND],
          "#p": [pk],
          since: replaySince,
        },
        {
          label: "nostr-replay",
          maxWait: REPLAY_POLL_MAX_WAIT_MS,
        },
      );

      const ordered = [...replayEvents].sort((left, right) => {
        if (left.created_at === right.created_at) {
          return left.id.localeCompare(right.id);
        }
        return left.created_at - right.created_at;
      });
      for (const event of ordered) {
        await handleEvent(event as Event, "poll");
      }
    } catch (error) {
      onError?.(error as Error, "replay-poll");
    } finally {
      replayPollInFlight = false;
    }
  };
  const replayPollTimer = setInterval(() => {
    void runReplayPoll();
  }, REPLAY_POLL_INTERVAL_MS);
  if (typeof replayPollTimer.unref === "function") {
    replayPollTimer.unref();
  }
  void runReplayPoll();

  // Public sendDm function
  const sendDm = async (
    toPubkey: string,
    content: NostrOutboundContent,
    options?: NostrOutboundMessageOptions,
    responseKind?: number,
  ): Promise<void> => {
    await sendEncryptedDm(
      pool,
      sk,
      toPubkey,
      content,
      options,
      normalizedRelays,
      metrics,
      circuitBreakers,
      healthTracker,
      pk,
      responseKind,
      onSend,
      onError,
    );
  };

  // Profile publishing function
  const publishProfile = async (profile: NostrProfile): Promise<ProfilePublishResult> => {
    // Read last published timestamp for monotonic ordering
    const profileState = await readNostrProfileState({ accountId });
    const lastPublishedAt = profileState?.lastPublishedAt ?? undefined;

    // Publish the profile
    const result = await publishProfileFn(pool, sk, normalizedRelays, profile, lastPublishedAt);

    // Convert results to state format
    const publishResults: Record<string, "ok" | "failed" | "timeout"> = {};
    for (const relay of result.successes) {
      publishResults[relay] = "ok";
    }
    for (const { relay, error } of result.failures) {
      publishResults[relay] = error === "timeout" ? "timeout" : "failed";
    }

    // Persist the publish state
    await writeNostrProfileState({
      accountId,
      lastPublishedAt: result.createdAt,
      lastPublishedEventId: result.eventId,
      lastPublishedProfileFingerprint: null,
      lastPublishResults: publishResults,
    });

    return result;
  };

  // Get profile state function
  const getProfileState = async () => {
    const state = await readNostrProfileState({ accountId });
    return {
      lastPublishedAt: state?.lastPublishedAt ?? null,
      lastPublishedEventId: state?.lastPublishedEventId ?? null,
      lastPublishResults: state?.lastPublishResults ?? null,
    };
  };

  const publishAiInfo = async (payload: AiInfoContent): Promise<AiInfoPublishResult> => {
    const result = await publishAiInfoFn(
      pool,
      sk,
      normalizedRelays,
      payload,
      lastAiInfoPublishedAt,
    );
    lastAiInfoPublishedAt = result.createdAt;
    return result;
  };

  return {
    close: () => {
      sub.close();
      seen.stop();
      clearInterval(replayPollTimer);
      // Flush pending state write synchronously on close
      if (pendingWrite) {
        clearTimeout(pendingWrite);
        writeNostrBusState({
          accountId,
          lastProcessedAt,
          gatewayStartedAt,
          recentEventIds,
        }).catch((err) => onError?.(err as Error, "persist state on close"));
      }
    },
    publicKey: pk,
    sendDm,
    getMetrics: () => metrics.getSnapshot(),
    publishProfile,
    publishAiInfo,
    getProfileState,
  };
}

function resolveNip63EncryptionScheme(tags: string[][]): string | undefined {
  const encryptionScheme = getTagValue(tags, "encryption");
  if (!encryptionScheme) {
    return undefined;
  }

  const normalized = encryptionScheme.trim().toLowerCase();
  if (!normalized.length) {
    return undefined;
  }

  return normalized;
}

function ensureStringField(payload: Record<string, unknown>, key: string, kind: number): void {
  if (typeof payload[key] !== "string" || !String(payload[key]).trim().length) {
    throw new Error(`Invalid NIP-63 payload for kind ${kind}: missing ${key}`);
  }
}

function normalizeNip63Payload(
  content: NostrOutboundContent,
  kind: number,
): Record<string, unknown> {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> =
    typeof content === "string"
      ? (() => {
          if (kind === NIP63_RESPONSE_KIND_ERROR) {
            return {
              ver: NIP63_PROTOCOL_VERSION,
              code: "INTERNAL_ERROR",
              message: content,
              timestamp,
            };
          }
          if (kind === NIP63_RESPONSE_KIND_BLOCK) {
            return {
              ver: NIP63_PROTOCOL_VERSION,
              event: "block",
              phase: "update",
              text: content,
              timestamp,
            };
          }
          if (kind === NIP63_RESPONSE_KIND_TOOL) {
            return {
              ver: NIP63_PROTOCOL_VERSION,
              name: "tool",
              phase: "result",
              output: { text: content },
              success: true,
              timestamp,
            };
          }
          return {
            ver: NIP63_PROTOCOL_VERSION,
            text: content,
            timestamp,
          };
        })()
      : { ...content };

  if (payload.ver === undefined) {
    payload.ver = NIP63_PROTOCOL_VERSION;
  }
  if (payload.ver !== NIP63_PROTOCOL_VERSION) {
    throw new Error(`Invalid NIP-63 payload version: ${String(payload.ver)}`);
  }
  if (payload.timestamp === undefined) {
    payload.timestamp = timestamp;
  }

  if (kind === NIP63_RESPONSE_KIND_FINAL) {
    ensureStringField(payload, "text", kind);
  } else if (kind === NIP63_RESPONSE_KIND_STATUS) {
    ensureStringField(payload, "state", kind);
    const state = String(payload.state).trim();
    if (state !== "thinking" && state !== "tool_use" && state !== "done") {
      throw new Error(`Invalid NIP-63 status state: ${state}`);
    }
  } else if (kind === NIP63_RESPONSE_KIND_BLOCK) {
    ensureStringField(payload, "event", kind);
    ensureStringField(payload, "phase", kind);
    ensureStringField(payload, "text", kind);
    const eventName = String(payload.event).trim();
    if (eventName !== "thinking" && eventName !== "block") {
      throw new Error(`Invalid NIP-63 delta event: ${eventName}`);
    }
  } else if (kind === NIP63_RESPONSE_KIND_TOOL) {
    ensureStringField(payload, "name", kind);
    ensureStringField(payload, "phase", kind);
    const phase = String(payload.phase).trim();
    if (phase !== "start" && phase !== "result") {
      throw new Error(`Invalid NIP-63 tool phase: ${phase}`);
    }
  } else if (kind === NIP63_RESPONSE_KIND_ERROR) {
    ensureStringField(payload, "code", kind);
    ensureStringField(payload, "message", kind);
  }

  return payload;
}

// ============================================================================
// Send DM with Circuit Breaker + Health Scoring
// ============================================================================

/**
 * Send an encrypted NIP-63 response to a pubkey
 */
async function sendEncryptedDm(
  pool: SimplePool,
  sk: Uint8Array,
  toPubkey: string,
  content: NostrOutboundContent,
  options: NostrOutboundMessageOptions | undefined,
  relays: string[],
  metrics: NostrMetrics,
  circuitBreakers: Map<string, CircuitBreaker>,
  healthTracker: RelayHealthTracker,
  senderPubkey: string,
  responseKind?: number,
  onSend?: (event: {
    senderPubkey: string;
    recipientPubkey: string;
    senderRole: string;
    recipientRole: string;
    responseKind: number;
    relays: string[];
    eventId: string;
    decryptedPayload?: string;
  }) => void,
  onError?: (error: Error, context: string) => void,
): Promise<void> {
  const relayList = [...relays];
  if (!relayList.length) {
    const error = new Error("Nostr send failed: no relays configured");
    onError?.(error, "sendEncryptedDm");
    throw error;
  }

  const isNip04Response = responseKind === NIP04_DM_KIND;
  const normalizedResponseKind = isNip04Response
    ? NIP04_DM_KIND
    : responseKind === NIP63_RESPONSE_KIND_STATUS ||
        responseKind === NIP63_RESPONSE_KIND_TOOL ||
        responseKind === NIP63_RESPONSE_KIND_BLOCK ||
        responseKind === NIP63_RESPONSE_KIND_ERROR
      ? responseKind
      : NIP63_RESPONSE_KIND_FINAL;
  const tags: string[][] = [["p", toPubkey]];
  if (!isNip04Response) {
    tags.push(["encryption", NIP63_ENCRYPTION_SCHEME]);
    if (options?.sessionId) {
      tags.push(["s", options.sessionId]);
    }
  }
  if (options?.inReplyTo) {
    tags.push(["e", options.inReplyTo, "", "root"]);
  }

  let decryptedPayload: string | undefined;
  const ciphertext = isNip04Response
    ? encryptNip04(sk, toPubkey, typeof content === "string" ? content : JSON.stringify(content))
    : (() => {
        const payload = normalizeNip63Payload(content, normalizedResponseKind);
        decryptedPayload = JSON.stringify(payload);
        const conversationKey = getConversationKey(sk, toPubkey);
        return encrypt(decryptedPayload, conversationKey);
      })();
  const reply = finalizeEvent(
    {
      kind: normalizedResponseKind,
      content: ciphertext,
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    sk,
  );

  // Sort relays by health score (best first) and fan out in parallel.
  const sortedRelays = healthTracker.getSortedRelays(relayList);
  const eligibleRelays = sortedRelays.filter((relay) => {
    const cb = circuitBreakers.get(relay);
    if (cb && !cb.canAttempt()) {
      onError?.(new Error("Nostr relay skipped by circuit breaker"), `relay ${relay}`);
      return false;
    }
    return true;
  });
  if (!eligibleRelays.length) {
    const error = new Error(
      `Nostr send failed: no eligible relays (${relayList.length} configured)`,
    );
    onError?.(error, "sendEncryptedDm");
    throw error;
  }

  const withPublishTimeout = async (publishResult: unknown): Promise<void> => {
    await Promise.race([
      Promise.all(Array.isArray(publishResult) ? publishResult : [publishResult]),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`publish timeout after ${RELAY_PUBLISH_TIMEOUT_MS}ms`)),
          RELAY_PUBLISH_TIMEOUT_MS,
        );
      }),
    ]);
  };

  type RelayOutcome = {
    relay: string;
    ok: boolean;
    latencyMs: number;
    error?: Error;
  };

  const publishRelay = async (relay: string): Promise<RelayOutcome> => {
    const startTime = Date.now();
    const cb = circuitBreakers.get(relay);
    try {
      const publishResult = await pool.publish([relay], reply);
      await withPublishTimeout(publishResult);
      const latencyMs = Date.now() - startTime;
      cb?.recordSuccess();
      healthTracker.recordSuccess(relay, latencyMs);
      try {
        onSend?.({
          senderPubkey,
          recipientPubkey: toPubkey,
          senderRole: "gateway",
          recipientRole: "user",
          responseKind: normalizedResponseKind,
          relays: [relay],
          eventId: reply.id,
          decryptedPayload,
        });
      } catch (sendError) {
        onError?.(sendError as Error, "sendEncryptedDm.onSend");
      }
      return { relay, ok: true, latencyMs };
    } catch (err) {
      const error = err as Error;
      const latencyMs = Date.now() - startTime;
      cb?.recordFailure();
      healthTracker.recordFailure(relay);
      metrics.emit("relay.error", 1, { relay, latency: latencyMs });
      onError?.(
        error,
        `publish failed relay=${relay} latencyMs=${latencyMs} relays=${relayList.length}`,
      );
      return { relay, ok: false, latencyMs, error };
    }
  };

  // Run all publish attempts concurrently. Return as soon as we get first success
  // to avoid blocking stream latency on slower relays, while still letting fanout
  // complete in the background.
  const attempts = eligibleRelays.map((relay) => publishRelay(relay));
  try {
    await Promise.any(
      attempts.map((promise) =>
        promise.then((outcome) => {
          if (!outcome.ok) {
            throw outcome.error ?? new Error(`publish failed relay=${outcome.relay}`);
          }
          return outcome;
        }),
      ),
    );
    return;
  } catch {
    const settled = await Promise.all(attempts);
    const lastFailure = [...settled].reverse().find((entry) => !entry.ok && entry.error)?.error;
    const aggregateError = new Error(
      `Failed to publish to any relay (${eligibleRelays.length} eligible/${relayList.length} configured): ${lastFailure?.message ?? "unknown error"}`,
    );
    onError?.(aggregateError, "sendEncryptedDm");
    throw aggregateError;
  }
}

/**
 * Return first matching tag value for a given tag key.
 */
function getTagValue(tags: string[][], key: string): string | undefined {
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) {
      continue;
    }
    if (tag[0] !== key) {
      continue;
    }
    const value = tag[1]?.trim();
    if (value?.length) {
      return value;
    }
  }
  return undefined;
}

function parseNip63PromptPayload(plaintext: string, eventId: string): NostrPromptPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (err) {
    throw new Error(`Invalid JSON prompt payload for ${eventId}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Prompt payload must be an object for ${eventId}`);
  }

  const candidate = parsed as Partial<NostrPromptPayload> & {
    ver?: unknown;
    message?: unknown;
  };
  if (typeof candidate.ver !== "number" || candidate.ver !== NIP63_PROTOCOL_VERSION) {
    throw new Error(`Unsupported payload version for ${eventId}`);
  }

  if (typeof candidate.message !== "string" || candidate.message.trim().length === 0) {
    throw new Error(`Missing prompt message for ${eventId}`);
  }

  return {
    ver: candidate.ver,
    message: candidate.message,
  };
}

function parseNip63CancelPayload(plaintext: string, eventId: string): NostrCancelPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error(`Invalid JSON cancel payload for ${eventId}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cancel payload must be an object for ${eventId}`);
  }

  const candidate = parsed as Partial<NostrCancelPayload> & {
    ver?: unknown;
    reason?: unknown;
  };
  if (typeof candidate.ver !== "number" || candidate.ver !== NIP63_PROTOCOL_VERSION) {
    throw new Error(`Unsupported payload version for ${eventId}`);
  }
  if (
    candidate.reason !== "user_cancel" &&
    candidate.reason !== "timeout" &&
    candidate.reason !== "policy"
  ) {
    throw new Error(`Invalid cancel reason for ${eventId}`);
  }

  return {
    ver: candidate.ver,
    reason: candidate.reason,
  };
}

// ============================================================================
// Pubkey Utilities
// ============================================================================

/**
 * Check if a string looks like a valid Nostr pubkey (hex or npub)
 */
export function isValidPubkey(input: string): boolean {
  if (typeof input !== "string") {
    return false;
  }
  const trimmed = input.trim();

  // npub format
  if (trimmed.startsWith("npub1")) {
    try {
      const decoded = nip19.decode(trimmed);
      return decoded.type === "npub";
    } catch {
      return false;
    }
  }

  // Hex format
  return /^[0-9a-fA-F]{64}$/.test(trimmed);
}

/**
 * Normalize a pubkey to hex format (accepts npub or hex)
 */
export function normalizePubkey(input: string): string {
  const trimmed = input.trim();

  // npub format - decode to hex
  if (trimmed.startsWith("npub1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "npub") {
      throw new Error("Invalid npub key");
    }
    // Convert Uint8Array to hex string
    return Array.from(decoded.data as unknown as Uint8Array)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // Already hex - validate and return lowercase
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error("Pubkey must be 64 hex characters or npub format");
  }
  return trimmed.toLowerCase();
}

/**
 * Convert a hex pubkey to npub format
 */
export function pubkeyToNpub(hexPubkey: string): string {
  const normalized = normalizePubkey(hexPubkey);
  // npubEncode expects a hex string, not Uint8Array
  return nip19.npubEncode(normalized);
}
