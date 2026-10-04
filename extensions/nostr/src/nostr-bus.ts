import { SimplePool, finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import {
  createDirectDmPreCryptoGuardPolicy,
  type DirectDmPreCryptoGuardPolicyOverrides,
} from "openclaw/plugin-sdk/direct-dm-guard-policy";
import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import type { NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
import { createMetrics, type NostrMetrics, type MetricEvent } from "./metrics.js";
import { createNostrCursorStateWriter, createNostrDurableCursor } from "./nostr-cursor.js";
import { NostrIngressPermanentError } from "./nostr-ingress-state.js";
import {
  createNostrIngress,
  NostrIngressAdmissionRejectedError,
  type NostrIngressLifecycle,
} from "./nostr-ingress.js";
import { validatePrivateKey } from "./nostr-key-utils.js";
import { publishProfile as publishProfileFn, type ProfilePublishResult } from "./nostr-profile.js";
import { createNostrRelaySubscriptionGroup } from "./nostr-relay-subscription.js";
import {
  readNostrBusState,
  writeNostrBusState,
  computeSinceTimestamp,
  readNostrProfileState,
  writeNostrProfileState,
} from "./nostr-state-store.js";

const STARTUP_LOOKBACK_SEC = 120; // tolerate relay lag / clock skew
const STATE_PERSIST_DEBOUNCE_MS = 5000;
const NOSTR_INGRESS_ENVELOPE_OVERHEAD_BYTES = 16 * 1024;
const NOSTR_INGRESS_MAX_PENDING_EVENTS = 1_000;

const CIRCUIT_BREAKER_THRESHOLD = 5; // failures before opening
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds before half-open

const HEALTH_WINDOW_MS = 60000;

interface NostrBusOptions {
  /** Private key in hex or nsec format */
  privateKey: string;
  /** WebSocket relay URLs (defaults to damus + nos.lol) */
  relays?: string[];
  /** Account ID for state persistence (optional, defaults to pubkey prefix) */
  accountId?: string;
  onMessage: (
    pubkey: string,
    text: string,
    reply: (text: string) => Promise<void>,
    meta: { eventId: string; createdAt: number },
    lifecycle: NostrIngressLifecycle,
  ) => Promise<void>;
  /** Called after signature verification and before decrypt to allow sender policy checks (optional) */
  authorizeSender?: (params: {
    senderPubkey: string;
    reply: (text: string) => Promise<void>;
  }) => Promise<"allow" | "block" | "pairing">;
  /** Override pre-crypto DM guardrails for tests or future channel tuning (optional) */
  guardPolicy?: DirectDmPreCryptoGuardPolicyOverrides;
  onError?: (error: Error, context: string) => void;
  onConnect?: (relay: string) => void;
  onDisconnect?: (relay: string) => void;
  /** Called on EOSE (end of stored events) for initial sync (optional) */
  onEose?: (relay: string) => void;
  onMetric?: (event: MetricEvent) => void;
  /** Test seam for awaiting relay callbacks that the transport intentionally ignores. */
  trackIngressTask?: (task: Promise<void>) => void;
}

type NostrDmSendOptions = Pick<
  ChannelOutboundContext,
  "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;

export interface NostrBusHandle {
  close: () => Promise<void>;
  publicKey: string;
  sendDm: (toPubkey: string, text: string, options?: NostrDmSendOptions) => Promise<string>;
  /** Publish a profile (kind:0) to all relays */
  publishProfile: (profile: NostrProfile) => Promise<ProfilePublishResult>;
  getProfileState: () => Promise<{
    lastPublishedAt: number | null;
    lastPublishedEventId: string | null;
    lastPublishResults: Record<string, "ok" | "failed" | "timeout"> | null;
  }>;
}

interface CircuitBreakerState {
  state: "closed" | "open" | "half_open";
  failures: number;
  lastFailure: number;
}

type CircuitBreaker = ReturnType<typeof createCircuitBreaker>;

function createCircuitBreaker(relay: string, metrics: NostrMetrics) {
  const state: CircuitBreakerState = {
    state: "closed",
    failures: 0,
    lastFailure: 0,
  };

  return {
    canAttempt(): boolean {
      if (state.state === "open") {
        if (Date.now() - state.lastFailure >= CIRCUIT_BREAKER_RESET_MS) {
          state.state = "half_open";
          metrics.emit("relay.circuit_breaker.half_open", 1, { relay });
          return true;
        }
        return false;
      }

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
    },

    recordFailure(): void {
      state.failures++;
      state.lastFailure = Date.now();

      if (
        state.state === "half_open" ||
        (state.state === "closed" && state.failures >= CIRCUIT_BREAKER_THRESHOLD)
      ) {
        state.state = "open";
        metrics.emit("relay.circuit_breaker.open", 1, { relay });
      }
    },
  };
}

interface RelayHealthStats {
  successCount: number;
  failureCount: number;
  latencySum: number;
  lastSuccess: number;
  lastFailure: number;
}

function createRelayHealthTracker() {
  const stats = new Map<string, RelayHealthStats>();

  function getOrCreate(relay: string): RelayHealthStats {
    let s = stats.get(relay);
    if (!s) {
      s = {
        successCount: 0,
        failureCount: 0,
        latencySum: 0,
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

      const successRate = s.successCount / total;

      // Recency bonus (prefer recently successful relays)
      const now = Date.now();
      const recencyBonus =
        s.lastSuccess > s.lastFailure
          ? Math.max(0, 1 - (now - s.lastSuccess) / HEALTH_WINDOW_MS) * 0.2
          : 0;

      // Latency penalty (lower is better)
      const avgLatency = s.successCount > 0 ? s.latencySum / s.successCount : 1000;
      const latencyPenalty = Math.min(0.2, avgLatency / 10000);

      return Math.max(0, Math.min(1, successRate + recencyBonus - latencyPenalty));
    },

    getSortedRelays(relays: string[]): string[] {
      return relays.toSorted((a, b) => this.getScore(b) - this.getScore(a));
    },
  };
}

/** Subscribe to NIP-04 encrypted DMs. */
export async function startNostrBus(options: NostrBusOptions): Promise<NostrBusHandle> {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    onMessage,
    authorizeSender,
    onError,
    onEose,
    onMetric,
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const pool = new SimplePool();
  pool.onRelayConnectionSuccess = options.onConnect;
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1000);
  const guardPolicy = createDirectDmPreCryptoGuardPolicy(options.guardPolicy);

  const metrics = createMetrics(onMetric);

  const circuitBreakers = new Map<string, CircuitBreaker>();
  const healthTracker = createRelayHealthTracker();

  for (const relay of relays) {
    circuitBreakers.set(relay, createCircuitBreaker(relay, metrics));
  }

  const state = await readNostrBusState({ accountId });
  const baseSince = computeSinceTimestamp(state, gatewayStartedAt);
  const since = Math.max(0, baseSince - STARTUP_LOOKBACK_SEC);
  // Preserve the prior replay baseline until durable EOSE-gated progress supersedes it.
  const cursorStartedAt = state?.gatewayStartedAt ?? gatewayStartedAt;

  const initialCursor = Math.max(baseSince, state?.lastProcessedAt ?? cursorStartedAt);
  const cursorWriter = createNostrCursorStateWriter({
    initialCursor,
    minimumCursor: baseSince,
    debounceMs: STATE_PERSIST_DEBOUNCE_MS,
    write: async (cursor) => {
      await writeNostrBusState({
        accountId,
        lastProcessedAt: cursor,
        gatewayStartedAt: cursorStartedAt,
        recentEventIds: [],
      });
    },
    onBackgroundError: (error) => onError?.(error, "persist state"),
  });
  const durableCursor = createNostrDurableCursor({
    since,
    replayOverlapSec: STARTUP_LOOKBACK_SEC,
  });

  const perSenderRateLimiter = createFixedWindowRateLimiter({
    windowMs: guardPolicy.rateLimit.windowMs,
    maxRequests: guardPolicy.rateLimit.maxPerSenderPerWindow,
    maxTrackedKeys: guardPolicy.rateLimit.maxTrackedSenderKeys,
  });
  const globalRateLimiter = createFixedWindowRateLimiter({
    windowMs: guardPolicy.rateLimit.windowMs,
    maxRequests: guardPolicy.rateLimit.maxGlobalPerWindow,
    maxTrackedKeys: 1,
  });

  const updateRateLimiterSizeMetric = () => {
    metrics.emit(
      "memory.rate_limiter_entries",
      perSenderRateLimiter.size() + globalRateLimiter.size(),
    );
  };

  const rejectIfRateLimited = (
    limiter: ReturnType<typeof createFixedWindowRateLimiter>,
    key: string,
    metric: "rate_limit.global" | "rate_limit.per_sender",
  ): boolean => {
    updateRateLimiterSizeMetric();
    const limited = limiter.isRateLimited(key);
    if (limited) {
      metrics.emit(metric);
      metrics.emit("event.rejected.rate_limited");
    }
    updateRateLimiterSizeMetric();
    return limited;
  };

  async function dispatchEvent(event: Event, lifecycle: NostrIngressLifecycle): Promise<void> {
    // Self-message loop prevention: skip our own messages.
    if (event.pubkey === pk) {
      metrics.emit("event.rejected.self_message");
      return;
    }

    // Future events remain retryable until their clock catches up.
    if (event.created_at > Math.floor(Date.now() / 1000) + guardPolicy.maxFutureSkewSec) {
      metrics.emit("event.rejected.future");
      throw new Error(`Nostr event ${event.id} is too far in the future.`);
    }

    if (!guardPolicy.allowedKinds.includes(event.kind)) {
      metrics.emit("event.rejected.wrong_kind");
      return;
    }

    if (!event.tags.some((tag) => tag[0] === "p" && tag[1] === pk)) {
      metrics.emit("event.rejected.wrong_kind");
      return;
    }

    const replyTo = async (text: string): Promise<void> => {
      await sendEncryptedDm(event.pubkey, text, { replyToEventId: event.id });
    };

    if (Buffer.byteLength(event.content, "utf8") > guardPolicy.maxCiphertextBytes) {
      if (rejectIfRateLimited(globalRateLimiter, "global", "rate_limit.global")) {
        throw new Error(`Nostr event ${event.id} hit the global rate limit.`);
      }
      metrics.emit("event.rejected.oversized_ciphertext");
      return;
    }
    if (rejectIfRateLimited(globalRateLimiter, "global", "rate_limit.global")) {
      throw new Error(`Nostr event ${event.id} hit the global rate limit.`);
    }

    // nostr-tools recomputes the canonical hash and verifies the signature.
    if (!verifyEvent(event)) {
      metrics.emit("event.rejected.invalid_signature");
      const error = new NostrIngressPermanentError(
        "invalid-signature",
        `Nostr event ${event.id} has an invalid signature.`,
      );
      onError?.(error, `event ${event.id}`);
      throw error;
    }

    if (rejectIfRateLimited(perSenderRateLimiter, event.pubkey, "rate_limit.per_sender")) {
      throw new Error(`Nostr sender ${event.pubkey} hit the rate limit.`);
    }

    if (authorizeSender) {
      const decision = await authorizeSender({ senderPubkey: event.pubkey, reply: replyTo });
      if (decision !== "allow") {
        return;
      }
    }

    let plaintext: string;
    try {
      plaintext = decrypt(sk, event.pubkey, event.content);
      metrics.emit("decrypt.success");
    } catch (error) {
      metrics.emit("decrypt.failure");
      metrics.emit("event.rejected.decrypt_failed");
      onError?.(error as Error, `decrypt from ${event.pubkey}`);
      throw new NostrIngressPermanentError(
        "decrypt-failed",
        `Nostr event ${event.id} could not be decrypted.`,
        { cause: error },
      );
    }

    if (Buffer.byteLength(plaintext, "utf8") > guardPolicy.maxPlaintextBytes) {
      metrics.emit("event.rejected.oversized_plaintext");
      return;
    }
    if (lifecycle.abortSignal.aborted) {
      throw new Error(`Nostr event ${event.id} stopped before dispatch.`);
    }

    await onMessage(
      event.pubkey,
      plaintext,
      replyTo,
      { eventId: event.id, createdAt: event.created_at },
      lifecycle,
    );
    metrics.emit("event.processed");
  }

  const dmFilter = { kinds: [4], "#p": [pk], since } satisfies Parameters<
    typeof pool.subscribeMany
  >[1];
  const relayAbort = new AbortController();
  let relaySubscriptions: ReturnType<typeof createNostrRelaySubscriptionGroup> | undefined;
  let relayStopPromise: Promise<void> | undefined;
  const stopRelays = (reason: string): Promise<void> => {
    relayStopPromise ??= (async () => {
      relayAbort.abort(reason);
      try {
        await relaySubscriptions?.close(reason);
      } catch (error) {
        onError?.(error as Error, "close subscription");
      } finally {
        try {
          pool.close(relays);
        } catch (error) {
          onError?.(error as Error, "close relay pool");
        }
      }
    })();
    return relayStopPromise;
  };

  const ingress = createNostrIngress({
    accountId,
    legacyEventIds: state?.recentEventIds ?? [],
    maxSerializedPayloadBytes:
      guardPolicy.maxCiphertextBytes + NOSTR_INGRESS_ENVELOPE_OVERHEAD_BYTES,
    maxPendingEvents: NOSTR_INGRESS_MAX_PENDING_EVENTS,
    maxQueuedAdmissions: guardPolicy.rateLimit.maxGlobalPerWindow,
    admissionRateLimit: {
      windowMs: guardPolicy.rateLimit.windowMs,
      maxEvents: guardPolicy.rateLimit.maxGlobalPerWindow,
    },
    afterDurableAppend: (event) => {
      const cursor = durableCursor.recordDurableAppend(event);
      if (cursor !== undefined) {
        cursorWriter.schedule(cursor);
      }
    },
    deliver: dispatchEvent,
    onError,
  });
  const persistTransientReplayCursor = async (event: Event): Promise<void> => {
    const cursor = durableCursor.recordTransientRejection(event);
    if (cursor !== undefined) {
      await cursorWriter.persistNow(cursor);
    }
  };
  const handleRelayEvent = async (event: Event): Promise<void> => {
    metrics.emit("event.received");
    // Apply the relay age fence once, before admission; recovered durable claims must still deliver.
    if (typeof event.created_at === "number" && event.created_at < since) {
      metrics.emit("event.rejected.stale");
      return;
    }
    try {
      const result = await ingress.receive(event);
      if (result === "duplicate") {
        metrics.emit("event.duplicate");
      }
    } catch (error) {
      onError?.(error as Error, `durable admission for event ${event.id}`);
      if (error instanceof NostrIngressAdmissionRejectedError) {
        if (error.reason === "rate-limited") {
          metrics.emit("rate_limit.global");
          metrics.emit("event.rejected.rate_limited");
        }
        if (error.reason !== "oversized-event") {
          try {
            await persistTransientReplayCursor(event);
          } catch (cursorError) {
            onError?.(cursorError as Error, "persist transient replay cursor");
            await stopRelays("cursor persistence failed");
            await cursorWriter.flushUntilSuccess();
          }
        }
        return;
      }
      if (error instanceof NostrIngressPermanentError) {
        return;
      }
      let cursorPersistenceFailed = false;
      try {
        await persistTransientReplayCursor(event);
      } catch (cursorError) {
        onError?.(cursorError as Error, "persist transient replay cursor");
        cursorPersistenceFailed = true;
      }
      await stopRelays("durable admission failed");
      if (cursorPersistenceFailed) {
        await cursorWriter.flushUntilSuccess();
      }
    }
  };
  let backfillFinalizePromise: Promise<void> | undefined;

  try {
    await ingress.ready();

    // Clear the retired persisted-ID seed only after every id is a queue tombstone.
    await writeNostrBusState({
      accountId,
      lastProcessedAt: initialCursor,
      gatewayStartedAt: cursorStartedAt,
      recentEventIds: [],
    });

    relaySubscriptions = createNostrRelaySubscriptionGroup({
      pool,
      relays,
      filter: dmFilter,
      abort: relayAbort.signal,
      onEvent: (event) => {
        const task = handleRelayEvent(event);
        if (options.trackIngressTask) {
          options.trackIngressTask(task.then(() => ingress.waitForIdle()));
        }
        void task;
      },
      onBackfillComplete: (confirmedRelays) => {
        backfillFinalizePromise ??= ingress
          .waitForIdle()
          .then(() => {
            const cursor = durableCursor.markBackfillComplete();
            if (cursor !== undefined) {
              cursorWriter.schedule(cursor);
            }
            for (const relay of confirmedRelays) {
              metrics.emit("relay.message.eose", 1, { relay });
            }
            onEose?.(confirmedRelays.join(", "));
          })
          .catch((error: unknown) => onError?.(error as Error, "finalize relay backfill"));
      },
      onClose: (relay, reasons) => {
        metrics.emit("relay.message.closed", 1, { relay });
        options.onDisconnect?.(relay);
        onError?.(new Error(`Subscription closed: ${reasons.join(", ")}`), "subscription");
      },
    });
    relaySubscriptions.start();
  } catch (error) {
    await Promise.allSettled([stopRelays("startup failed"), ingress.stop()]);
    throw error;
  }

  const publishProfile = async (profile: NostrProfile): Promise<ProfilePublishResult> => {
    const profileState = await readNostrProfileState({ accountId });
    const lastPublishedAt = profileState?.lastPublishedAt ?? undefined;

    const result = await publishProfileFn(pool, sk, relays, profile, lastPublishedAt);

    const publishResults: Record<string, "ok" | "failed" | "timeout"> = {};
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
      lastPublishResults: publishResults,
    });

    return result;
  };

  const getProfileState = async () => {
    const stateLocal = await readNostrProfileState({ accountId });
    return {
      lastPublishedAt: stateLocal?.lastPublishedAt ?? null,
      lastPublishedEventId: stateLocal?.lastPublishedEventId ?? null,
      lastPublishResults: stateLocal?.lastPublishResults ?? null,
    };
  };

  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      await stopRelays("closed by caller");
      await ingress.stop();
      await backfillFinalizePromise;
      await cursorWriter.flushUntilSuccess();
      perSenderRateLimiter.clear();
      globalRateLimiter.clear();
    })();
    return closePromise;
  };

  async function sendEncryptedDm(
    toPubkey: string,
    text: string,
    sendOptions?: NostrDmSendOptions & { replyToEventId?: string },
  ): Promise<string> {
    const ciphertext = encrypt(sk, toPubkey, text);
    // NIP-04 uses an e tag to keep a reply attached to its verified inbound event.
    const tags = [["p", toPubkey]];
    if (sendOptions?.replyToEventId) {
      tags.push(["e", sendOptions.replyToEventId]);
    }
    const reply = finalizeEvent(
      {
        kind: 4,
        content: ciphertext,
        tags,
        created_at: Math.floor(Date.now() / 1000),
      },
      sk,
    );

    const sortedRelays = healthTracker.getSortedRelays(relays);

    let lastError: Error | undefined;
    for (const relay of sortedRelays) {
      sendOptions?.assertDirectAdapterHandoff?.();
      const cb = circuitBreakers.get(relay);

      if (cb && !cb.canAttempt()) {
        continue;
      }

      const startTime = Date.now();
      const recordFailure = (err: unknown) => {
        lastError = err instanceof Error ? err : new Error(String(err));
        const latency = Date.now() - startTime;
        cb?.recordFailure();
        healthTracker.recordFailure(relay);
        metrics.emit("relay.error", 1, { relay, latency });
        onError?.(lastError, `publish to ${relay}`);
      };
      // Keep connection preparation separate from the recipient-visible EVENT handoff.
      const connection = await pool
        .ensureRelay(relay, { connectionTimeout: pool.maxWaitForConnection })
        .catch((err: unknown) => {
          recordFailure(new Error(`connection failure: ${String(err)}`));
        });
      if (!connection) {
        continue;
      }
      sendOptions?.assertDirectAdapterHandoff?.();
      if (sendOptions?.onPlatformSendDispatch) {
        await sendOptions.onPlatformSendDispatch();
        sendOptions.assertDirectAdapterHandoff?.();
      }
      try {
        await connection.publish(reply);
        const latency = Date.now() - startTime;

        cb?.recordSuccess();
        healthTracker.recordSuccess(relay, latency);

        return reply.id;
      } catch (err) {
        recordFailure(err);
      }
    }

    throw new Error(`Failed to publish to any relay: ${lastError?.message}`);
  }

  return {
    close,
    publicKey: pk,
    sendDm: sendEncryptedDm,
    publishProfile,
    getProfileState,
  };
}
