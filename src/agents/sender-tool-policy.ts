/**
 * Sender-scoped sandbox tool policy resolver.
 * Applies per-agent toolsBySender matches before global sender policy so
 * channel delivery can narrow tool access by sender identity.
 */
import { resolveToolsBySender } from "../config/group-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAccountId, normalizeOptionalAccountId } from "../routing/account-id.js";
import { normalizeMessageChannel } from "../utils/message-channel-core.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";

type SenderToolPolicyParams = {
  config?: OpenClawConfig;
  agentId?: string;
  messageProvider?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

type RouteBoundSenderToolPolicyIdentityParams = Omit<
  SenderToolPolicyParams,
  "config" | "agentId" | "messageProvider"
> & {
  /** Delivery route whose account-scoped policy is being resolved. */
  routeMessageProvider?: string | null;
  routeAccountId?: string | null;
  /** Authenticated source identity. */
  senderMessageProvider?: string | null;
  senderAccountId?: string | null;
  /** Host-issued authority requires an exact source-to-route binding. */
  requireRouteBinding?: boolean;
};

type RouteBoundSenderToolPolicyIdentity = Omit<SenderToolPolicyParams, "config" | "agentId"> & {
  routeBound: boolean;
};

/**
 * Keeps legacy sender selectors on their receiving account. A delegated sender
 * from another provider/account may still receive wildcard policy, but cannot
 * inherit an unqualified id/name grant from the target route.
 */
export function resolveRouteBoundSenderToolPolicyIdentity(
  params: RouteBoundSenderToolPolicyIdentityParams,
): RouteBoundSenderToolPolicyIdentity {
  const routeBound = (() => {
    if (params.requireRouteBinding !== true) {
      return true;
    }
    const routeProvider = normalizeMessageChannel(params.routeMessageProvider);
    const senderProvider = normalizeMessageChannel(params.senderMessageProvider);
    const senderAccountId = normalizeOptionalAccountId(params.senderAccountId);
    return Boolean(
      routeProvider &&
      senderProvider &&
      routeProvider === senderProvider &&
      senderAccountId &&
      senderAccountId === normalizeAccountId(params.routeAccountId),
    );
  })();
  return {
    routeBound,
    messageProvider: params.senderMessageProvider,
    senderId: routeBound ? params.senderId : undefined,
    senderName: routeBound ? params.senderName : undefined,
    senderUsername: routeBound ? params.senderUsername : undefined,
    senderE164: routeBound ? params.senderE164 : undefined,
  };
}

/** Resolves sender-scoped sandbox tool policy, preferring agent config over global config. */
export function resolveSenderToolPolicy(
  params: SenderToolPolicyParams,
): SandboxToolPolicy | undefined {
  const cfg = params.config;
  if (!cfg) {
    return undefined;
  }
  const sender = {
    messageProvider: params.messageProvider,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  };
  const agentTools =
    params.agentId && params.agentId.trim()
      ? resolveAgentConfig(cfg, params.agentId)?.tools
      : undefined;
  const agentPolicy = resolveToolsBySender({
    toolsBySender: agentTools?.toolsBySender,
    ...sender,
  });
  if (agentPolicy) {
    return pickSandboxToolPolicy(agentPolicy);
  }
  const globalPolicy = resolveToolsBySender({
    toolsBySender: cfg.tools?.toolsBySender,
    ...sender,
  });
  return pickSandboxToolPolicy(globalPolicy);
}
