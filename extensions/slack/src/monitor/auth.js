import { readStoreAllowFromForDmPolicy } from "../../../../src/security/dm-policy-shared.js";
import {
  allowListMatches,
  normalizeAllowList,
  normalizeAllowListLower,
  resolveSlackUserAllowed
} from "./allow-list.js";
import { resolveSlackChannelConfig } from "./channel-config.js";
import { normalizeSlackChannelType } from "./context.js";
let slackAllowFromCache = /* @__PURE__ */ new WeakMap();
const DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS = 5e3;
function getPairingAllowFromCacheTtlMs() {
  const raw = process.env.OPENCLAW_SLACK_PAIRING_ALLOWFROM_CACHE_TTL_MS?.trim();
  if (!raw) {
    return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_PAIRING_ALLOW_FROM_CACHE_TTL_MS;
  }
  return Math.max(0, Math.floor(parsed));
}
function getAllowFromCacheState(ctx) {
  const existing = slackAllowFromCache.get(ctx);
  if (existing) {
    return existing;
  }
  const next = {};
  slackAllowFromCache.set(ctx, next);
  return next;
}
function buildBaseAllowFrom(ctx) {
  const allowFrom = normalizeAllowList(ctx.allowFrom);
  return {
    allowFrom,
    allowFromLower: normalizeAllowListLower(allowFrom)
  };
}
async function resolveSlackEffectiveAllowFrom(ctx, options) {
  const includePairingStore = options?.includePairingStore === true;
  const cache = getAllowFromCacheState(ctx);
  const baseSignature = JSON.stringify(ctx.allowFrom);
  if (cache.baseSignature !== baseSignature || !cache.base) {
    cache.baseSignature = baseSignature;
    cache.base = buildBaseAllowFrom(ctx);
    cache.pairing = void 0;
    cache.pairingKey = void 0;
    cache.pairingExpiresAtMs = void 0;
    cache.pairingPending = void 0;
  }
  if (!includePairingStore) {
    return cache.base;
  }
  const ttlMs = getPairingAllowFromCacheTtlMs();
  const nowMs = Date.now();
  const pairingKey = `${ctx.accountId}:${ctx.dmPolicy}`;
  if (ttlMs > 0 && cache.pairing && cache.pairingKey === pairingKey && (cache.pairingExpiresAtMs ?? 0) >= nowMs) {
    return cache.pairing;
  }
  if (cache.pairingPending && cache.pairingKey === pairingKey) {
    return await cache.pairingPending;
  }
  const pairingPending = (async () => {
    let storeAllowFrom = [];
    try {
      const resolved = await readStoreAllowFromForDmPolicy({
        provider: "slack",
        accountId: ctx.accountId,
        dmPolicy: ctx.dmPolicy
      });
      storeAllowFrom = Array.isArray(resolved) ? resolved : [];
    } catch {
      storeAllowFrom = [];
    }
    const allowFrom = normalizeAllowList([...cache.base?.allowFrom ?? [], ...storeAllowFrom]);
    return {
      allowFrom,
      allowFromLower: normalizeAllowListLower(allowFrom)
    };
  })();
  cache.pairingKey = pairingKey;
  cache.pairingPending = pairingPending;
  try {
    const resolved = await pairingPending;
    if (ttlMs > 0) {
      cache.pairing = resolved;
      cache.pairingExpiresAtMs = nowMs + ttlMs;
    } else {
      cache.pairing = void 0;
      cache.pairingExpiresAtMs = void 0;
    }
    return resolved;
  } finally {
    if (cache.pairingPending === pairingPending) {
      cache.pairingPending = void 0;
    }
  }
}
function clearSlackAllowFromCacheForTest() {
  slackAllowFromCache = /* @__PURE__ */ new WeakMap();
}
function isSlackSenderAllowListed(params) {
  const { allowListLower, senderId, senderName, allowNameMatching } = params;
  return allowListLower.length === 0 || allowListMatches({
    allowList: allowListLower,
    id: senderId,
    name: senderName,
    allowNameMatching
  });
}
async function authorizeSlackSystemEventSender(params) {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return { allowed: false, reason: "missing-sender" };
  }
  const expectedSenderId = params.expectedSenderId?.trim();
  if (expectedSenderId && expectedSenderId !== senderId) {
    return { allowed: false, reason: "sender-mismatch" };
  }
  const channelId = params.channelId?.trim();
  let channelType = normalizeSlackChannelType(params.channelType, channelId);
  let channelName;
  if (channelId) {
    const info = await params.ctx.resolveChannelName(channelId).catch(() => ({}));
    channelName = info.name;
    channelType = normalizeSlackChannelType(params.channelType ?? info.type, channelId);
    if (!params.ctx.isChannelAllowed({
      channelId,
      channelName,
      channelType
    })) {
      return {
        allowed: false,
        reason: "channel-not-allowed",
        channelType,
        channelName
      };
    }
  }
  const senderInfo = await params.ctx.resolveUserName(senderId).catch(() => ({}));
  const senderName = senderInfo.name;
  const resolveAllowFromLower = async (includePairingStore = false) => (await resolveSlackEffectiveAllowFrom(params.ctx, { includePairingStore })).allowFromLower;
  if (channelType === "im") {
    if (!params.ctx.dmEnabled || params.ctx.dmPolicy === "disabled") {
      return { allowed: false, reason: "dm-disabled", channelType, channelName };
    }
    if (params.ctx.dmPolicy !== "open") {
      const allowFromLower = await resolveAllowFromLower(true);
      const senderAllowListed = isSlackSenderAllowListed({
        allowListLower: allowFromLower,
        senderId,
        senderName,
        allowNameMatching: params.ctx.allowNameMatching
      });
      if (!senderAllowListed) {
        return {
          allowed: false,
          reason: "sender-not-allowlisted",
          channelType,
          channelName
        };
      }
    }
  } else if (!channelId) {
    const allowFromLower = await resolveAllowFromLower(false);
    if (allowFromLower.length > 0) {
      const senderAllowListed = isSlackSenderAllowListed({
        allowListLower: allowFromLower,
        senderId,
        senderName,
        allowNameMatching: params.ctx.allowNameMatching
      });
      if (!senderAllowListed) {
        return { allowed: false, reason: "sender-not-allowlisted" };
      }
    }
  } else {
    const channelConfig = resolveSlackChannelConfig({
      channelId,
      channelName,
      channels: params.ctx.channelsConfig,
      channelKeys: params.ctx.channelsConfigKeys,
      defaultRequireMention: params.ctx.defaultRequireMention,
      allowNameMatching: params.ctx.allowNameMatching
    });
    const channelUsersAllowlistConfigured = Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
    if (channelUsersAllowlistConfigured) {
      const channelUserAllowed = resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        userId: senderId,
        userName: senderName,
        allowNameMatching: params.ctx.allowNameMatching
      });
      if (!channelUserAllowed) {
        return {
          allowed: false,
          reason: "sender-not-channel-allowed",
          channelType,
          channelName
        };
      }
    }
  }
  return {
    allowed: true,
    channelType,
    channelName
  };
}
export {
  authorizeSlackSystemEventSender,
  clearSlackAllowFromCacheForTest,
  isSlackSenderAllowListed,
  resolveSlackEffectiveAllowFrom
};
