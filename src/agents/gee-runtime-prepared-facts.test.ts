import { describe, expect, it } from "vitest";
import { resolveGeeRuntimeProviderAuthPolicy } from "./gee-runtime-prepared-facts.js";

function createPreparedFact(params: {
  endpointId?: string;
  modelRef?: string;
  credentialRef?: string;
  eligibility?: "ok" | "expired" | "missing" | "unresolved";
}) {
  const endpointId = params.endpointId ?? "telegram:geeclaw";
  return {
    [endpointId]: {
      kind: "gee-runtime-prepared-facts",
      version: 1,
      hostMode: "gee-hosted",
      envelope: {
        provider: {
          modelRef: params.modelRef ?? "custom-openai/test-model",
          routingPolicyId: "gee-routing-main",
          fallbackPolicyId: "gee-fallback-main",
          cooldownPolicyId: "gee-cooldown-main",
        },
        auth: {
          credentialRef: params.credentialRef ?? "gee-credential-main",
          eligibility: params.eligibility ?? "ok",
        },
      },
    },
  };
}

describe("resolveGeeRuntimeProviderAuthPolicy", () => {
  it("extracts Gee-owned provider, auth, fallback, and cooldown facts", () => {
    expect(resolveGeeRuntimeProviderAuthPolicy(createPreparedFact({}))).toEqual({
      endpointIds: ["telegram:geeclaw"],
      modelRefs: ["custom-openai/test-model"],
      routingPolicyIds: ["gee-routing-main"],
      fallbackPolicyIds: ["gee-fallback-main"],
      cooldownPolicyIds: ["gee-cooldown-main"],
      credentialRefs: ["gee-credential-main"],
      authEligibility: "ok",
    });
  });

  it("fails closed when a Gee-hosted auth fact is missing", () => {
    const preparedFacts = createPreparedFact({});
    delete (preparedFacts["telegram:geeclaw"].envelope.auth as { credentialRef?: string })
      .credentialRef;

    expect(() => resolveGeeRuntimeProviderAuthPolicy(preparedFacts)).toThrow(
      'Gee-hosted OpenClaw endpoint "telegram:geeclaw" has invalid prepared runtime fact "envelope.auth.credentialRef".',
    );
  });

  it("rejects conflicting auth eligibility across Gee-hosted endpoints", () => {
    expect(() =>
      resolveGeeRuntimeProviderAuthPolicy({
        ...createPreparedFact({ endpointId: "telegram:geeclaw", eligibility: "ok" }),
        ...createPreparedFact({ endpointId: "slack:geeclaw", eligibility: "expired" }),
      }),
    ).toThrow(/conflicting auth eligibility states/);
  });
});
