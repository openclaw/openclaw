/**
 * QQ Bot Approval Capability — entry point.
 *
 * QQBot uses a simpler approval model than Telegram/Slack: any user who
 * can see the inline-keyboard buttons can approve. No explicit approver
 * list is required — the bot simply sends the approval message to the
 * originating conversation and whoever clicks the button resolves it.
 *
 * When `execApprovals` IS configured, it gates which requests are
 * handled natively and who is authorized.  When it is NOT configured,
 * QQBot falls back to "always handle, anyone can approve".
 */

import {
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { resolveApprovalRequestSessionConversation } from "openclaw/plugin-sdk/approval-native-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveApprovalTarget } from "../../engine/approval/index.js";
import {
  isQQBotExecApprovalClientEnabled,
  shouldHandleQQBotExecApprovalRequest,
  isQQBotExecApprovalAuthorizedSender,
  isQQBotExecApprovalApprover,
  resolveQQBotExecApprovalConfig,
} from "../../exec-approvals.js";
import { resolveQQBotAccount } from "../config.js";

/**
 * When `execApprovals` is configured, delegate to the profile-based
 * check.  Otherwise fall back to target-resolvability: if we can figure
 * out *where* to send the approval message, we handle it.
 */
function shouldHandleRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: {
    request: {
      sessionKey?: string | null;
      turnSourceTo?: string | null;
      turnSourceChannel?: string | null;
    };
  };
}): boolean {
  if (hasExecApprovalConfig(params)) {
    return shouldHandleQQBotExecApprovalRequest(params as never);
  }
  return canResolveTarget(params.request);
}

function hasExecApprovalConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveQQBotExecApprovalConfig(params) !== undefined;
}

function isNativeDeliveryEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  if (hasExecApprovalConfig(params)) {
    return isQQBotExecApprovalClientEnabled(params);
  }
  const account = resolveQQBotAccount(params.cfg, params.accountId);
  return account.enabled && account.secretSource !== "none";
}

function canResolveTarget(request: {
  request: { sessionKey?: string | null; turnSourceTo?: string | null };
}): boolean {
  const sessionKey = request.request.sessionKey ?? null;
  const turnSourceTo = request.request.turnSourceTo ?? null;

  const target = resolveApprovalTarget(sessionKey, turnSourceTo);
  if (target) {
    return true;
  }

  const sessionConversation = resolveApprovalRequestSessionConversation({
    request: request as never,
    channel: "qqbot",
    bundledFallback: true,
  });
  return sessionConversation?.id != null;
}

function createQQBotApprovalCapability(): ChannelApprovalCapability {
  return createChannelApprovalCapability({
    authorizeActorAction: ({ cfg, accountId, senderId, approvalKind }) => {
      if (hasExecApprovalConfig({ cfg, accountId })) {
        const authorized =
          approvalKind === "plugin"
            ? isQQBotExecApprovalApprover({ cfg, accountId, senderId })
            : isQQBotExecApprovalAuthorizedSender({ cfg, accountId, senderId });
        return authorized
          ? { authorized: true }
          : { authorized: false, reason: "You are not authorized to approve this request." };
      }
      return { authorized: true };
    },

    getActionAvailabilityState: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      action: "approve";
    }) => {
      const enabled = isNativeDeliveryEnabled({ cfg, accountId });
      return enabled ? { kind: "enabled" } : { kind: "disabled" };
    },

    getExecInitiatingSurfaceState: ({
      cfg,
      accountId,
    }: {
      cfg: OpenClawConfig;
      accountId?: string | null;
      action: "approve";
    }) => {
      const enabled = isNativeDeliveryEnabled({ cfg, accountId });
      return enabled ? { kind: "enabled" } : { kind: "disabled" };
    },

    describeExecApprovalSetup: ({ accountId }: { accountId?: string | null }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.qqbot.accounts.${accountId}`
          : "channels.qqbot";
      return `QQBot native exec approvals are enabled by default. To restrict who can approve, configure \`${prefix}.execApprovals.approvers\` with QQ user OpenIDs.`;
    },

    delivery: {
      hasConfiguredDmRoute: () => true,
      shouldSuppressForwardingFallback: (input) => {
        const channel = normalizeOptionalString(input.target?.channel);
        if (channel !== "qqbot") {
          return false;
        }
        const accountId =
          normalizeOptionalString(input.target?.accountId) ??
          normalizeOptionalString(input.request?.request?.turnSourceAccountId);
        const result = isNativeDeliveryEnabled({ cfg: input.cfg, accountId });
        console.log(
          `[qqbot:approval] shouldSuppressForwardingFallback channel=${channel} accountId=${accountId} → ${result}`,
        );
        return result;
      },
    },

    native: {
      describeDeliveryCapabilities: ({ cfg, accountId }) => ({
        enabled: isNativeDeliveryEnabled({ cfg, accountId }),
        preferredSurface: "origin" as const,
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
        notifyOriginWhenDmOnly: false,
      }),
      resolveOriginTarget: ({ request }) => {
        const sessionKey = request.request.sessionKey ?? null;
        const turnSourceTo = request.request.turnSourceTo ?? null;
        const target = resolveApprovalTarget(sessionKey, turnSourceTo);
        if (target) {
          return { to: `${target.type}:${target.id}` };
        }
        const sessionConversation = resolveApprovalRequestSessionConversation({
          request: request as never,
          channel: "qqbot",
          bundledFallback: true,
        });
        if (sessionConversation?.id) {
          const kind = sessionConversation.kind === "group" ? "group" : "c2c";
          return { to: `${kind}:${sessionConversation.id}` };
        }
        return null;
      },
    },

    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId }) => {
        const result = isNativeDeliveryEnabled({ cfg, accountId });
        console.log(
          `[qqbot:approval] nativeRuntime.isConfigured accountId=${accountId} → ${result}`,
        );
        return result;
      },
      shouldHandle: ({ cfg, accountId, request }) => {
        const result = shouldHandleRequest({
          cfg,
          accountId,
          request: request as never,
        });
        console.log(
          `[qqbot:approval] nativeRuntime.shouldHandle accountId=${accountId} → ${result}`,
        );
        return result;
      },
      load: async () =>
        (await import("./handler-runtime.js"))
          .qqbotApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });
}

export const qqbotApprovalCapability = createQQBotApprovalCapability();

export const qqbotNativeApprovalAdapter = splitChannelApprovalCapability(qqbotApprovalCapability);

let _cachedCapability: ChannelApprovalCapability | undefined;

export function getQQBotApprovalCapability(): ChannelApprovalCapability {
  _cachedCapability ??= qqbotApprovalCapability;
  return _cachedCapability;
}
