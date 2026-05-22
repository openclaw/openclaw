import {
  createChannelApprovalCapability,
  splitChannelApprovalCapability,
} from "openclaw/plugin-sdk/approval-delivery-runtime";
import { createLazyChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import {
  createChannelApproverDmTargetResolver,
  createChannelNativeOriginTargetResolver,
  doesApprovalRequestMatchChannelAccount,
} from "openclaw/plugin-sdk/approval-native-runtime";
import type {
  ExecApprovalRequest,
  PluginApprovalRequest,
} from "openclaw/plugin-sdk/approval-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listWhatsAppAccountIds, resolveWhatsAppAccount } from "./accounts.js";
import { getWhatsAppApprovalApprovers, whatsappApprovalAuth } from "./approval-auth.js";
import { isWhatsAppGroupJid, normalizeWhatsAppMessagingTarget } from "./normalize.js";

type ApprovalRequest = ExecApprovalRequest | PluginApprovalRequest;
type WhatsAppApprovalTarget = { to: string; accountId?: string | null };

function isWhatsAppNativeApprovalEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  return resolveWhatsAppAccount({ cfg: params.cfg, accountId: params.accountId }).enabled;
}

function resolveTurnSourceWhatsAppOriginTarget(
  request: ApprovalRequest,
): WhatsAppApprovalTarget | null {
  const turnSourceChannel = normalizeLowercaseStringOrEmpty(request.request.turnSourceChannel);
  if (turnSourceChannel !== "whatsapp") {
    return null;
  }
  const to = normalizeWhatsAppMessagingTarget(request.request.turnSourceTo ?? "");
  if (!to) {
    return null;
  }
  return {
    to,
    accountId: normalizeOptionalString(request.request.turnSourceAccountId),
  };
}

function resolveSessionWhatsAppOriginTarget(sessionTarget: {
  to: string;
  accountId?: string | null;
}): WhatsAppApprovalTarget | null {
  const to = normalizeWhatsAppMessagingTarget(sessionTarget.to);
  return to ? { to, accountId: normalizeOptionalString(sessionTarget.accountId) } : null;
}

function shouldHandleWhatsAppApprovalRequest(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  request: ApprovalRequest;
}): boolean {
  if (!isWhatsAppNativeApprovalEnabled(params)) {
    return false;
  }
  return doesApprovalRequestMatchChannelAccount({
    cfg: params.cfg,
    request: params.request,
    channel: "whatsapp",
    accountId: params.accountId,
  });
}

const resolveWhatsAppOriginTargetBase = createChannelNativeOriginTargetResolver({
  channel: "whatsapp",
  shouldHandleRequest: shouldHandleWhatsAppApprovalRequest,
  resolveTurnSourceTarget: resolveTurnSourceWhatsAppOriginTarget,
  resolveSessionTarget: resolveSessionWhatsAppOriginTarget,
  normalizeTarget: (target) => {
    const to = normalizeWhatsAppMessagingTarget(target.to);
    return to ? { ...target, to } : null;
  },
});

function resolveWhatsAppOriginTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  approvalKind?: "exec" | "plugin";
  request: ApprovalRequest;
}): WhatsAppApprovalTarget | null {
  const target = resolveWhatsAppOriginTargetBase(params);
  if (!target) {
    return null;
  }
  if (
    isWhatsAppGroupJid(target.to) &&
    getWhatsAppApprovalApprovers({ cfg: params.cfg, accountId: params.accountId }).length === 0
  ) {
    return null;
  }
  return target;
}

const resolveWhatsAppApproverDmTargets = createChannelApproverDmTargetResolver({
  shouldHandleRequest: shouldHandleWhatsAppApprovalRequest,
  resolveApprovers: getWhatsAppApprovalApprovers,
  mapApprover: (approver, params) => {
    const to = normalizeWhatsAppMessagingTarget(approver);
    if (!to) {
      return null;
    }
    return {
      to,
      accountId: normalizeOptionalString(params.accountId),
    };
  },
});

export const whatsappApprovalCapability: ChannelApprovalCapability =
  createChannelApprovalCapability({
    ...whatsappApprovalAuth,
    getActionAvailabilityState: ({ cfg, accountId }) =>
      isWhatsAppNativeApprovalEnabled({ cfg, accountId })
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
    getExecInitiatingSurfaceState: ({ cfg, accountId }) =>
      isWhatsAppNativeApprovalEnabled({ cfg, accountId })
        ? ({ kind: "enabled" } as const)
        : ({ kind: "disabled" } as const),
    describeExecApprovalSetup: ({ accountId }) => {
      const prefix =
        accountId && accountId !== "default"
          ? `channels.whatsapp.accounts.${accountId}`
          : "channels.whatsapp";
      return `WhatsApp supports native exec approvals for this account. Link WhatsApp and keep the gateway running; configure \`${prefix}.allowFrom\` or \`${prefix}.defaultTo\` to restrict approvers.`;
    },
    delivery: {
      hasConfiguredDmRoute: ({ cfg }) =>
        listWhatsAppAccountIds(cfg).some((accountId) => {
          if (!isWhatsAppNativeApprovalEnabled({ cfg, accountId })) {
            return false;
          }
          return getWhatsAppApprovalApprovers({ cfg, accountId }).length > 0;
        }),
      shouldSuppressForwardingFallback: ({ cfg, target, request }) => {
        const channel = normalizeLowercaseStringOrEmpty(target.channel);
        if (channel !== "whatsapp") {
          return false;
        }
        const accountId =
          normalizeOptionalString(target.accountId) ??
          normalizeOptionalString(request.request.turnSourceAccountId);
        if (!shouldHandleWhatsAppApprovalRequest({ cfg, accountId, request })) {
          return false;
        }
        if (resolveWhatsAppOriginTarget({ cfg, accountId, request })) {
          return true;
        }
        return resolveWhatsAppApproverDmTargets({ cfg, accountId, request }).length > 0;
      },
    },
    native: {
      describeDeliveryCapabilities: ({ cfg, accountId, request }) => {
        const originTarget = resolveWhatsAppOriginTarget({ cfg, accountId, request });
        const approverTargets = resolveWhatsAppApproverDmTargets({ cfg, accountId, request });
        const enabled =
          isWhatsAppNativeApprovalEnabled({ cfg, accountId }) &&
          (Boolean(originTarget) || approverTargets.length > 0);
        return {
          enabled,
          preferredSurface: originTarget ? "origin" : "approver-dm",
          supportsOriginSurface: Boolean(originTarget),
          supportsApproverDmSurface: approverTargets.length > 0,
          notifyOriginWhenDmOnly: true,
        };
      },
      resolveOriginTarget: resolveWhatsAppOriginTarget,
      resolveApproverDmTargets: resolveWhatsAppApproverDmTargets,
    },
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      eventKinds: ["exec", "plugin"],
      isConfigured: ({ cfg, accountId, context }) =>
        Boolean(context) && isWhatsAppNativeApprovalEnabled({ cfg, accountId }),
      shouldHandle: ({ cfg, accountId, context, request }) =>
        Boolean(context) && shouldHandleWhatsAppApprovalRequest({ cfg, accountId, request }),
      load: async () =>
        (await import("./approval-handler.runtime.js"))
          .whatsappApprovalNativeRuntime as unknown as ChannelApprovalNativeRuntimeAdapter,
    }),
  });

export const whatsappNativeApprovalAdapter = splitChannelApprovalCapability(
  whatsappApprovalCapability,
);
