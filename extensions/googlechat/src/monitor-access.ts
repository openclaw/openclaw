import {
  GROUP_POLICY_BLOCKED_LABEL,
  createScopedPairingAccess,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  resolveMentionGatingWithBypass,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/googlechat";
import type { OpenClawConfig } from "openclaw/plugin-sdk/googlechat";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { sendGoogleChatMessage } from "./api.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";
import type { GoogleChatAnnotation, GoogleChatMessage, GoogleChatSpace } from "./types.js";

function normalizeUserId(raw?: string | null): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/^users\//i, "").toLowerCase();
}

function isEmailLike(value: string): boolean {
  // Keep this intentionally loose; allowlists are user-provided config.
  return value.includes("@");
}

export function isSenderAllowed(
  senderId: string,
  senderEmail: string | undefined,
  allowFrom: string[],
  allowNameMatching = false,
) {
  if (allowFrom.includes("*")) {
    return true;
  }
  const normalizedSenderId = normalizeUserId(senderId);
  const normalizedEmail = senderEmail?.trim().toLowerCase() ?? "";
  return allowFrom.some((entry) => {
    const normalized = String(entry).trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    // Accept `googlechat:<id>` but treat `users/...` as an *ID* only (deprecated `users/<email>`).
    const withoutPrefix = normalized.replace(/^(googlechat|google-chat|gchat):/i, "");
    if (withoutPrefix.startsWith("users/")) {
      return normalizeUserId(withoutPrefix) === normalizedSenderId;
    }

    // Raw email allowlist entries are a break-glass override.
    if (allowNameMatching && normalizedEmail && isEmailLike(withoutPrefix)) {
      return withoutPrefix === normalizedEmail;
    }

    return withoutPrefix.replace(/^users\//i, "") === normalizedSenderId;
  });
}

type GoogleChatGroupEntry = {
  requireMention?: boolean;
  allow?: boolean;
  enabled?: boolean;
  users?: Array<string | number>;
  systemPrompt?: string;
};

function resolveGroupConfig(params: {
  groupId: string;
  groupName?: string | null;
  groups?: Record<string, GoogleChatGroupEntry>;
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false };
  }
  const normalizedName = groupName?.trim().toLowerCase();
  const candidates = [groupId, groupName ?? "", normalizedName ?? ""].filter(Boolean);
  let entry = candidates.map((candidate) => entries[candidate]).find(Boolean);
  if (!entry && normalizedName) {
    entry = entries[normalizedName];
  }
  const fallback = entries["*"];
  return { entry: entry ?? fallback, allowlistConfigured: true, fallback };
}

function extractMentionInfo(annotations: GoogleChatAnnotation[], botUser?: string | null) {
  const mentionAnnotations = annotations.filter((entry) => entry.type === "USER_MENTION");
  const hasAnyMention = mentionAnnotations.length > 0;
  const botTargets = new Set(["users/app", botUser?.trim()].filter(Boolean) as string[]);
  const wasMentioned = mentionAnnotations.some((entry) => {
    const userName = entry.userMention?.user?.name;
    if (!userName) {
      return false;
    }
    if (botTargets.has(userName)) {
      return true;
    }
    return normalizeUserId(userName) === "app";
  });
  return { hasAnyMention, wasMentioned };
}

const warnedDeprecatedUsersEmailAllowFrom = new Set<string>();

function warnDeprecatedUsersEmailEntries(logVerbose: (message: string) => void, entries: string[]) {
  const deprecated = entries.map((v) => String(v).trim()).filter((v) => /^users\/.+@.+/i.test(v));
  if (deprecated.length === 0) {
    return;
  }
  const key = deprecated
    .map((v) => v.toLowerCase())
    .sort()
    .join(",");
  if (warnedDeprecatedUsersEmailAllowFrom.has(key)) {
    return;
  }
  warnedDeprecatedUsersEmailAllowFrom.add(key);
  logVerbose(
    `Deprecated allowFrom entry detected: "users/<email>" is no longer treated as an email allowlist. Use raw email (alice@example.com) or immutable user id (users/<id>). entries=${deprecated.join(", ")}`,
  );
}

export async function applyGoogleChatInboundAccessPolicy(params: {
  account: ResolvedGoogleChatAccount;
  config: OpenClawConfig;
  core: GoogleChatCoreRuntime;
  space: GoogleChatSpace;
  message: GoogleChatMessage;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  senderEmail?: string;
  rawBody: string;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  logVerbose: (message: string) => void;
}): Promise<
  | {
      ok: true;
      commandAuthorized: boolean | undefined;
      effectiveWasMentioned: boolean | undefined;
      groupSystemPrompt: string | undefined;
    }
  | { ok: false }
