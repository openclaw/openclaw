import { finalizeEvent, verifyEvent, type Event } from "nostr-tools";
import { captureEffectAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import type { PluginServiceSchedulerV1 } from "openclaw/plugin-sdk/plugin-entry";
import {
  queryBuzzDirectoryProfiles,
  queryBuzzDirectoryRooms,
  startBuzzDirectoryRelay,
} from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { inspectBuzzMentionSyntax, resolveBuzzMessageMentions } from "./mentions.js";
import {
  BUZZ_NORMAL_MESSAGE_KIND,
  BUZZ_INBOUND_MESSAGE_KINDS,
  BUZZ_TYPING_INDICATOR_KIND,
  buildBuzzMessageTags,
  parseBuzzMessageEvent,
  type BuzzInboundMessage,
} from "./message-event.js";
import { syncBuzzProfile } from "./profile.js";
import {
  connectAuthenticatedBuzzRelay,
  connectAuthenticatedBuzzRelaySession,
  parseBuzzAuthTag,
} from "./relay-auth.js";
import { queryBuzzRelaySnapshot } from "./relay-subscription.js";
import {
  BUZZ_REPLAY_DISPATCH_MAX_PENDING,
  createBuzzReplayDispatchQueue,
  resolveBuzzRoomHistoryLimit,
} from "./replay-dispatch.js";
import { startBuzzRoomMembershipNotifications } from "./room-membership-notification.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import { createBuzzRoomMembershipTracker } from "./room-membership-tracker.js";
import { resolveBuzzSubscriptionBudget } from "./subscription-budget.js";
import { decodeBuzzPrivateKey, resolveBuzzPublicKey } from "./types.js";

const PRESENCE_KIND = 20_001;
const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;
const REPLAY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REPLAY_MAX_ENTRIES = 10_000;
const REPLAY_STATE_MAX_ENTRIES = 50_000;
const REPLAY_NAMESPACE_PREFIX = "buzz.inbound-dedupe";
const THREAD_ROOT_CACHE_MAX_ENTRIES = 1_024;

export interface BuzzBus {
  publicKey: string;
  directory: BuzzDirectoryState;
  refreshDirectory: () => Promise<void>;
  isBotOwnedThread: (params: { channelId: string; threadId: string }) => Promise<boolean>;
  sendText: (params: {
    channelId: string;
    text: string;
    threadId?: string;
    replyToId?: string;
  }) => Promise<string>;
  sendTyping: (params: {
    channelId: string;
    threadId?: string;
    replyToId?: string;
  }) => Promise<void>;
  close: () => Promise<void>;
}

function buildBuzzTextEvent(params: {
  secretKey: Uint8Array;
  channelId: string;
  text: string;
  threadId?: string;
  replyToId?: string;
  mentionedPubkeys?: string[];
}): Event {
  return finalizeEvent(
    {
      kind: BUZZ_NORMAL_MESSAGE_KIND,
      content: params.text,
      created_at: Math.floor(Date.now() / 1000),
      tags: buildBuzzMessageTags(params),
    },
    params.secretKey,
  );
}

export async function sendBuzzTextOneShot(params: {
  relayUrl: string;
  privateKey: string;
  authTag?: string;
  channelId: string;
  text: string;
  threadId?: string;
  replyToId?: string;
}): Promise<string> {
  const effect = captureEffectAuthority();
  const secretKey = decodeBuzzPrivateKey(params.privateKey);
  const mentionSyntax = inspectBuzzMentionSyntax(params.text);
  const needsDirectory = mentionSyntax.hasAtMention || mentionSyntax.hasExplicitIdentity;
  const signal = needsDirectory ? AbortSignal.timeout(30_000) : undefined;
  const publicKey = needsDirectory ? resolveBuzzPublicKey(params.privateKey) : "";
  const connection = {
    relayUrl: params.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(params.authTag ?? ""),
  };
  const session = needsDirectory
    ? await connectAuthenticatedBuzzRelaySession({ ...connection, signal })
    : undefined;
  const relay = session?.relay ?? (await connectAuthenticatedBuzzRelay(connection));
  try {
    let mentionedPubkeys: string[] | undefined;
    if (session) {
      const directory = new BuzzDirectoryState({
        publicKey,
        fallbackProfileName: "OpenClaw",
        channelIds: [params.channelId],
      });
      directory.replaceMemberships(
        await queryBuzzRoomMemberships({
          relay,
          relayPublicKey: session.relayPublicKey,
          channelIds: [params.channelId],
          signal,
        }),
      );
      if (mentionSyntax.hasAtMention) {
        await queryBuzzDirectoryProfiles({
          relay,
          state: directory,
          publicKeys: directory.profilePublicKeys(),
          signal,
        });
      }
      mentionedPubkeys = resolveBuzzMessageMentions({
        text: params.text,
        members: directory.mentionMembers(params.channelId),
        senderPublicKey: publicKey,
      });
    }
    const event = buildBuzzTextEvent({ ...params, secretKey, mentionedPubkeys });
    await effect.initiate(() => {
      signal?.throwIfAborted();
      return relay.publish(event);
    });
    return event.id;
  } finally {
    relay.close();
  }
}

export async function startBuzzBus(options: {
  scheduler: PluginServiceSchedulerV1;
  accountId: string;
  relayUrl: string;
  privateKey: string;
  authTag?: string;
  channelIds: string[];
  since?: (channelId: string) => number;
  onMessage: (
    message: BuzzInboundMessage,
    bus: BuzzBus,
    signal: AbortSignal,
    assertCurrent: () => void,
  ) => Promise<void>;
  onMessageError?: (error: Error) => void;
  onFatalError?: (error: Error) => void;
  onDedupeError?: (error: Error) => void;
  onHistoryError?: (error: Error) => void;
  onRoomUnavailable?: (error: Error) => void;
  onPresenceError?: (error: Error) => void;
  profileName?: string;
  onProfilePublished?: (eventId: string) => void;
  onProfileError?: (error: Error) => void;
  onDirectoryError?: (error: Error) => void;
  onRoomDirectoryChanged?: () => void;
  signal?: AbortSignal;
}): Promise<BuzzBus> {
  const subscriptionBudget = resolveBuzzSubscriptionBudget(options.channelIds.length);
  const secretKey = decodeBuzzPrivateKey(options.privateKey);
  const publicKey = resolveBuzzPublicKey(options.privateKey);
  const authTag = parseBuzzAuthTag(options.authTag ?? "");
  const sessionStartedAt = Math.floor(Date.now() / 1000);
  const lifecycleAbort = new AbortController();
  const presenceScheduler = options.scheduler.scope();
  const signal = AbortSignal.any([
    lifecycleAbort.signal,
    presenceScheduler.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const reportFatalError = (error: Error) => {
    if (signal.aborted) {
      return;
    }
    lifecycleAbort.abort(error);
    options.onFatalError?.(error);
  };
  const replayGuard = createChannelReplayGuard<Event>({
    dedupe: {
      pluginId: "buzz",
      namespacePrefix: REPLAY_NAMESPACE_PREFIX,
      ttlMs: REPLAY_TTL_MS,
      memoryMaxSize: REPLAY_MAX_ENTRIES,
      stateMaxEntries: REPLAY_STATE_MAX_ENTRIES,
      onDiskError: (error) => {
        options.onDedupeError?.(error instanceof Error ? error : new Error(String(error)));
      },
    },
    buildReplayKey: (event) => event.id,
    namespace: () => options.accountId,
  });
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: options.relayUrl,
    secretKey,
    authTag,
    signal,
  });
  const dispatchQueue = createBuzzReplayDispatchQueue({
    onTaskError: (error) => {
      options.onMessageError?.(error instanceof Error ? error : new Error(String(error)));
    },
  });
  const directory = new BuzzDirectoryState({
    publicKey,
    fallbackProfileName: options.profileName ?? "OpenClaw",
    channelIds: options.channelIds,
    profileLimit: subscriptionBudget.profileLimit,
  });
  let directoryRelay: ReturnType<typeof startBuzzDirectoryRelay> | undefined;
  let profileTask: Promise<void> | undefined;
  let membershipTracker: Awaited<ReturnType<typeof createBuzzRoomMembershipTracker>> | undefined;
  const threadRoots = new Map<string, { channelId: string; isBotOwned: boolean }>();
  const rememberThreadRoot = (event: Event) => {
    const root = parseBuzzMessageEvent(event);
    if (!root || root.threadId || !verifyEvent(event)) {
      return;
    }
    threadRoots.set(event.id, {
      channelId: root.channelId.toLowerCase(),
      isBotOwned: event.pubkey === publicKey,
    });
    if (threadRoots.size > THREAD_ROOT_CACHE_MAX_ENTRIES) {
      const oldest = threadRoots.keys().next().value;
      if (oldest) {
        threadRoots.delete(oldest);
      }
    }
  };
  const bus: BuzzBus = {
    publicKey,
    directory,
    refreshDirectory: async () => await directoryRelay?.refreshRooms(options.channelIds),
    isBotOwnedThread: async ({ channelId, threadId }) => {
      signal.throwIfAborted();
      if (!threadRoots.has(threadId)) {
        try {
          await queryBuzzRelaySnapshot({
            relay,
            filters: [{ ids: [threadId], kinds: [...BUZZ_INBOUND_MESSAGE_KINDS], limit: 1 }],
            signal,
            timeoutMessage: "Timed out loading Buzz thread root",
            abortMessage: "Buzz thread root query aborted",
            failureMessage: "Buzz thread root query failed",
            closeReason: "thread root loaded",
            closeMessage: (reason) => `Buzz thread root query closed: ${reason}`,
            onEvent: (event) => {
              if (event.id === threadId) {
                rememberThreadRoot(event);
              }
            },
            result: () => {},
            onTimeout: reportFatalError,
            checkAbortAfterSubscribe: true,
          });
        } catch (error) {
          signal.throwIfAborted();
          options.onMessageError?.(
            error instanceof Error
              ? error
              : new Error("Buzz thread root query failed", { cause: error }),
          );
          return false;
        }
      }
      signal.throwIfAborted();
      const root = threadRoots.get(threadId);
      return root?.channelId === channelId && root.isBotOwned;
    },
    sendText: async ({ channelId, text, threadId, replyToId }) => {
      const effect = captureEffectAuthority();
      signal.throwIfAborted();
      const mentionSyntax = inspectBuzzMentionSyntax(text);
      const mentionedPubkeys =
        mentionSyntax.hasAtMention || mentionSyntax.hasExplicitIdentity
          ? resolveBuzzMessageMentions({
              text,
              members: directory.mentionMembers(channelId),
              senderPublicKey: publicKey,
            })
          : [];
      const event = buildBuzzTextEvent({
        secretKey,
        channelId,
        text,
        threadId,
        replyToId,
        mentionedPubkeys,
      });
      await effect.initiate(() => {
        signal.throwIfAborted();
        return relay.publish(event);
      });
      rememberThreadRoot(event);
      return event.id;
    },
    sendTyping: async ({ channelId, threadId, replyToId }) => {
      if (signal.aborted || !relay.connected) {
        return;
      }
      const event = finalizeEvent(
        {
          kind: BUZZ_TYPING_INDICATOR_KIND,
          content: "",
          created_at: Math.floor(Date.now() / 1000),
          tags: buildBuzzMessageTags({ channelId, threadId, replyToId }),
        },
        secretKey,
      );
      await captureEffectAuthority().initiate(() => {
        signal.throwIfAborted();
        return relay.send(JSON.stringify(["EVENT", event]));
      });
    },
    close: async () => {
      lifecycleAbort.abort(new Error("Buzz bus closed"));
      presenceScheduler.beginClose();
      // Abort this generation's agent turns before draining stale work.
      await dispatchQueue.close();
      directoryRelay?.close();
      replayGuard.clearMemory();
      threadRoots.clear();
      relay.close();
      await membershipTracker?.close();
      // Relay close rejects pending publishes; join their continuations afterward.
      await Promise.all([presenceScheduler.stop(), profileTask]);
    },
  };

  try {
    await queryBuzzDirectoryRooms({
      relay,
      relayPublicKey,
      state: directory,
      channelIds: options.channelIds,
      signal,
    });
    const activeChannelIds = directory.activeRoomIds();
    directoryRelay = startBuzzDirectoryRelay({
      relay,
      relayPublicKey,
      state: directory,
      subscribedRoomIds: new Set(activeChannelIds),
      signal,
      onError: options.onDirectoryError,
      onFatalError: reportFatalError,
      onRoomChanged: options.onRoomDirectoryChanged,
    });
    startBuzzRoomMembershipNotifications({
      relay,
      relayPublicKey,
      botPublicKey: publicKey,
      configuredRoomIds: options.channelIds,
      since: sessionStartedAt,
      signal,
      onNotification: (notification) =>
        membershipTracker?.handleNotification(notification) ?? false,
      onFatalError: reportFatalError,
    });
    membershipTracker =
      activeChannelIds.length > 0
        ? await createBuzzRoomMembershipTracker({
            relay,
            relayPublicKey,
            channelIds: activeChannelIds,
            botPublicKey: publicKey,
            since: sessionStartedAt,
            messageSince: (channelId) => options.since?.(channelId) ?? sessionStartedAt,
            messageLimit: resolveBuzzRoomHistoryLimit(activeChannelIds.length),
            reserveDispatchCapacity: (slots) => dispatchQueue.reserveCapacity(slots),
            onHistoryError: options.onHistoryError,
            onRoomUnavailable: options.onRoomUnavailable,
            onMessageEvent: (event, isMember, reservation) => {
              if (signal.aborted) {
                return;
              }
              if (event.pubkey === publicKey) {
                rememberThreadRoot(event);
                return;
              }
              const message = parseBuzzMessageEvent(event);
              if (!message || !isMember(message.channelId, event.pubkey)) {
                return;
              }
              // Admit only room members to bounded workers; claim replay dedupe inside
              // each worker so queued history cannot create unbounded in-flight state.
              const admission = (reservation ?? dispatchQueue).enqueue(async () => {
                await replayGuard.processGuarded(event, async () => {
                  const assertCurrent = () => {
                    signal.throwIfAborted();
                    if (!isMember(message.channelId, event.pubkey)) {
                      throw new Error("Buzz sender is no longer a room member");
                    }
                  };
                  // Queue waits and dedupe claims can outlive signed membership changes.
                  // Throw rather than commit a cancelled message as successfully processed.
                  assertCurrent();
                  await options.onMessage(message, bus, signal, assertCurrent);
                });
              });
              if (admission !== "overflow") {
                return;
              }
              if (reservation) {
                options.onHistoryError?.(
                  new Error(
                    `Buzz room ${message.channelId} returned more history than the ${BUZZ_REPLAY_DISPATCH_MAX_PENDING}-message pending limit allows`,
                  ),
                );
                return;
              }
              void dispatchQueue.close();
              reportFatalError(
                new Error(
                  `Buzz inbound replay exceeded the ${BUZZ_REPLAY_DISPATCH_MAX_PENDING}-message pending limit`,
                ),
              );
            },
            onFatalError: reportFatalError,
            onMembershipsChanged: (memberships) => {
              if (directory.replaceMemberships(memberships)) {
                directoryRelay?.replaceProfilePublicKeys(directory.profilePublicKeys());
              }
            },
            onRoomMetadataChanged: (channelId) => {
              void directoryRelay?.refreshRooms([channelId]).catch((error: unknown) => {
                if (!signal.aborted) {
                  options.onDirectoryError?.(
                    error instanceof Error
                      ? error
                      : new Error("Buzz room directory refresh failed", { cause: error }),
                  );
                }
              });
            },
            signal,
          })
        : undefined;
    directory.replaceMemberships(membershipTracker?.memberships() ?? new Map());
    directoryRelay.replaceProfilePublicKeys(directory.profilePublicKeys());
    void membershipTracker?.catchUpHistory();
    let presenceErrorReported = false;
    presenceScheduler.schedule({
      id: "presence",
      delayMs: 0,
      everyMs: PRESENCE_HEARTBEAT_INTERVAL_MS,
      run: async () => {
        try {
          await relay.publish(
            finalizeEvent(
              {
                kind: PRESENCE_KIND,
                content: "online",
                created_at: Math.floor(Date.now() / 1000),
                tags: [],
              },
              secretKey,
            ),
          );
          presenceErrorReported = false;
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          const failure =
            error instanceof Error
              ? error
              : new Error("Buzz presence heartbeat failed", { cause: error });
          // nostr-tools rejects an unacknowledged publish without closing its socket.
          if (failure.message === "publish timed out") {
            reportFatalError(failure);
          } else if (!presenceErrorReported) {
            presenceErrorReported = true;
            options.onPresenceError?.(failure);
          }
        }
      },
    });
    if (options.profileName?.trim()) {
      profileTask = syncBuzzProfile({
        relay,
        secretKey,
        publicKey,
        displayName: options.profileName,
        authTag,
        onFatalError: reportFatalError,
        signal,
      })
        .then((eventId) => {
          if (!signal.aborted && eventId !== undefined) {
            options.onProfilePublished?.(eventId);
          }
        })
        .catch((error: unknown) => {
          if (signal.aborted) {
            return;
          }
          options.onProfileError?.(
            error instanceof Error
              ? error
              : new Error("Buzz profile sync failed", { cause: error }),
          );
        });
    }

    return bus;
  } catch (error) {
    lifecycleAbort.abort(error);
    presenceScheduler.beginClose();
    await dispatchQueue.close();
    directoryRelay?.close();
    relay.close();
    await presenceScheduler.stop();
    throw error;
  }
}
