import { describe, expect, it, vi } from "vitest";
import { dispatchMqttEnvelope } from "./dispatch.js";
import type { MqttMessageEnvelope, MqttSubscriptionConfig } from "./types.js";

const policies = {
  agentPolicy: {
    defaultAgentId: "main",
    knownAgentIds: new Set(["main", "hooks"]),
    allowedAgentIds: new Set(["hooks"]),
  },
  sessionPolicy: {
    defaultSessionKey: "hook:mqtt",
    allowRequestSessionKey: false,
    allowedSessionKeyPrefixes: ["hook:"],
  },
};

const envelope: MqttMessageEnvelope = {
  subscriptionId: "alerts",
  topic: "home/alerts/kitchen",
  qos: 1,
  retain: false,
  duplicate: false,
  receivedAt: "2026-03-10T12:00:00.000Z",
  payloadSize: 24,
  payloadText: '{"message":"smoke"}',
  payloadJson: { message: "smoke" },
  semantic: {
    description: "Kitchen alert",
    intentHint: "Escalate if critical",
  },
};

describe("dispatchMqttEnvelope", () => {
  it("renders wake payloads through the shared template context", () => {
    const dispatchWake = vi.fn();
    const result = dispatchMqttEnvelope({
      subscription: {
        id: "wake",
        enabled: true,
        topic: "home/alerts/#",
        qos: 0,
        ignoreRetainedOnStartup: true,
        action: "wake",
        name: "MQTT wake",
        wakeMode: "next-heartbeat",
        textTemplate: "Topic={{topic}} Description={{semantic.description}}",
      },
      envelope,
      policies,
      dispatchers: {
        dispatchWake,
        dispatchAgent: vi.fn(),
      },
    });

    expect(result).toEqual({ ok: true });
    expect(dispatchWake).toHaveBeenCalledWith({
      text: "Topic=home/alerts/kitchen Description=Kitchen alert",
      mode: "next-heartbeat",
    });
  });

  it("dispatches agent payloads with normalized session routing", () => {
    const dispatchAgent = vi.fn(() => ({
      runId: "run-123",
      completion: Promise.resolve(),
    }));
    const result = dispatchMqttEnvelope({
      subscription: {
        id: "agent",
        enabled: true,
        topic: "home/alerts/#",
        qos: 1,
        ignoreRetainedOnStartup: true,
        action: "agent",
        name: "MQTT agent",
        agentId: "hooks",
        wakeMode: "now",
        deliver: true,
        channel: "last",
        sessionKey: "hook:mqtt:alerts",
        messageTemplate: "Description={{semantic.description}} Payload={{payloadText}}",
      },
      envelope,
      policies,
      dispatchers: {
        dispatchWake: vi.fn(),
        dispatchAgent,
      },
    });

    expect(result).toEqual({
      ok: true,
      runId: "run-123",
      completion: expect.any(Promise),
    });
    expect(dispatchAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Description=Kitchen alert Payload={"message":"smoke"}',
        agentId: "hooks",
        sessionKey: "hook:mqtt:alerts",
        deliver: true,
        channel: "last",
      }),
    );
  });

  it("rejects agent routing outside hooks.allowedAgentIds", () => {
    const badSubscription: MqttSubscriptionConfig = {
      id: "agent",
      enabled: true,
      topic: "home/alerts/#",
      qos: 1,
      ignoreRetainedOnStartup: true,
      action: "agent",
      name: "MQTT agent",
      agentId: "main",
      wakeMode: "now",
      messageTemplate: "Payload={{payloadText}}",
    };

    const result = dispatchMqttEnvelope({
      subscription: badSubscription,
      envelope,
      policies,
      dispatchers: {
        dispatchWake: vi.fn(),
        dispatchAgent: vi.fn(),
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("hooks.allowedAgentIds");
    }
  });
});
