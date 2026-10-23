import { SimplePool, finalizeEvent, getPublicKey, verifyEvent, type Event } from "nostr-tools";
import { decrypt, encrypt } from "nostr-tools/nip04";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import { createDirectDmPreCryptoGuardPolicy } from "openclaw/plugin-sdk/direct-dm-guard-policy";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { createFixedWindowRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import type { NostrProfile } from "./config-schema.js";
import { DEFAULT_RELAYS } from "./default-relays.js";
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

type NostrEventRejection =
  | "self_message"
  | "future"
  | "wrong_kind"
  | "oversized_ciphertext"
  | "invalid_signature"
  | "decrypt_failed"
  | "oversized_plaintext"
  | "stale"
  | "rate_limited";

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
  /** Internal local rejection hint for literal-only allowlist accounts; never grants access. */
  admissionPubkeys?: readonly string[];
  onError?: (error: Error, context: string) => void;
  onConnect?: (relay: string) => void;
  onDisconnect?: (relay: string) => void;
  /** Called on EOSE (end of stored events) for initial sync (optional) */
  onEose?: (relay: string) => void;
  onRejected?: (reason: NostrEventRejection) => void;
  /** Test seam for awaiting relay callbacks that the transport intentionally ignores. */
  trackIngressTask?: (task: Promise<void>) => void;
}

type NostrDmSendOptions = Pick<
  ChannelOutboundContext,
  "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
>;

export type NostrBusHandle = Awaited<ReturnType<typeof startNostrBus>>;

/** Subscribe to NIP-04 encrypted DMs. */
export async function startNostrBus(options: NostrBusOptions) {
  const {
    privateKey,
    relays = DEFAULT_RELAYS,
    onMessage,
    authorizeSender,
    onError,
    onEose,
    onRejected,
  } = options;

  const sk = validatePrivateKey(privateKey);
  const pk = getPublicKey(sk);
  const pool = new SimplePool();
  const admissionPubkeys = options.admissionPubkeys ? new Set(options.admissionPubkeys) : undefined;
  pool.onRelayConnectionSuccess = options.onConnect;
  const accountId = options.accountId ?? pk.slice(0, 16);
  const gatewayStartedAt = Math.floor(Date.now() / 1000);
  const guardPolicy = createDirectDmPreCryptoGuardPolicy();

  let preferredRelay: string | undefined;

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

  const rejectIfRateLimited = (
    limiter: ReturnType<typeof createFixedWindowRateLimiter>,
    key: string,
  ): boolean => {
    const limited = limiter.isRateLimited(key);
    if (limited) {
      onRejected?.("rate_limited");
    }
    return limited;
  };

  async function dispatchEvent(event: Event, lifecycle: NostrIngressLifecycle): Promise<void> {
    // Self-message loop prevention: skip our own messages.
    if (event.pubkey === pk) {
      onRejected?.("self_message");
      return;
    }

    // Future events remain retryable until their clock catches up.
    if (event.created_at > Math.floor(Date.now() / 1000) + guardPolicy.maxFutureSkewSec) {
      onRejected?.("future");
      throw new Error(`Nostr event ${event.id} is too far in the future.`);
    }

    if (!guardPolicy.allowedKinds.includes(event.kind)) {
      onRejected?.("wrong_kind");
      return;
    }

    if (!event.tags.some((tag) => tag[0] === "p" && tag[1] === pk)) {
      onRejected?.("wrong_kind");
      return;
    }

    const replyTo = async (text: string): Promise<void> => {
      await sendEncryptedDm(event.pubkey, text, { replyToEventId: event.id });
    };

    if (Buffer.byteLength(event.content, "utf8") > guardPolicy.maxCiphertextBytes) {
      if (rejectIfRateLimited(globalRateLimiter, "global")) {
        throw new Error(`Nostr event ${event.id} hit the global rate limit.`);
      }
      onRejected?.("oversized_ciphertext");
      return;
    }
    if (rejectIfRateLimited(globalRateLimiter, "global")) {
      throw new Error(`Nostr event ${event.id} hit the global rate limit.`);
    }

    // nostr-tools recomputes the canonical hash and verifies the signature.
    if (!verifyEvent(event)) {
      onRejected?.("invalid_signature");
      const error = new NostrIngressPermanentError(
        "invalid-signature",
        `Nostr event ${event.id} has an invalid signature.`,
      );
      onError?.(error, `event ${event.id}`);
      throw error;
    }

    if (rejectIfRateLimited(perSenderRateLimiter, event.pubkey)) {
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
    } catch (error) {
      onRejected?.("decrypt_failed");
      onError?.(error as Error, `decrypt from ${event.pubkey}`);
      throw new NostrIngressPermanentError(
        "decrypt-failed",
        `Nostr event ${event.id} could not be decrypted.`,
        { cause: error },
      );
    }

    if (Buffer.byteLength(plaintext, "utf8") > guardPolicy.maxPlaintextBytes) {
      onRejected?.("oversized_plaintext");
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
    // Apply the relay age fence once, before admission; recovered durable claims must still deliver.
    if (typeof event.created_at === "number" && event.created_at < since) {
      onRejected?.("stale");
      return;
    }
    // Keep configured peer identities local, never in relay subscription filters.
    // Matching events still pass durable ingress and current sender authorization.
    if (admissionPubkeys && !admissionPubkeys.has(event.pubkey)) {
      return;
    }
    try {
      await ingress.receive(event);
    } catch (error) {
      onError?.(error as Error, `durable admission for event ${event.id}`);
      if (error instanceof NostrIngressAdmissionRejectedError) {
        if (error.reason === "rate-limited") {
          onRejected?.("rate_limited");
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
            onEose?.(confirmedRelays.join(", "));
          })
          .catch((error: unknown) => onError?.(error as Error, "finalize relay backfill"));
      },
      onClose: (relay, reasons) => {
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
    const effect = captureEffectAuthority();
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

    // Prefer the last working relay; each explicit send may retry failed relays.
    const sortedRelays = relays.toSorted(
      (left, right) => Number(right === preferredRelay) - Number(left === preferredRelay),
    );

    let lastError: Error | undefined;
    for (const relay of sortedRelays) {
      sendOptions?.assertDirectAdapterHandoff?.();
      const recordFailure = (err: unknown) => {
        lastError = err instanceof Error ? err : new Error(String(err));
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
      let initiated = false;
      try {
        await effect.initiate(() => {
          sendOptions?.assertDirectAdapterHandoff?.();
          initiated = true;
          return connection.publish(reply);
        });
        preferredRelay = relay;

        return reply.id;
      } catch (err) {
        if (!initiated) {
          throw err;
        }
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
