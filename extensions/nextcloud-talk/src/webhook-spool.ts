import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePersistentDedupePluginStateNamespace } from "openclaw/plugin-sdk/persistent-dedupe";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
} from "./replay-migration-contract.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import type { NextcloudTalkInboundMessage } from "./types.js";
import {
  describeIgnoredWebhookEvent,
  inspectNextcloudTalkWebhookEnvelope,
  NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION,
  NextcloudTalkWebhookPayloadError,
  parseClaimedMessage,
  type NextcloudTalkIngressPayload,
  type NextcloudTalkLegacyReplayEntry,
  type NextcloudTalkLegacyReplayStore,
} from "./webhook-spool-state.js";

const NEXTCLOUD_TALK_INGRESS_POLL_INTERVAL_MS = 500;

export type NextcloudTalkIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

function resolveNonRetryableFailure(error: unknown) {
  if (error instanceof NextcloudTalkWebhookPayloadError) {
    return { reason: "invalid-event", message: error.message };
  }
  const message = formatErrorMessage(error);
  if (
    message.includes("Nextcloud Talk: bot send was rejected") ||
    message.includes("Nextcloud Talk: forbidden")
  ) {
    return { reason: "nextcloud-talk-auth", message };
  }
  return null;
}

function parseLegacyReplayKey(key: string): { messageId: string; roomId: string } | null {
  const separator = key.lastIndexOf(":");
  const roomId = key.slice(0, separator).trim();
  const messageId = key.slice(separator + 1).trim();
  return separator > 0 && roomId && messageId ? { messageId, roomId } : null;
}

/** Convert the shipped replay guard's live window into durable completion tombstones. */
async function migrateNextcloudTalkLegacyReplayState(params: {
  queue: ChannelIngressQueue<NextcloudTalkIngressPayload>;
  store: NextcloudTalkLegacyReplayStore;
}): Promise<void> {
  const entries = await params.store.entries();
  for (const entry of entries) {
    const identity = parseLegacyReplayKey(entry.value.key);
    if (!identity || !Number.isFinite(entry.value.seenAt)) {
      continue;
    }
    const marker: NextcloudTalkIngressPayload = {
      version: NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION,
      receivedAt: entry.value.seenAt,
      rawEvent: "",
    };
    const result = await params.queue.enqueue(identity.messageId, marker, {
      receivedAt: entry.value.seenAt,
      laneKey: `room:${identity.roomId}`,
    });
    const ownsMarker =
      result.kind === "accepted" ||
      (result.kind === "pending" && result.record.payload.rawEvent === "");
    if (ownsMarker) {
      const completed = await params.queue.complete(identity.messageId, {
        completedAt: entry.value.seenAt,
      });
      if (!completed) {
        throw new Error(`Failed to migrate Nextcloud Talk replay key ${entry.value.key}.`);
      }
    }
  }
  await params.store.clear();
}

export function createNextcloudTalkWebhookSpool(options: {
  accountId: string;
  queue?: ChannelIngressQueue<NextcloudTalkIngressPayload>;
  deliver: (
    message: NextcloudTalkInboundMessage,
    lifecycle: NextcloudTalkIngressLifecycle,
  ) => Promise<void>;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
  legacyReplayStore?: NextcloudTalkLegacyReplayStore | null;
}) {
  let queue = options.queue;

  const getQueue = (): ChannelIngressQueue<NextcloudTalkIngressPayload> => {
    queue ??= getNextcloudTalkRuntime().state.openChannelIngressQueue<NextcloudTalkIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const legacyReplayStore =
    options.legacyReplayStore === null
      ? null
      : (options.legacyReplayStore ??
        getNextcloudTalkRuntime().state.openKeyedStore<NextcloudTalkLegacyReplayEntry>({
          namespace: resolvePersistentDedupePluginStateNamespace({
            namespace: options.accountId,
            namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
          }),
          maxEntries: NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
          defaultTtlMs: NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
        }));
  const legacyMigration = legacyReplayStore
    ? migrateNextcloudTalkLegacyReplayState({ queue: getQueue(), store: legacyReplayStore })
    : Promise.resolve();

  const monitor = createChannelIngressMonitor<
    string,
    Omit<NextcloudTalkIngressPayload, "version">,
    NextcloudTalkIngressPayload
  >({
    queue: getQueue,
    inspect: inspectNextcloudTalkWebhookEnvelope,
    inspectAsync: async (rawEvent) => {
      await startAfterMigration;
      return inspectNextcloudTalkWebhookEnvelope(rawEvent);
    },
    payload: {
      version: NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION,
      serialize: (rawEvent, { receivedAt }) => ({ receivedAt, rawEvent }),
      deserialize: (body) => body.rawEvent,
      encode: ({ body }) => ({ version: NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload) => ({
        version: payload.version,
        body: { receivedAt: payload.receivedAt, rawEvent: payload.rawEvent },
      }),
      createClaimError: (kind, claim) =>
        new NextcloudTalkWebhookPayloadError(
          kind === "invalid-version"
            ? `Nextcloud Talk ingress row ${claim.id} has an unsupported version.`
            : `Nextcloud Talk ingress row ${claim.id} has invalid message identity.`,
        ),
    },
    deliver: async (_rawEvent, lifecycle, claim) => {
      const message = parseClaimedMessage(claim.payload, claim.id);
      // The shared monitor translates these lifecycle callbacks into terminal or deferred
      // drain outcomes, including successful no-dispatch policy gates.
      await options.deliver(message, lifecycle);
    },
    pollIntervalMs: options.pollIntervalMs ?? NEXTCLOUD_TALK_INGRESS_POLL_INTERVAL_MS,
    retention: {
      completedMaxEntries: 10_000,
      failedMaxEntries: 10_000,
    },
    drain: {
      startLimit: 32, // Keep the shared drain's active-delivery ceiling across repumps.
      resolveNonRetryableFailure,
      adoptionStallTimeoutMs: options.adoptionStallTimeoutMs,
      onLog: (message) => options.runtime.log?.(`nextcloud-talk ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Nextcloud Talk ingress stopped"),
    onError: (error) =>
      options.runtime.error?.(`nextcloud-talk ingress drain failed: ${formatErrorMessage(error)}`),
  });
  let stopping = false;
  const startAfterMigration = legacyMigration.then(() => {
    if (!stopping) {
      monitor.start();
    }
  });

  return {
    ready: async () => await startAfterMigration,
    receive: (rawEvent: string) => {
      if (stopping) {
        return Promise.reject(new Error("Nextcloud Talk ingress stopped"));
      }
      return monitor.admit(rawEvent).then((result): "accepted" | "ignored" => {
        if (result.kind === "ignored") {
          // These events are acknowledged without a durable row. Keep that intentional
          // non-outcome visible without inventing message content for the agent.
          options.runtime.log?.(
            `nextcloud-talk: ignored non-message webhook event (${describeIgnoredWebhookEvent(rawEvent)})`,
          );
          return "ignored";
        }
        return "accepted";
      });
    },
    stop: async () => {
      stopping = true;
      // Quiesce synchronously, but let callbacks accepted before stop finish durable admission.
      const pauseTask = monitor.pause();
      await startAfterMigration.catch(() => undefined);
      await monitor.stop();
      await pauseTask;
    },
    waitForIdle: async () => {
      await startAfterMigration.catch(() => undefined);
      await monitor.waitForIdle();
    },
  };
}
