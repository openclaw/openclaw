import { describe, expect, it } from "vitest";
import {
  isKimiCodingThinkingModelId,
  isKimiK3ModelId,
  resolveThinkingProfile,
} from "./provider-policy-api.js";

describe("Kimi Code provider policy", () => {
  it.each(["k3", "k3-256k"])("exposes adaptive K3 thinking levels for %s", (modelId) => {
    expect(resolveThinkingProfile({ provider: "kimi", modelId })).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "high" },
        { id: "adaptive" },
        { id: "xhigh" },
        { id: "max" },
      ],
      defaultLevel: "high",
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it.each(["kimi-for-coding", "kimi-for-coding-highspeed"])(
    "exposes K2.8 thinking levels with max by default for %s",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "kimi", modelId })).toEqual({
        levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
        defaultLevel: "max",
      });
    },
  );

  it.each(["kimi-code", "k2p5", "KIMI-CODE"])(
    "treats legacy alias %s as the K2.8 coding model",
    (modelId) => {
      expect(resolveThinkingProfile({ provider: "kimi", modelId })).toEqual({
        levels: [{ id: "off" }, { id: "low" }, { id: "high" }, { id: "max" }],
        defaultLevel: "max",
      });
    },
  );

  it("keeps unknown Kimi models binary and off by default", () => {
    expect(resolveThinkingProfile({ provider: "kimi", modelId: "kimi-k2.6" })).toEqual({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
      defaultLevel: "off",
    });
  });

  it("recognizes K3 wire ids case-insensitively", () => {
    expect(isKimiK3ModelId("K3")).toBe(true);
    expect(isKimiK3ModelId("K3-256K")).toBe(true);
    expect(isKimiK3ModelId("kimi-for-coding")).toBe(false);
  });

  it("recognizes K2.8 coding ids case-insensitively", () => {
    expect(isKimiCodingThinkingModelId("kimi-for-coding")).toBe(true);
    expect(isKimiCodingThinkingModelId("kimi-for-coding-highspeed")).toBe(true);
    expect(isKimiCodingThinkingModelId("kimi-code")).toBe(true);
    expect(isKimiCodingThinkingModelId("k3")).toBe(false);
  });
});
