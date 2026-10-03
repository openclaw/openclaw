import type {
  HealthCheck,
  HealthCheckContext,
  HealthFinding,
  HealthRepairContext,
} from "openclaw/plugin-sdk/health";
import type { POLICY_CHECK_IDS } from "./check-ids.js";
import type { PolicyEvaluation } from "./types.js";

type PolicyDoctorCheckDefinition = readonly [
  id: (typeof POLICY_CHECK_IDS)[number],
  description: string,
  repair?: (
    ctx: HealthRepairContext,
    findings: readonly HealthFinding[],
    checkId: (typeof POLICY_CHECK_IDS)[number],
  ) => ReturnType<NonNullable<HealthCheck["repair"]>>,
];

export function createPolicyScopedChecks(
  deps: {
    evaluatePolicy: (ctx: HealthCheckContext) => Promise<PolicyEvaluation>;
    findingsForCheck: (
      evaluation: PolicyEvaluation,
      checkId: (typeof POLICY_CHECK_IDS)[number],
    ) => readonly HealthFinding[];
  },
  definitions: readonly PolicyDoctorCheckDefinition[],
): readonly HealthCheck[] {
  const { evaluatePolicy, findingsForCheck } = deps;
  return definitions.map(([id, description, repair]) => ({
    id,
    kind: "plugin",
    description,
    source: "policy",
    async detect(ctx) {
      return findingsForCheck(await evaluatePolicy(ctx), id);
    },
    ...(repair ? { repair: (ctx, findings) => repair(ctx, findings, id) } : {}),
  }));
}
