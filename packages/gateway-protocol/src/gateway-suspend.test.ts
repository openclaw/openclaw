import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { validateGatewaySuspendHandoffParams, GatewaySuspendHandoffResultSchema } from "./index.js";

describe("gateway suspension protocol", () => {
  it("requires an exact handoff target and rejects unrelated interruption policy", () => {
    const target = { pid: 1, processInstanceId: "gateway-process" };
    const params = { suspensionId: "held-lease", target };
    expect(validateGatewaySuspendHandoffParams(params)).toBe(true);
    expect(validateGatewaySuspendHandoffParams({ ...params, commit: true })).toBe(true);
    for (const rejected of [
      { ...params, target: undefined },
      { ...params, force: true },
      { ...params, waitMs: 0 },
      { ...params, commit: false },
      { ...params, commit: "true" },
      { ...params, target: { ...target, processInstanceId: " " } },
      { ...params, target: { ...target, pid: 0 } },
      { ...params, target: { ...target, port: 18789 } },
      { ...params, target: { ...target, successor: "other" } },
    ]) {
      expect(validateGatewaySuspendHandoffParams(rejected)).toBe(false);
    }
    const receipt = { suspensionId: "held-lease", expiresAtMs: 2_000 };
    expect(Value.Check(GatewaySuspendHandoffResultSchema, { ...receipt, status: "armed" })).toBe(
      true,
    );
    expect(
      Value.Check(GatewaySuspendHandoffResultSchema, { ...receipt, status: "committed" }),
    ).toBe(true);
    expect(
      Value.Check(GatewaySuspendHandoffResultSchema, { ...receipt, status: "scheduled" }),
    ).toBe(false);
  });
});
