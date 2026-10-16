import { matchesApprovalRequestFilters } from "openclaw/plugin-sdk/approval-client-runtime";
import type { ChannelApprovalKind } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalTarget } from "./aliases.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";

export type SignalApprovalReactionRoute =
  | {
      deliveryMode: "session";
      agentId?: string;
      sessionKey?: string;
    }
  | {
      deliveryMode: "target";
      to: string;
      accountId?: string;
      agentId?: string;
      sessionKey?: string;
    };

function resolveSignalApprovalRouteTarget(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
}): string | null {
  try {
    return (
      resolveSignalTarget({
        cfg: params.cfg,
        accountId: params.accountId,
        input: params.to,
      })?.to ??
      normalizeSignalMessagingTarget(params.to) ??
      null
    );
  } catch {
    return null;
  }
}

export function isSignalApprovalReactionRouteStillEnabled(params: {
  cfg: OpenClawConfig;
  target: {
    approvalKind: ChannelApprovalKind;
    route: SignalApprovalReactionRoute;
  };
}): boolean {
  const { approvalKind, route } = params.target;
  const config =
    approvalKind === "plugin" ? params.cfg.approvals?.plugin : params.cfg.approvals?.exec;
  if (!config?.enabled) {
    return false;
  }
  const mode = config.mode ?? "session";
  if (mode !== "both" && mode !== (route.deliveryMode === "target" ? "targets" : "session")) {
    return false;
  }
  if (
    !matchesApprovalRequestFilters({
      request: { agentId: route.agentId, sessionKey: route.sessionKey },
      agentFilter: config.agentFilter,
      sessionFilter: config.sessionFilter,
      fallbackAgentIdFromSessionKey: true,
    })
  ) {
    return false;
  }
  if (route.deliveryMode === "session") {
    return true;
  }
  return (config.targets ?? []).some((target) => {
    if (normalizeLowercaseStringOrEmpty(target.channel) !== "signal") {
      return false;
    }
    const configuredTo = resolveSignalApprovalRouteTarget({
      cfg: params.cfg,
      accountId: target.accountId ?? route.accountId,
      to: target.to,
    });
    if (!configuredTo || configuredTo !== route.to) {
      return false;
    }
    const configuredAccountId = normalizeOptionalString(target.accountId);
    const routeAccountId = normalizeOptionalString(route.accountId);
    return (
      !configuredAccountId ||
      Boolean(
        routeAccountId &&
        normalizeAccountId(routeAccountId) === normalizeAccountId(configuredAccountId),
      )
    );
  });
}

export function buildTargetRoute(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  approvalKind: ChannelApprovalKind;
  agentId?: string | null;
  sessionKey?: string | null;
}): Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }> | null {
  const to = resolveSignalApprovalRouteTarget({
    cfg: params.cfg,
    accountId: params.accountId,
    to: params.to,
  });
  if (!to) {
    return null;
  }
  const accountId = normalizeOptionalString(params.accountId);
  const agentId = normalizeOptionalString(params.agentId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const route: Extract<SignalApprovalReactionRoute, { deliveryMode: "target" }> = {
    deliveryMode: "target",
    to,
    ...(accountId ? { accountId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  };
  return isSignalApprovalReactionRouteStillEnabled({
    cfg: params.cfg,
    target: {
      approvalKind: params.approvalKind,
      route,
    },
  })
    ? route
    : null;
}
