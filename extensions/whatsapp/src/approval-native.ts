import { createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync } from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapterAsync } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildApprovalReactionPromptPayloadForRequest } from "openclaw/plugin-sdk/approval-reaction-runtime";
import { buildTypedApprovalPresentation } from "openclaw/plugin-sdk/approval-reply-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  listWhatsAppAccountIds,
  resolveDefaultWhatsAppAccountId,
  resolveWhatsAppAccount,
} from "./accounts.js";
import {
  getWhatsAppApprovalApprovers,
  hasExplicitWhatsAppApprovers,
  normalizeWhatsAppApproverId,
  whatsappApprovalAuth,
} from "./approval-auth.js";
import { isWhatsAppGroupJid, normalizeWhatsAppMessagingTarget } from "./normalize-target.js";

function isWhatsAppApprovalTransportEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

const whatsappApproval = createApproverRestrictedNativeApprovalCapabilityFromForwardingRoutesAsync({
  channel: "whatsapp",
  channelLabel: "WhatsApp",
  authorizeActorAction: (params) => whatsappApprovalAuth.authorizeActorAction(params),
  routing: {
    defaultForwardingMode: "session",
    isTransportEnabled: isWhatsAppApprovalTransportEnabled,
    listAccountIds: listWhatsAppAccountIds,
    resolveDefaultAccountId: resolveDefaultWhatsAppAccountId,
    normalizeTo: normalizeWhatsAppMessagingTarget,
    resolveApprovers: getWhatsAppApprovalApprovers,
    // Group conversations require explicit approvers; implicit same-chat auth
    // would otherwise let any participant approve the request. With named
    // approvers (`execApprovals.approvers`), a direct chat only gets the prompt
    // when its peer may approve it; otherwise the prompt goes to the approvers'
    // own chats instead of sitting with someone who cannot act on it.
    isOriginTargetAllowed: ({ cfg, accountId, target }) => {
      const approvers = getWhatsAppApprovalApprovers({ cfg, accountId });
      if (isWhatsAppGroupJid(target.to)) {
        return approvers.length > 0;
      }
      if (!hasExplicitWhatsAppApprovers({ cfg, accountId }) || approvers.includes("*")) {
        return true;
      }
      const peer = normalizeWhatsAppApproverId(target.to);
      return peer !== undefined && approvers.includes(peer);
    },
  },
  describeExecApprovalSetup: ({ accountId }) => {
    const prefix =
      accountId && accountId !== "default"
        ? `channels.whatsapp.accounts.${accountId}`
        : "channels.whatsapp";
    return `WhatsApp supports native exec approvals for this account when \`approvals.exec.enabled\` is true and the route allows WhatsApp. Link WhatsApp and keep the gateway running; configure \`${prefix}.execApprovals.approvers\` to name who may approve (it falls back to \`${prefix}.allowFrom\`).`;
  },
  render: {
    exec: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildWhatsAppPendingPayload({ request, nowMs }, "exec"),
    },
    plugin: {
      buildPendingPayload: ({ request, nowMs }) =>
        buildWhatsAppPendingPayload({ request, nowMs }, "plugin"),
    },
  },
  createNativeRuntime: (routing) =>
    createLazyChannelApprovalNativeRuntimeAdapterAsync({
      capabilityBoundary: true,
      eventKinds: ["exec", "plugin", "system-agent"],
      isConfigured: ({ cfg, accountId, context }) =>
        Boolean(context) &&
        routing.canAnyApprovalPotentiallyRouteToChannel({
          cfg,
          accountId,
          nativeSessionOnly: true,
        }),
      shouldHandle: async ({ cfg, accountId, context, approvalKind, request }) =>
        Boolean(context) &&
        routing.shouldHandleApprovalRequest({ cfg, accountId, approvalKind, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js")).whatsappApprovalNativeRuntime,
    }),
});

function buildWhatsAppPendingPayload(
  params: { request: ExecApprovalRequest | PluginApprovalRequest; nowMs: number },
  approvalKind: ChannelApprovalKind,
) {
  const payload = buildApprovalReactionPromptPayloadForRequest(params);
  return {
    ...payload,
    presentation: buildTypedApprovalPresentation({
      approvalId: params.request.id,
      approvalKind,
      allowedDecisions: payload.allowedDecisions,
    }),
  };
}

export const whatsappApprovalCapability: ChannelApprovalCapability = whatsappApproval.capability;
