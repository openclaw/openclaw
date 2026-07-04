import { ToolAuthorizationError } from "openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionContext } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import {
  findGoogleChatDirectMessage,
  getGoogleChatSpace,
  getGoogleChatSpaceMembership,
} from "./api.js";
import { normalizeGoogleChatEmailEntry, resolveGoogleChatGroupConfig } from "./monitor-access.js";
import { isGoogleChatGroupSpace, normalizeGoogleChatTarget } from "./targets.js";

type GoogleChatReadContext = Pick<
  ChannelMessageActionContext,
  "accountId" | "requesterAccountId" | "toolContext"
>;

function readSpaceName(messageName: string): string {
  const normalized = messageName.trim();
  const parts = normalized.split("/");
  const [spaces, spaceId, messages, messageId] = parts;
  const hasUnsafeSegment = [spaceId, messageId].some(
    (segment) => !segment || segment === "." || segment === ".." || /[%\\?#\s]/.test(segment),
  );
  if (
    parts.length !== 4 ||
    spaces?.toLowerCase() !== "spaces" ||
    messages?.toLowerCase() !== "messages" ||
    hasUnsafeSegment
  ) {
    throw new ToolAuthorizationError("Google Chat message target is invalid.");
  }
  return `spaces/${spaceId}`;
}

function isCurrentSpace(params: {
  account: ResolvedGoogleChatAccount;
  context: GoogleChatReadContext;
  space: string;
}): boolean {
  return (
    normalizeOptionalString(params.context.toolContext?.currentChannelProvider)?.toLowerCase() ===
      "googlechat" &&
    normalizeOptionalString(params.context.requesterAccountId) === params.account.accountId &&
    (normalizeOptionalString(params.context.accountId) ?? params.account.accountId) ===
      params.account.accountId &&
    normalizeOptionalString(params.context.toolContext?.currentChannelId) === params.space
  );
}

function resolveGroupPolicy(cfg: OpenClawConfig, account: ResolvedGoogleChatAccount) {
  return resolveAllowlistProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.googlechat !== undefined,
    groupPolicy: account.config.groupPolicy,
    defaultGroupPolicy: resolveDefaultGroupPolicy(cfg),
  }).groupPolicy;
}

function hasWildcardEntry(entries: Array<string | number> | undefined): boolean {
  return (entries ?? []).some((entry) => String(entry).trim() === "*");
}

async function isConfiguredDmSpace(params: {
  account: ResolvedGoogleChatAccount;
  space: string;
}): Promise<{ directSpace: boolean; mutableMember: boolean }> {
  const entries = (params.account.config.dm?.allowFrom ?? []).map(String);
  let mutableMember = false;
  for (const entry of entries) {
    const email = normalizeGoogleChatEmailEntry(entry);
    if (email && params.account.config.dangerouslyAllowNameMatching === true) {
      const membership = await getGoogleChatSpaceMembership({
        account: params.account,
        space: params.space,
        member: email,
      }).catch(() => null);
      mutableMember ||= membership !== null;
      continue;
    }
    const userName = normalizeGoogleChatTarget(entry);
    if (!userName?.startsWith("users/") || userName.includes("@")) {
      continue;
    }
    const direct = await findGoogleChatDirectMessage({
      account: params.account,
      userName,
    }).catch(() => null);
    if (direct?.name === params.space) {
      return { directSpace: true, mutableMember };
    }
  }
  return { directSpace: false, mutableMember };
}

export async function assertGoogleChatMessageReadAllowed(params: {
  cfg: OpenClawConfig;
  account: ResolvedGoogleChatAccount;
  context: GoogleChatReadContext;
  messageName: string;
}): Promise<string> {
  const space = readSpaceName(params.messageName);
  const groupPolicy = resolveGroupPolicy(params.cfg, params.account);
  const dmPolicy = params.account.config.dm?.policy ?? "pairing";
  const current = isCurrentSpace({
    account: params.account,
    context: params.context,
    space,
  });
  const group = resolveGoogleChatGroupConfig({
    groupId: space,
    groups: params.account.config.groups,
  });
  if (params.account.config.groups?.[space]?.enabled === false) {
    throw new ToolAuthorizationError("Google Chat read target is not allowed.");
  }
  const configuredDm = await isConfiguredDmSpace({ account: params.account, space });
  const resolvedSpace = configuredDm.directSpace
    ? null
    : await getGoogleChatSpace({ account: params.account, space }).catch(() => null);
  const knownDm =
    configuredDm.directSpace ||
    Boolean(configuredDm.mutableMember && resolvedSpace && !isGoogleChatGroupSpace(resolvedSpace));
  const knownGroup = Boolean(resolvedSpace && isGoogleChatGroupSpace(resolvedSpace));
  const knownDirect = knownDm || Boolean(resolvedSpace && !isGoogleChatGroupSpace(resolvedSpace));
  const groupDenied = group.entry?.enabled === false;
  const allowed = knownDirect
    ? params.account.config.dm?.enabled !== false &&
      dmPolicy !== "disabled" &&
      (current ||
        dmPolicy === "open" ||
        knownDm ||
        hasWildcardEntry(params.account.config.dm?.allowFrom))
    : knownGroup
      ? groupPolicy !== "disabled" &&
        !groupDenied &&
        (current || groupPolicy === "open" || group.entry !== undefined)
      : current
        ? !groupDenied &&
          groupPolicy !== "disabled" &&
          params.account.config.dm?.enabled !== false &&
          dmPolicy !== "disabled"
        : !groupDenied &&
          groupPolicy === "open" &&
          params.account.config.dm?.enabled !== false &&
          dmPolicy === "open";
  if (!allowed) {
    throw new ToolAuthorizationError("Google Chat read target is not allowed.");
  }
  return space;
}
