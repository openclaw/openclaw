import { describe, expect, it } from "vitest";
import {
  buildGeeRuntimePreparedFacts,
  GeeRuntimeEnvelopeValidationError,
  type GeeRuntimeEnvelope,
} from "./gee-runtime-envelope.js";
import type { TurnOwnerDecision } from "./mcp-thread-config.js";

const GEE_ENDPOINT_ID = "telegram:geeclaw";

function createGeeDecision(): TurnOwnerDecision {
  return {
    owner: "gee",
    reason: "endpoint-owner",
    endpointId: GEE_ENDPOINT_ID,
    threadOwnerId: "geeclaw",
    geeId: "geeclaw",
    auditId: "audit-geeclaw-telegram",
  };
}

function createGeeRuntimeEnvelope(): GeeRuntimeEnvelope {
  return {
    kind: "gee-runtime-envelope",
    version: 1,
    owner: "gee",
    geeId: "geeclaw",
    requestId: "request-123",
    auditId: "audit-geeclaw-telegram",
    endpoint: {
      channel: "telegram",
      accountId: "telegram:bot:geeclaw",
      endpointId: GEE_ENDPOINT_ID,
      externalIdentity: "@geeclaw",
    },
    conversation: {
      sessionKey: "telegram:geeclaw:user-42",
      threadId: "thread-123",
      threadOwner: "gee",
    },
    provider: {
      modelRef: "codex:gpt-5.4",
      routingPolicyId: "gee-provider-default",
      fallbackPolicyId: "gee-fallback-default",
      cooldownPolicyId: "gee-cooldown-default",
    },
    auth: {
      credentialRef: "gee://credentials/openai/work",
      eligibility: "ok",
    },
    tools: {
      capabilityPlanId: "gee-tools-default",
      allowedToolIds: ["message.send", "memory.search"],
      policy: "gee-authorized",
    },
    delivery: {
      policyId: "gee-native-outbox",
      accountId: "telegram:bot:geeclaw",
      outboundTarget: "telegram:chat:42",
      confirmationPolicy: "native-outbox-only",
    },
    compaction: {
      owner: "gee",
      hostCompactionId: "gee-compaction-default",
    },
  };
}

describe("Gee runtime envelope prepared facts", () => {
  it("builds stable prepared facts for Gee-hosted OpenClaw turns", () => {
    const result = buildGeeRuntimePreparedFacts({
      ownershipDecisions: { [GEE_ENDPOINT_ID]: createGeeDecision() },
      envelopeSources: { [GEE_ENDPOINT_ID]: createGeeRuntimeEnvelope() },
    });

    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.preparedFacts).toEqual({
      [GEE_ENDPOINT_ID]: {
        kind: "gee-runtime-prepared-facts",
        version: 1,
        hostMode: "gee-hosted",
        envelope: createGeeRuntimeEnvelope(),
      },
    });
    expect(result.serialized).toMatchObject({
      [GEE_ENDPOINT_ID]: {
        hostMode: "gee-hosted",
        envelope: {
          owner: "gee",
          endpoint: { endpointId: GEE_ENDPOINT_ID },
          auth: { credentialRef: "gee://credentials/openai/work" },
        },
      },
    });
  });

  it.each(["provider", "auth", "tools", "delivery", "compaction"] as const)(
    "fails closed when Gee-hosted turns are missing %s facts",
    (fieldName) => {
      const envelope = createGeeRuntimeEnvelope() as Record<string, unknown>;
      delete envelope[fieldName];

      expect(() =>
        buildGeeRuntimePreparedFacts({
          ownershipDecisions: { [GEE_ENDPOINT_ID]: createGeeDecision() },
          envelopeSources: { [GEE_ENDPOINT_ID]: envelope },
        }),
      ).toThrow(GeeRuntimeEnvelopeValidationError);
      try {
        buildGeeRuntimePreparedFacts({
          ownershipDecisions: { [GEE_ENDPOINT_ID]: createGeeDecision() },
          envelopeSources: { [GEE_ENDPOINT_ID]: envelope },
        });
      } catch (error) {
        expect(error).toMatchObject({
          code: "openclaw_gee_runtime_missing_fact",
          endpointId: GEE_ENDPOINT_ID,
          fieldName,
        });
      }
    },
  );

  it("rejects raw credential material in hosted auth facts", () => {
    const envelope = createGeeRuntimeEnvelope();
    const rawEnvelope = {
      ...envelope,
      auth: { ...envelope.auth, apiKey: "sk-raw-secret" },
    };

    expect(() =>
      buildGeeRuntimePreparedFacts({
        ownershipDecisions: { [GEE_ENDPOINT_ID]: createGeeDecision() },
        envelopeSources: { [GEE_ENDPOINT_ID]: rawEnvelope },
      }),
    ).toThrow(GeeRuntimeEnvelopeValidationError);
  });

  it("does not require Gee state for standalone OpenClaw ownership decisions", () => {
    const result = buildGeeRuntimePreparedFacts({
      ownershipDecisions: {
        "local-acp": {
          owner: "openclaw",
          reason: "standalone-default",
          endpointId: "local-acp",
          auditId: "mcp:local-acp",
        },
      },
    });

    expect(result).toEqual({});
  });
});
