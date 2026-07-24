import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  ModelRecoveryDivertNewParamsSchema,
  ModelRecoveryReleaseParamsSchema,
  ModelRecoveryStatusParamsSchema,
  ModelRecoveryStatusResultSchema,
} from "./model-recovery.js";
import { ProtocolSchemas } from "./protocol-schemas.js";

const target = {
  provider: "kalliope",
  model: "qwen3.6:35b-a3b",
  topologyGeneration: "mama-single-gpu-v7",
  fenceEpoch: 41,
  fenceToken: "fence-token-41",
};

describe("model recovery gateway schemas", () => {
  it("registers the model recovery capability schemas", () => {
    expect(ProtocolSchemas.ModelRecoveryStatusParams).toBe(ModelRecoveryStatusParamsSchema);
    expect(ProtocolSchemas.ModelRecoveryStatusResult).toBe(ModelRecoveryStatusResultSchema);
    expect(ProtocolSchemas.ModelRecoveryDivertNewParams).toBe(ModelRecoveryDivertNewParamsSchema);
    expect(ProtocolSchemas.ModelRecoveryReleaseParams).toBe(ModelRecoveryReleaseParamsSchema);
  });

  it("accepts exact divert-new and release fence identities", () => {
    expect(
      Value.Check(ModelRecoveryDivertNewParamsSchema, {
        ...target,
        resourceDomain: "mama-gpu-residency",
        deniedTargets: [
          { provider: "kalliope", model: "qwen3.6:27b" },
          { provider: "ornith", model: "qwen3.6:27b" },
        ],
      }),
    ).toBe(true);
    expect(Value.Check(ModelRecoveryReleaseParamsSchema, target)).toBe(true);
  });

  it("keeps status read-only and rejects blank or unknown fence fields", () => {
    expect(Value.Check(ModelRecoveryStatusParamsSchema, {})).toBe(true);
    expect(Value.Check(ModelRecoveryStatusParamsSchema, { provider: "kalliope" })).toBe(false);
    expect(
      Value.Check(ModelRecoveryDivertNewParamsSchema, {
        ...target,
        fenceToken: "",
      }),
    ).toBe(false);
    expect(
      Value.Check(ModelRecoveryReleaseParamsSchema, {
        ...target,
        extra: true,
      }),
    ).toBe(false);
    expect(
      Value.Check(ModelRecoveryReleaseParamsSchema, {
        ...target,
        fenceToken: "embedded whitespace",
      }),
    ).toBe(false);
  });

  it("exposes active fence and denial state without capability ambiguity", () => {
    expect(
      Value.Check(ModelRecoveryStatusResultSchema, {
        capability: "available",
        activeFences: [
          {
            ...target,
            mode: "divert_new",
            state: "active",
            resourceDomain: "mama-gpu-residency",
            deniedTargets: [{ provider: "ornith", model: "qwen3.6:27b" }],
            createdAtMs: 1_000,
            releasedAtMs: null,
          },
        ],
      }),
    ).toBe(true);
    expect(
      Value.Check(ModelRecoveryStatusResultSchema, {
        capability: "available",
      }),
    ).toBe(false);
  });
});
