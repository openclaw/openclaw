import type {
  HookAgentDispatchPayload,
  HookMessageChannel,
  IngressAgentDispatchResult,
  IngressDispatchPoliciesResolved,
} from "openclaw/plugin-sdk/mqtt-hooks";
import {
  getHookAgentPolicyError,
  getHookChannelError,
  normalizeHookDispatchSessionKey,
  renderIngressTemplate,
  resolveHookChannel,
  resolveHookDeliver,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  isHookAgentAllowed,
} from "openclaw/plugin-sdk/mqtt-hooks";
import type { MqttMessageEnvelope, MqttSubscriptionConfig } from "./types.js";

export type MqttIngressDispatchers = {
  dispatchWake: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgent: (value: HookAgentDispatchPayload) => IngressAgentDispatchResult;
};

export type MqttDispatchResult =
  | { ok: true; runId?: string; completion?: Promise<void> }
  | { ok: false; error: string };

function buildTemplateContext(envelope: MqttMessageEnvelope) {
  return {
    payload: envelope as unknown as Record<string, unknown>,
    path: envelope.topic,
  };
}

function resolveChannel(raw: MqttSubscriptionConfig["channel"]):
  | {
      ok: true;
      value: HookMessageChannel;
    }
  | { ok: false; error: string } {
  const channel = resolveHookChannel(raw);
  if (!channel) {
    return { ok: false, error: getHookChannelError() };
  }
  return { ok: true, value: channel };
}

export function dispatchMqttEnvelope(params: {
  subscription: MqttSubscriptionConfig;
  envelope: MqttMessageEnvelope;
  policies: IngressDispatchPoliciesResolved;
  dispatchers: MqttIngressDispatchers;
}): MqttDispatchResult {
  const templateContext = buildTemplateContext(params.envelope);

  if (params.subscription.action === "wake") {
    const text = renderIngressTemplate(
      params.subscription.textTemplate ?? "",
      templateContext,
    ).trim();
    if (!text) {
      return {
        ok: false,
        error: `wake subscription ${params.subscription.id} rendered an empty text payload`,
      };
    }
    params.dispatchers.dispatchWake({
      text,
      mode: params.subscription.wakeMode,
    });
    return { ok: true };
  }

  const channel = resolveChannel(params.subscription.channel);
  if (!channel.ok) {
    return channel;
  }
  if (!isHookAgentAllowed(params.policies, params.subscription.agentId)) {
    return { ok: false, error: getHookAgentPolicyError() };
  }
  const sessionKey = resolveHookSessionKey({
    policies: params.policies,
    source: "mapping",
    sessionKey: params.subscription.sessionKey,
  });
  if (!sessionKey.ok) {
    return sessionKey;
  }
  const targetAgentId = resolveHookTargetAgentId(params.policies, params.subscription.agentId);
  const message = renderIngressTemplate(
    params.subscription.messageTemplate ?? "",
    templateContext,
  ).trim();
  if (!message) {
    return {
      ok: false,
      error: `agent subscription ${params.subscription.id} rendered an empty message payload`,
    };
  }

  const dispatch = params.dispatchers.dispatchAgent({
    message,
    name: params.subscription.name,
    agentId: targetAgentId,
    wakeMode: params.subscription.wakeMode,
    sessionKey: normalizeHookDispatchSessionKey({
      sessionKey: sessionKey.value,
      targetAgentId,
    }),
    deliver: resolveHookDeliver(params.subscription.deliver),
    channel: channel.value,
    to: params.subscription.to,
    model: params.subscription.model,
    thinking: params.subscription.thinking,
    timeoutSeconds: params.subscription.timeoutSeconds,
  });

  return { ok: true, runId: dispatch.runId, completion: dispatch.completion };
}
