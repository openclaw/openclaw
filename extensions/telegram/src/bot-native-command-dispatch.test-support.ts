import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";

export function createConfiguredAcpTopicBinding(boundSessionKey: string) {
  const conversation = {
    channel: "telegram",
    accountId: "default",
    conversationId: "-1001234567890:topic:42",
    parentConversationId: "-1001234567890",
  } as const;
  return {
    spec: { ...conversation, agentId: "codex", mode: "persistent" },
    record: {
      bindingId: "config:acp:telegram:default:-1001234567890:topic:42",
      targetSessionKey: boundSessionKey,
      targetKind: "session",
      conversation,
      status: "active",
      boundAt: 0,
    },
  } as const;
}

export function createConfiguredBindingRoute(
  route: ResolvedAgentRoute,
  binding: ReturnType<typeof createConfiguredAcpTopicBinding> | null,
) {
  if (!binding) {
    return { bindingResolution: null, route };
  }
  const { conversationId, parentConversationId, agentId, accountId, mode } = binding.spec;
  const target = { conversationId, parentConversationId };
  const statefulTarget = {
    kind: "stateful" as const,
    driverId: "acp" as const,
    sessionKey: binding.record.targetSessionKey,
    agentId,
  };
  return {
    bindingResolution: {
      conversation: binding.record.conversation,
      compiledBinding: {
        channel: "telegram" as const,
        binding: {
          type: "acp" as const,
          agentId,
          match: {
            channel: "telegram",
            accountId,
            peer: { kind: "group" as const, id: conversationId },
          },
          acp: { mode },
        },
        bindingConversationId: conversationId,
        target,
        agentId,
        provider: {
          compileConfiguredBinding: () => ({ ...target }),
          matchInboundConversation: () => ({ ...target }),
        },
        targetFactory: {
          driverId: "acp" as const,
          materialize: () => ({
            record: binding.record,
            statefulTarget: { ...statefulTarget },
          }),
        },
      },
      match: { ...target },
      record: binding.record,
      statefulTarget,
    },
    boundSessionKey: binding.record.targetSessionKey,
    route,
  };
}
