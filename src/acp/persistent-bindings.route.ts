import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedAgentRoute } from "../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  ensureConfiguredAcpBindingSession,
  resolveConfiguredAcpBindingRecord,
  type ConfiguredAcpBindingChannel,
  type ResolvedConfiguredAcpBinding,
} from "./persistent-bindings.js";

export function resolveConfiguredAcpRoute(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): {
  configuredBinding: ResolvedConfiguredAcpBinding | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
} {
  const configuredBinding = resolveConfiguredAcpBindingRecord({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!configuredBinding) {
    return {
      configuredBinding: null,
      route: params.route,
    };
  }
  const boundSessionKey = configuredBinding.record.targetSessionKey?.trim() ?? "";
  if (!boundSessionKey) {
    return {
      configuredBinding,
      route: params.route,
    };
  }
  const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || params.route.agentId;
  return {
    configuredBinding,
    boundSessionKey,
    boundAgentId,
    route: {
      ...params.route,
      sessionKey: boundSessionKey,
      agentId: boundAgentId,
      matchedBy: "binding.channel",
    },
  };
}

export async function ensureConfiguredAcpRouteReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.configuredBinding) {
    return { ok: true };
  }
  const ensured = await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec: params.configuredBinding.spec,
  });
  if (ensured.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    error: ensured.error ?? "unknown error",
  };
}
