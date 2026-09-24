import { prepareChannelApprovalAuthority } from "openclaw/plugin-sdk/approval-auth-runtime";
import type { ChannelOutboundPayloadHint } from "openclaw/plugin-sdk/channel-contract";
import type {
  OpenClawConfig,
  DiscordExecApprovalConfig,
} from "openclaw/plugin-sdk/config-contracts";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { createRuntimeConfigReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveDiscordAccount } from "./accounts.js";
import {
  getExecApprovalReplyMetadata,
  isChannelExecApprovalClientEnabledFromConfig,
  matchesApprovalRequestFilters,
  resolveApprovalApprovers,
} from "./approval-runtime.js";
import { resolveDiscordCommandOwnerEntries } from "./command-owners.js";
import { parseDiscordTarget } from "./target-parsing.js";

function normalizeDiscordApproverId(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    return trimmed;
  }
  try {
    const target = parseDiscordTarget(trimmed);
    return target?.kind === "user" ? target.id : undefined;
  } catch {
    return undefined;
  }
}

function resolveDiscordOwnerApprovers(cfg: OpenClawConfig): string[] {
  // Global owner targets have a nested normalization pass; explicit approvers do not.
  // Preserve that shipped distinction for targets such as discord:<@123>.
  return resolveApprovalApprovers({
    explicit: resolveDiscordCommandOwnerEntries(cfg),
    normalizeApprover: (value) => normalizeDiscordApproverId(String(value)),
  });
}

export function getDiscordExecApprovalApprovers(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): string[] {
  return resolveApprovalApprovers({
    explicit:
      params.configOverride?.approvers ??
      resolveDiscordAccount(params).config.execApprovals?.approvers ??
      resolveDiscordOwnerApprovers(params.cfg),
    normalizeApprover: (value) => normalizeDiscordApproverId(String(value)),
  });
}

export function isDiscordExecApprovalClientEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const config = params.configOverride ?? resolveDiscordAccount(params).config.execApprovals;
  return isChannelExecApprovalClientEnabledFromConfig({
    enabled: config?.enabled,
    approverCount:
      getDiscordExecApprovalApprovers({
        cfg: params.cfg,
        accountId: params.accountId,
        configOverride: params.configOverride,
      }).length || (canUseLinkedDiscordApprover(params) ? 1 : 0),
  });
}

/** Auto delivery may consider the verified requester; an explicit list remains authoritative. */
export function canUseLinkedDiscordApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const config = params.configOverride ?? resolveDiscordAccount(params).config.execApprovals;
  return (
    config?.approvers === undefined && (config?.enabled === true || config?.enabled === "auto")
  );
}

export async function prepareDiscordApprovalAuthority(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): Promise<{ assertCurrent: () => void } | undefined> {
  const account = resolveDiscordAccount(params);
  if (!account.enabled) {
    return undefined;
  }
  const accountId = account.accountId;
  const currentConfig = createRuntimeConfigReader(params.cfg);
  const currentPolicy = () => {
    const cfg = currentConfig();
    return {
      ...params,
      cfg,
      accountId,
      configOverride: cfg === params.cfg ? params.configOverride : undefined,
    };
  };
  if (isDiscordExecApprovalApprover(params)) {
    return {
      assertCurrent: () => {
        if (
          !resolveDiscordAccount(currentPolicy()).enabled ||
          !isDiscordExecApprovalApprover(currentPolicy())
        ) {
          throw new Error("Discord approval authority changed");
        }
      },
    };
  }
  const senderId = params.senderId?.trim();
  if (!senderId || !canUseLinkedDiscordApprover(params)) {
    return undefined;
  }
  const authority = await prepareChannelApprovalAuthority({
    cfg: params.cfg,
    channelId: "discord",
    accountId,
    senderId,
  });
  return (
    authority && {
      assertCurrent: () => {
        authority.assertCurrent();
        if (
          !resolveDiscordAccount(currentPolicy()).enabled ||
          !canUseLinkedDiscordApprover(currentPolicy())
        ) {
          throw new Error("Discord approval policy changed");
        }
      },
    }
  );
}

export function isDiscordExecApprovalApprover(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  senderId?: string | null;
  configOverride?: DiscordExecApprovalConfig | null;
}): boolean {
  const senderId = params.senderId?.trim();
  if (!senderId) {
    return false;
  }
  return getDiscordExecApprovalApprovers({
    cfg: params.cfg,
    accountId: params.accountId,
    configOverride: params.configOverride,
  }).includes(senderId);
}

export function shouldSuppressLocalDiscordExecApprovalPrompt(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
  hint?: ChannelOutboundPayloadHint;
}): boolean {
  const metadata = getExecApprovalReplyMetadata(params.payload);
  const config = resolveDiscordAccount(params).config.execApprovals;
  return (
    params.hint?.kind === "approval-pending" &&
    params.hint.nativeRouteActive === true &&
    isDiscordExecApprovalClientEnabled(params) &&
    metadata !== null &&
    matchesApprovalRequestFilters({
      request: {
        agentId: metadata.agentId,
        sessionKey: metadata.sessionKey,
      },
      agentFilter: config?.agentFilter,
      sessionFilter: config?.sessionFilter,
    })
  );
}
