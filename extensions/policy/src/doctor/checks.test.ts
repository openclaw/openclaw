import type { HealthCheckContext, HealthFinding } from "openclaw/plugin-sdk/health";
import { describe, expect, it, vi } from "vitest";
import { CHECK_IDS } from "./check-ids.js";
import { createPolicyDoctorChecks } from "./checks.js";
import { evaluatePolicy } from "./evaluation.js";
import type { PolicyEvaluation } from "./types.js";

vi.mock("./evaluation.js", () => ({ evaluatePolicy: vi.fn() }));

const context: HealthCheckContext = {
  mode: "lint",
  cfg: {},
  runtime: { log() {}, error() {}, exit() {} },
};

describe("policy health check evaluation", () => {
  it("selects each registered check's findings after evaluation completes", async () => {
    const findings: HealthFinding[] = [
      { checkId: CHECK_IDS.policyMissingFile, severity: "error", message: "Missing policy." },
      { checkId: CHECK_IDS.policyInvalidFile, severity: "error", message: "Invalid policy." },
    ];
    const evaluation = Promise.withResolvers<PolicyEvaluation>();
    vi.mocked(evaluatePolicy).mockReturnValue(evaluation.promise);
    const checks = createPolicyDoctorChecks();
    const results = checks.slice(0, 3).map((check) => check.detect(context));
    expect(evaluatePolicy).toHaveBeenCalledWith(context);

    evaluation.resolve({
      policyPath: "policy.jsonc",
      evidence: { channels: [], mcpServers: [], modelProviders: [], modelRefs: [], network: [] },
      findings,
      attestedFindings: findings,
    });
    await expect(Promise.all(results)).resolves.toEqual([[findings[0]], [findings[1]], []]);
  });

  it("propagates evaluation failures", async () => {
    const failure = new Error("policy evaluation failed");
    vi.mocked(evaluatePolicy).mockRejectedValue(failure);
    const [check] = createPolicyDoctorChecks();

    await expect(check!.detect(context)).rejects.toBe(failure);
  });
});