> {
  const {
    account,
    config,
    core,
    space,
    message,
    isGroup,
    senderId,
    senderName,
    senderEmail,
    rawBody,
    statusSink,
    logVerbose,
  } = params;
  const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
  const spaceId = space.name ?? "";
  const pairing = createScopedPairingAccess({
    core,
    channel: "googlechat",
    accountId: account.accountId,
  });

  const defaultGroupPolicy = resolveDefaultGroupPolicy(config);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: config.channels?.googlechat !== undefined,
      groupPolicy: account.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "googlechat",
    accountId: account.accountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.space,
    log: logVerbose,
  });
  const groupConfigResolved = resolveGroupConfig({
    groupId: spaceId,
    groupName: space.displayName ?? null,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
  let effectiveWasMentioned: boolean | undefined;

  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(`drop group message (groupPolicy=disabled, space=${spaceId})`);
      return { ok: false };
    }
    const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
    const groupAllowed = Boolean(groupEntry) || Boolean((account.config.groups ?? {})["*"]);
    if (groupPolicy === "allowlist") {
      if (!groupAllowlistConfigured) {
        logVerbose(`drop group message (groupPolicy=allowlist, no allowlist, space=${spaceId})`);
        return { ok: false };
      }
      if (!groupAllowed) {
        logVerbose(`drop group message (not allowlisted, space=${spaceId})`);
        return { ok: false };
      }
    }
    if (groupEntry?.enabled === false || groupEntry?.allow === false) {
      logVerbose(`drop group message (space disabled, space=${spaceId})`);
      return { ok: false };
    }

    if (groupUsers.length > 0) {
      const normalizedGroupUsers = groupUsers.map((v) => String(v));
      warnDeprecatedUsersEmailEntries(logVerbose, normalizedGroupUsers);
      const ok = isSenderAllowed(senderId, senderEmail, normalizedGroupUsers, allowNameMatching);
      if (!ok) {
        logVerbose(`drop group message (sender not allowed, ${senderId})`);
        return { ok: false };
      }
    }
  }

  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((v) => String(v));
  const normalizedGroupUsers = groupUsers.map((v) => String(v));
  const senderGroupPolicy =
    groupPolicy === "disabled"
      ? "disabled"
      : normalizedGroupUsers.length > 0
        ? "allowlist"
        : "open";
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeAuth)
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];
  const access = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy,
    groupPolicy: senderGroupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: normalizedGroupUsers,
    storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: false,
    isSenderAllowed: (allowFrom) =>
      isSenderAllowed(senderId, senderEmail, allowFrom, allowNameMatching),
  });
  const effectiveAllowFrom = access.effectiveAllowFrom;
  const effectiveGroupAllowFrom = access.effectiveGroupAllowFrom;
  warnDeprecatedUsersEmailEntries(logVerbose, effectiveAllowFrom);
  const commandAllowFrom = isGroup ? effectiveGroupAllowFrom : effectiveAllowFrom;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(
    senderId,
    senderEmail,
    commandAllowFrom,
    allowNameMatching,
  );
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (isGroup) {
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const annotations = message.annotations ?? [];
    const mentionInfo = extractMentionInfo(annotations, account.config.botUser);
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "googlechat",
    });
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention,
      canDetectMention: true,
      wasMentioned: mentionInfo.wasMentioned,
      implicitMention: false,
      hasAnyMention: mentionInfo.hasAnyMention,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
      commandAuthorized: commandAuthorized === true,
    });
    effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (mentionGate.shouldSkip) {
      logVerbose(`drop group message (mention required, space=${spaceId})`);
      return { ok: false };
    }
  }

  if (isGroup && access.decision !== "allow") {
    logVerbose(
      `drop group message (sender policy blocked, reason=${access.reason}, space=${spaceId})`,
    );
    return { ok: false };
  }

  if (!isGroup) {
    if (account.config.dm?.enabled === false) {
      logVerbose(`Blocked Google Chat DM from ${senderId} (dmPolicy=disabled)`);
      return { ok: false };
    }

    if (access.decision !== "allow") {
      if (access.decision === "pairing") {
        const { code, created } = await pairing.upsertPairingRequest({
          id: senderId,
          meta: { name: senderName || undefined, email: senderEmail },
        });
        if (created) {
          logVerbose(`googlechat pairing request sender=${senderId}`);
          try {
            const replyText = core.channel.pairing.buildPairingReply({
              channel: "googlechat",
              idLine: `Your Google Chat user id: ${senderId}`,
              code,
            });
            if (replyText) {
              await sendGoogleChatMessage({
                account,
                space: spaceId,
                text: replyText,
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            }
          } catch (err) {
            logVerbose(`pairing reply failed for ${senderId}: ${String(err)}`);
          }
        }
      } else {
        logVerbose(`Blocked unauthorized Google Chat sender ${senderId} (dmPolicy=${dmPolicy})`);
      }
      return { ok: false };
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(`googlechat: drop control command from ${senderId}`);
    return { ok: false };
  }

  return {
    ok: true,
    commandAuthorized,
    effectiveWasMentioned,
    groupSystemPrompt: groupEntry?.systemPrompt?.trim() || undefined,
  };
}
