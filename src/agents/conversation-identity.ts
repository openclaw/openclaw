import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveDefaultAgentId } from "./agent-scope.js";
import type { ConversationCapabilityScope } from "./conversation-capability-profile.js";

export const CONVERSATION_IDENTITY_DENIED_MESSAGE =
  "This conversation is not configured for agent access.";

export type ResolvedConversationIdentity =
  | { mode: "personal"; reason: "private-owner" }
  | { mode: "organization"; reason: "configured-service-agent" }
  | {
      mode: "external";
      reason:
        | "unknown-audience"
        | "shared-default-agent"
        | "non-owner-default-agent"
        | "unconfigured-agent"
        | "configured-agent-mismatch";
    };

/** Classifies a channel audience from host-resolved agent and binding facts. */
export function resolveConversationIdentity(params: {
  config: OpenClawConfig;
  scope: ConversationCapabilityScope;
  agentId: string;
  staticBindingAgentId?: string;
  senderIsConfiguredOwner: boolean;
}): ResolvedConversationIdentity {
  if (params.scope === "unknown") {
    return { mode: "external", reason: "unknown-audience" };
  }

  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(params.config));
  const agentId = normalizeAgentId(params.agentId);
  const staticBindingAgentId = params.staticBindingAgentId
    ? normalizeAgentId(params.staticBindingAgentId)
    : undefined;
  const serviceAgentIsConfigured = params.config.agents?.list?.some(
    (entry) => normalizeAgentId(entry.id) === staticBindingAgentId,
  );

  if (
    staticBindingAgentId &&
    staticBindingAgentId !== defaultAgentId &&
    agentId === staticBindingAgentId &&
    serviceAgentIsConfigured
  ) {
    return { mode: "organization", reason: "configured-service-agent" };
  }
  if (staticBindingAgentId && agentId !== staticBindingAgentId) {
    return { mode: "external", reason: "configured-agent-mismatch" };
  }
  if (params.scope === "direct" && params.senderIsConfiguredOwner && agentId === defaultAgentId) {
    return { mode: "personal", reason: "private-owner" };
  }
  if (agentId !== defaultAgentId) {
    return { mode: "external", reason: "unconfigured-agent" };
  }
  return params.scope === "shared"
    ? { mode: "external", reason: "shared-default-agent" }
    : { mode: "external", reason: "non-owner-default-agent" };
}
