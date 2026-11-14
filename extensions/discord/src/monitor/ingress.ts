// Discord plugin module owns raw gateway-message durable ingress and replay draining.
import type { GatewayMessageCreateDispatchData } from "discord-api-types/v10";
import { prepareChannelIngressEvent } from "openclaw/plugin-sdk/channel-ingress-runtime";
import {
  createChannelIngressError,
  createChannelIngressMonitor,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressQueue,
  type ChannelIngressMonitorDeliveryResult,
  type ChannelIngressMonitorLifecycle,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { danger, type RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeNullableString as nonEmptyString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { Client } from "../internal/discord.js";
import { createMessageDispatchData } from "../internal/gateway-dispatch.js";
import { getDiscordRuntime } from "../runtime.js";
import type { DiscordMessageEvent } from "./listeners.js";

const DISCORD_INGRESS_PAYLOAD_VERSION = 1;
const DISCORD_INGRESS_DRAIN_INTERVAL_MS = 1_000;

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: GatewayMessageCreateDispatchData;
};

type DiscordIngressBody = Omit<DiscordIngressPayload, "version">;

export type DiscordIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

export type DiscordIngressDispatchResult = ChannelIngressMonitorDeliveryResult;

type DiscordIngressDispatch = (
  event: DiscordMessageEvent,
  lifecycle: DiscordIngressLifecycle,
) => Promise<DiscordIngressDispatchResult | void> | DiscordIngressDispatchResult | void;

type DiscordIngressMonitor = {
  accept: (rawMessage: GatewayMessageCreateDispatchData) => Promise<void>;
  start: () => void;
  stop: () => Promise<void>;
};

const DiscordIngressPayloadError = createChannelIngressError("DiscordIngressPayloadError");

function inspectDiscordMessage(rawMessage: unknown): { eventId: string; laneKey: string } {
  if (!rawMessage || typeof rawMessage !== "object" || Array.isArray(rawMessage)) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload must be an object");
  }
  const candidate = rawMessage as { id?: unknown; channel_id?: unknown };
  const eventId = nonEmptyString(candidate.id);
  if (!eventId) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload is missing its snowflake");
  }
  const channelId = nonEmptyString(candidate.channel_id);
  if (!channelId) {
    throw new DiscordIngressPayloadError("Discord MESSAGE_CREATE payload is missing channel_id");
  }
  return { eventId, laneKey: `channel:${channelId}` };
}

function decodeDiscordIngressPayload(
  payload: unknown,
  claimedId: string,
): { version: unknown; body: DiscordIngressBody } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DiscordIngressPayloadError("Discord ingress payload must be an object");
  }
  const candidate = payload as Partial<DiscordIngressPayload>;
  try {
    inspectDiscordMessage(candidate.rawMessage);
  } catch (error) {
    throw new DiscordIngressPayloadError(`Discord ingress payload ${claimedId} is invalid`, {
      cause: error,
    });
  }
  return {
    version: candidate.version,
    body: {
      receivedAt: candidate.receivedAt as number,
      rawMessage: candidate.rawMessage as GatewayMessageCreateDispatchData,
    },
  };
}

function isDiscordAuthenticationFailure(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const candidate = current as { status?: unknown; statusCode?: unknown; cause?: unknown };
    if (candidate.status === 401 || candidate.statusCode === 401) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

export function createDiscordIngressMonitor(params: {
  accountId: string;
  botUserId?: string;
  client: Client;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  dispatch: DiscordIngressDispatch;
  onDeadLetter?: (event: DiscordMessageEvent, signal: AbortSignal) => Promise<void>;
  queue?: ChannelIngressQueue<DiscordIngressPayload>;
}): DiscordIngressMonitor {
  const queue =
    params.queue ??
    getDiscordRuntime().state.openChannelIngressQueue<DiscordIngressPayload>({
      accountId: params.accountId,
    });
  const monitor = createChannelIngressMonitor<
    GatewayMessageCreateDispatchData,
    DiscordIngressBody,
    DiscordIngressPayload
  >({
    queue,
    inspect: inspectDiscordMessage,
    prepareAdmission: async (rawMessage, { receivedAt, signal }) => {
      const prepared = await prepareChannelIngressEvent(rawMessage, {
        channelId: "discord",
        accountId: params.accountId,
        signal,
      });
      if (!prepared) {
        return undefined;
      }
      // The existing provider decoder admits transformed values under the same
      // identity contract as replayed transport payloads.
      const decoded = decodeDiscordIngressPayload(
        { version: DISCORD_INGRESS_PAYLOAD_VERSION, receivedAt, rawMessage: prepared.event },
        rawMessage.id,
      );
      return { raw: decoded.body.rawMessage, assertCurrent: prepared.assertCurrent };
    },
    payload: {
      version: DISCORD_INGRESS_PAYLOAD_VERSION,
      serialize: (rawMessage, { receivedAt }) => ({ receivedAt, rawMessage }),
      deserialize: (body) => body.rawMessage,
      encode: ({ body }) => ({ version: DISCORD_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload, { claim }) => decodeDiscordIngressPayload(payload, claim.id),
      createClaimError: (kind) =>
        new DiscordIngressPayloadError(
          kind === "invalid-version"
            ? "Discord ingress payload version is unsupported"
            : "Discord message identity changed after durable admission",
        ),
    },
    // Gateway mapping is intentionally delayed until after the durable claim.
    deliver: async (rawMessage, lifecycle) => {
      const event = createMessageDispatchData(params.client, rawMessage);
      return await params.dispatch(event, lifecycle);
    },
    pollIntervalMs: DISCORD_INGRESS_DRAIN_INTERVAL_MS,
    retention: {
      // Discord previously pruned before every enqueue rather than on a timed cadence.
      pruneIntervalMs: 0,
      completedMaxEntries: 5_000,
      failedMaxEntries: 5_000,
    },
    appendRetryDelaysMs: [0],
    drain: {
      // Native mentions can overtake recovery chatter; canonical preflight still
      // decides access and retains every ambient message for pending history.
      prioritizePending: ({ payload }) => {
        const raw = payload?.rawMessage;
        return Boolean(
          params.botUserId &&
          raw?.guild_id &&
          Date.parse(raw.timestamp) >= Date.now() - 15 * 60_000 &&
          Array.isArray(raw.mentions) &&
          raw.mentions.some((user) => user?.id === params.botUserId),
        );
      },
      deferredLaneOccupancy: "release",
      retryPolicy: {
        maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
        deadLetterMinAgeMs: 0,
      },
      resolveNonRetryableFailure: (error) => {
        if (error instanceof DiscordIngressPayloadError) {
          return { reason: "invalid-event", message: error.message };
        }
        if (isDiscordAuthenticationFailure(error)) {
          return { reason: "authentication-failed", message: formatErrorMessage(error) };
        }
        return null;
      },
      onDeadLetter: async (claim, _failure, signal) => {
        const { rawMessage } = decodeDiscordIngressPayload(claim.payload, claim.id).body;
        await params.onDeadLetter?.(createMessageDispatchData(params.client, rawMessage), signal);
      },
      onLog: (message) => params.runtime.error?.(danger(`discord ingress: ${message}`)),
    },
    onError: (error) =>
      params.runtime.error?.(danger(`discord ingress drain failed: ${formatErrorMessage(error)}`)),
  });

  return {
    accept: async (rawMessage) => {
      await monitor.admit(rawMessage);
    },
    start: monitor.start,
    stop: monitor.stop,
  };
}
