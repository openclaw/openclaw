/**
 * Subagent announcement origin resolver.
 *
 * Merges requester and session delivery context while avoiding stale thread ids after retargeting.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getLoadedChannelPluginForRead } from "../channels/plugins/registry-loaded-read.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { lookupDeliveryLease } from "../infra/delivery-lease-store.js";
import {
  stripTargetKindPrefix,
  stripTargetProviderPrefix,
  stripTargetTopicSuffix,
} from "../infra/outbound/channel-target-prefix.js";
import {
  deliveryContextFromSession,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import type {
  DeliveryContext,
  DeliveryContextSessionSource,
} from "../utils/delivery-context.types.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
export type { DeliveryContext } from "../utils/delivery-context.types.js";

function normalizeAnnounceRouteTarget(context?: DeliveryContext): string | undefined {
  const rawTo = normalizeOptionalString(context?.to);
  if (!rawTo) {
    return undefined;
  }
  const channel = normalizeOptionalString(context?.channel);
  const messaging = channel
    ? getLoadedChannelPluginForRead(channel as ChannelId)?.messaging
    : undefined;
  const route = stripTargetTopicSuffix(
    stripTargetKindPrefix(stripTargetProviderPrefix(rawTo, channel ?? ""), ["group", "channel"]),
  );
  const normalized = messaging?.normalizeTarget?.(route) ?? route;
  return normalized || undefined;
}

function shouldStripThreadFromAnnounceEntry(
  normalizedRequester?: DeliveryContext,
  normalizedEntry?: DeliveryContext,
): boolean {
  if (
    !normalizedRequester?.to ||
    normalizedRequester.threadId != null ||
    normalizedEntry?.threadId == null
  ) {
    return false;
  }
  const requesterTarget = normalizeAnnounceRouteTarget(normalizedRequester);
  const entryTarget = normalizeAnnounceRouteTarget(normalizedEntry);
  if (requesterTarget && entryTarget) {
    return requesterTarget !== entryTarget;
  }
  return false;
}

/**
 * Resolve the delivery origin for a subagent completion announcement.
 *
 * When the session entry carries no delivery context (e.g. isolated cron
 * sessions that strip routing fields), an optional `sessionKey` provides a
 * fallback lookup into the in-memory delivery lease store.  This avoids
 * persisting a short-lived delivery route onto the session entry, preventing
 * the lifecycle leak described in PR #92580.
 */
export function resolveAnnounceOrigin(
  entry?: DeliveryContextSessionSource,
  requesterOrigin?: DeliveryContext,
  sessionKey?: string,
): DeliveryContext | undefined {
  const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
  let normalizedEntry = deliveryContextFromSession(entry);

  // Fallback: when the session entry has no delivery context, check for an
  // active delivery lease (e.g. from an isolated cron run).
  if (!normalizedEntry && sessionKey) {
    const leaseContext = lookupDeliveryLease(sessionKey);
    normalizedEntry = normalizeDeliveryContext(leaseContext);
  }

  if (normalizedRequester?.channel && isInternalMessageChannel(normalizedRequester.channel)) {
    return mergeDeliveryContext(
      {
        accountId: normalizedRequester.accountId,
        threadId: normalizedRequester.threadId,
      },
      normalizedEntry,
    );
  }
  const entryForMerge =
    normalizedEntry && shouldStripThreadFromAnnounceEntry(normalizedRequester, normalizedEntry)
      ? (() => {
          // A stored thread only applies to the same normalized route target.
          const { threadId: _ignore, ...rest } = normalizedEntry;
          return rest;
        })()
      : normalizedEntry;
  return mergeDeliveryContext(normalizedRequester, entryForMerge);
}
