import {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
} from "../channels/plugins/binding-routing.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ConversationRef } from "../infra/outbound/session-binding-service.js";
import type { ResolvedAgentRoute } from "../routing/resolve-route.js";
import { ensureConfiguredAcpBindingReady } from "./persistent-bindings.lifecycle.js";
import {
  toResolvedConfiguredAcpBinding,
  type ResolvedConfiguredAcpBinding,
} from "./persistent-bindings.types.js";

type ConfiguredAcpRouteConversationInput =
  | {
      conversation: ConversationRef;
    }
  | {
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
    };

export function resolveConfiguredAcpRoute(
  params: {
    cfg: OpenClawConfig;
    route: ResolvedAgentRoute;
  } & ConfiguredAcpRouteConversationInput,
): {
  configuredBinding: ResolvedConfiguredAcpBinding | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
} {
  const resolved = resolveConfiguredBindingRoute(params);
  return {
    configuredBinding: resolved.bindingResolution
      ? toResolvedConfiguredAcpBinding(resolved.bindingResolution.record)
      : null,
    route: resolved.route,
    ...(resolved.boundSessionKey ? { boundSessionKey: resolved.boundSessionKey } : {}),
    ...(resolved.boundAgentId ? { boundAgentId: resolved.boundAgentId } : {}),
  };
}

export async function ensureConfiguredAcpRouteReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  return await ensureConfiguredAcpBindingReady(params);
}

export { ensureConfiguredBindingRouteReady, resolveConfiguredBindingRoute };
