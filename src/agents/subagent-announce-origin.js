import { resolveComparableTargetForLoadedChannel } from "../channels/plugins/target-parsing-loaded.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, normalizeOptionalThreadValue, } from "../shared/string-coerce.js";
import { isInternalMessageChannel } from "../utils/message-channel.js";
function normalizeDeliveryContext(context) {
    if (!context) {
        return undefined;
    }
    const normalized = {
        channel: normalizeOptionalLowercaseString(context.channel),
        to: normalizeOptionalString(context.to),
        accountId: normalizeOptionalString(context.accountId),
    };
    const threadId = normalizeOptionalThreadValue(context.threadId);
    if (threadId != null) {
        normalized.threadId = threadId;
    }
    if (!normalized.channel &&
        !normalized.to &&
        !normalized.accountId &&
        normalized.threadId == null) {
        return undefined;
    }
    return normalized;
}
function mergeDeliveryContext(primary, fallback) {
    const normalizedPrimary = normalizeDeliveryContext(primary);
    const normalizedFallback = normalizeDeliveryContext(fallback);
    if (!normalizedPrimary && !normalizedFallback) {
        return undefined;
    }
    const channelsConflict = normalizedPrimary?.channel &&
        normalizedFallback?.channel &&
        normalizedPrimary.channel !== normalizedFallback.channel;
    return normalizeDeliveryContext({
        channel: normalizedPrimary?.channel ?? normalizedFallback?.channel,
        to: channelsConflict
            ? normalizedPrimary?.to
            : (normalizedPrimary?.to ?? normalizedFallback?.to),
        accountId: channelsConflict
            ? normalizedPrimary?.accountId
            : (normalizedPrimary?.accountId ?? normalizedFallback?.accountId),
        threadId: channelsConflict
            ? normalizedPrimary?.threadId
            : (normalizedPrimary?.threadId ?? normalizedFallback?.threadId),
    });
}
function deliveryContextFromSession(entry) {
    if (!entry) {
        return undefined;
    }
    return normalizeDeliveryContext({
        channel: entry.deliveryContext?.channel ??
            entry.lastChannel ??
            entry.channel ??
            entry.origin?.provider,
        to: entry.deliveryContext?.to ?? entry.lastTo,
        accountId: entry.deliveryContext?.accountId ?? entry.lastAccountId ?? entry.origin?.accountId,
        threadId: entry.deliveryContext?.threadId ?? entry.lastThreadId ?? entry.origin?.threadId,
    });
}
function stripThreadRouteSuffix(target) {
    return /^(.*):topic:[^:]+$/u.exec(target)?.[1] ?? target;
}
function normalizeAnnounceRouteTarget(context) {
    const rawTo = normalizeOptionalString(context?.to);
    if (!rawTo) {
        return undefined;
    }
    const channel = normalizeOptionalLowercaseString(context?.channel);
    const parsed = channel
        ? resolveComparableTargetForLoadedChannel({
            channel,
            rawTarget: rawTo,
            fallbackThreadId: context?.threadId,
        })
        : null;
    let route = stripThreadRouteSuffix(parsed?.to ?? rawTo);
    if (channel && route.toLowerCase().startsWith(`${channel}:`)) {
        route = route.slice(channel.length + 1);
    }
    if (route.startsWith("group:") || route.startsWith("channel:")) {
        route = route.slice(route.indexOf(":") + 1);
    }
    return route || undefined;
}
function shouldStripThreadFromAnnounceEntry(normalizedRequester, normalizedEntry) {
    if (!normalizedRequester?.to ||
        normalizedRequester.threadId != null ||
        normalizedEntry?.threadId == null) {
        return false;
    }
    const requesterTarget = normalizeAnnounceRouteTarget(normalizedRequester);
    const entryTarget = normalizeAnnounceRouteTarget(normalizedEntry);
    if (requesterTarget && entryTarget) {
        return requesterTarget !== entryTarget;
    }
    return false;
}
export function resolveAnnounceOrigin(entry, requesterOrigin) {
    const normalizedRequester = normalizeDeliveryContext(requesterOrigin);
    const normalizedEntry = deliveryContextFromSession(entry);
    if (normalizedRequester?.channel && isInternalMessageChannel(normalizedRequester.channel)) {
        return mergeDeliveryContext({
            accountId: normalizedRequester.accountId,
            threadId: normalizedRequester.threadId,
        }, normalizedEntry);
    }
    const entryForMerge = normalizedEntry && shouldStripThreadFromAnnounceEntry(normalizedRequester, normalizedEntry)
        ? (() => {
            const { threadId: _ignore, ...rest } = normalizedEntry;
            return rest;
        })()
        : normalizedEntry;
    return mergeDeliveryContext(normalizedRequester, entryForMerge);
}
