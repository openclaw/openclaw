import { finalizeEvent, type Event, type Relay } from "nostr-tools";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { isNewerBuzzRevision } from "../event-order.js";
import {
  BUZZ_NORMAL_MESSAGE_KIND,
  buildBuzzMessageTags,
  parseBuzzMessageEvent,
  type BuzzInboundMessage,
} from "../message-event.js";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "../relay-auth.js";
import { openBuzzRelaySubscription, queryBuzzRelaySnapshot } from "../relay-subscription.js";
import {
  BUZZ_ROOM_MEMBERSHIP_KIND,
  parseBuzzRoomMembershipEvent,
  type BuzzRoomMembership,
} from "../room-membership.js";
import { decodeBuzzPrivateKey } from "../types.js";
import type { BuzzQaCredentials } from "./credentials.js";

const OBSERVER_READY_TIMEOUT_MS = 10_000;

async function loadBuzzQaRoomMembership(params: {
  relay: Relay;
  relayPublicKey: string;
  roomId: string;
}): Promise<BuzzRoomMembership> {
  let latest: BuzzRoomMembership | undefined;
  await queryBuzzRelaySnapshot({
    relay: params.relay,
    filters: [
      {
        kinds: [BUZZ_ROOM_MEMBERSHIP_KIND],
        authors: [params.relayPublicKey],
        "#d": [params.roomId],
        limit: 1,
      },
    ],
    timeoutMessage: `Timed out loading Buzz QA room ${params.roomId} membership.`,
    abortMessage: "Buzz QA membership query aborted",
    closeReason: "membership loaded",
    closeMessage: (reason) => `Buzz QA membership subscription closed: ${reason}`,
    onEvent: (event) => {
      const membership = parseBuzzRoomMembershipEvent(event, params.relayPublicKey);
      if (membership?.roomId === params.roomId && isNewerBuzzRevision(membership, latest)) {
        latest = membership;
      }
    },
    result: () => {},
  });
  if (!latest) {
    throw new Error(`Buzz QA room ${params.roomId} has no membership roster.`);
  }
  return latest;
}

function assertBuzzQaMembership(membership: BuzzRoomMembership, credentials: BuzzQaCredentials) {
  if (!membership.members.has(credentials.driverPublicKey)) {
    throw new Error(
      `Buzz QA driver ${credentials.driverPublicKey} is not a member of room ${credentials.roomId}.`,
    );
  }
  if (
    !membership.members.has(credentials.sutPublicKey) ||
    membership.roles.get(credentials.sutPublicKey) !== "bot"
  ) {
    throw new Error(
      `Buzz QA SUT ${credentials.sutPublicKey} must have the Bot role in room ${credentials.roomId}.`,
    );
  }
}

export async function createBuzzQaRelayDriver(params: {
  credentials: BuzzQaCredentials;
  onMessage: (message: BuzzInboundMessage) => Promise<void>;
}) {
  const credentials = params.credentials;
  const secretKey = decodeBuzzPrivateKey(credentials.driverPrivateKey);
  const lifecycleAbort = new AbortController();
  let transportError: Error | undefined;
  let messageQueue = Promise.resolve();
  const observedEventIds = new Set<string>();
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: credentials.relayUrl,
    secretKey,
    authTag: parseBuzzAuthTag(credentials.driverAuthTag ?? ""),
    signal: lifecycleAbort.signal,
  });
  try {
    assertBuzzQaMembership(
      await loadBuzzQaRoomMembership({
        relay,
        relayPublicKey,
        roomId: credentials.roomId,
      }),
      credentials,
    );
  } catch (error) {
    lifecycleAbort.abort(error);
    relay.close();
    throw error;
  }

  let observerReady = false;
  const readiness = createDeferred();
  const observerReadyTimeout = setTimeout(() => {
    readiness.reject(new Error("Timed out waiting for the Buzz QA message observer."));
  }, OBSERVER_READY_TIMEOUT_MS);
  let subscription: ReturnType<Relay["prepareSubscription"]>;
  try {
    subscription = openBuzzRelaySubscription(
      relay,
      [
        {
          kinds: [BUZZ_NORMAL_MESSAGE_KIND],
          authors: [credentials.sutPublicKey],
          "#h": [credentials.roomId],
          since: Math.floor(Date.now() / 1_000) - 5,
        },
      ],
      {
        onevent: (event: Event) => {
          if (!observerReady) {
            return;
          }
          if (observedEventIds.has(event.id)) {
            return;
          }
          observedEventIds.add(event.id);
          const message = parseBuzzMessageEvent(event);
          if (
            !message ||
            message.channelId !== credentials.roomId ||
            message.senderPubkey !== credentials.sutPublicKey
          ) {
            return;
          }
          messageQueue = messageQueue
            .then(async () => await params.onMessage(message))
            .catch((error: unknown) => {
              transportError = error instanceof Error ? error : new Error(String(error));
            });
        },
        oneose: () => {
          observerReady = true;
          clearTimeout(observerReadyTimeout);
          readiness.resolve();
        },
        onclose: (reason) => {
          if (!observerReady) {
            clearTimeout(observerReadyTimeout);
            readiness.reject(
              new Error(`Buzz QA message observer closed before it was ready: ${reason}`),
            );
            return;
          }
          if (reason !== "shutdown" && reason !== "relay connection closed by us") {
            transportError = new Error(`Buzz QA message subscription closed: ${reason}`);
          }
        },
      },
    );
  } catch (error) {
    clearTimeout(observerReadyTimeout);
    lifecycleAbort.abort(error);
    relay.close();
    throw error;
  }
  try {
    await readiness.promise;
  } catch (error) {
    lifecycleAbort.abort(error);
    relay.close();
    throw error;
  }

  return {
    assertHealthy() {
      if (transportError) {
        throw transportError;
      }
    },
    async sendMessage(input: {
      text: string;
      mentionSut: boolean;
      threadId?: string;
      replyToId?: string;
    }) {
      if (transportError) {
        throw transportError;
      }
      const tags = buildBuzzMessageTags({
        channelId: credentials.roomId,
        threadId: input.threadId,
        replyToId: input.replyToId,
      });
      if (input.mentionSut) {
        tags.push(["p", credentials.sutPublicKey]);
      }
      const event = finalizeEvent(
        {
          kind: BUZZ_NORMAL_MESSAGE_KIND,
          content: input.text,
          created_at: Math.floor(Date.now() / 1_000),
          tags,
        },
        secretKey,
      );
      await relay.publish(event);
      return { eventId: event.id, timestamp: event.created_at * 1_000 };
    },
    async close() {
      lifecycleAbort.abort(new Error("Buzz QA relay driver closed"));
      subscription.close("shutdown");
      relay.close();
      await messageQueue;
    },
  };
}
