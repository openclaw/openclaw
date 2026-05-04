import { formatAllowFromLowercase } from "openclaw/plugin-sdk/allow-from";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import {
  listMaxAccountIds,
  resolveDefaultMaxAccountId,
  resolveMaxAccount,
} from "../account-resolver.js";
import type { CoreConfig, ResolvedMaxAccount } from "../types.js";

const TARGET_PREFIX_RE = /^(max-messenger|max):/iu;

/**
 * Account-scoped config adapter for `channels.max-messenger`.
 *
 * Shape mirrors `nextcloudTalkConfigAdapter`
 * (`extensions/nextcloud-talk/src/channel.adapters.ts:17`).
 */
export const maxMessengerConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMaxAccount,
  ResolvedMaxAccount,
  CoreConfig
>({
  sectionKey: "max-messenger",
  listAccountIds: listMaxAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMaxAccount),
  defaultAccountId: resolveDefaultMaxAccountId,
  clearBaseFields: ["token", "tokenFile", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    formatAllowFromLowercase({ allowFrom, stripPrefixRe: TARGET_PREFIX_RE }),
});

/**
 * DM security resolver — converts raw allowlist entries into the canonical
 * lowercase form and strips channel prefixes so user-supplied
 * `max:12345` / `max-messenger:12345` are normalized identically.
 */
export const maxMessengerSecurityAdapter = {
  resolveDmPolicy: createScopedDmSecurityResolver<ResolvedMaxAccount>({
    channelKey: "max-messenger",
    resolvePolicy: (account) => account.config.dmPolicy,
    resolveAllowFrom: (account) => account.config.allowFrom,
    policyPathSuffix: "dmPolicy",
    normalizeEntry: (raw) =>
      normalizeLowercaseStringOrEmpty(raw.trim().replace(TARGET_PREFIX_RE, "")),
  }),
};

/**
 * Pairing-text adapter — used by the SDK's pairing controller when issuing
 * `/pair` challenges and recording allowlist entries on approval.
 */
export const maxMessengerPairingTextAdapter = {
  idLabel: "maxUserId",
  message: "OpenClaw: your access has been approved.",
  normalizeAllowEntry: createPairingPrefixStripper(TARGET_PREFIX_RE, (entry) =>
    normalizeLowercaseStringOrEmpty(entry),
  ),
};
