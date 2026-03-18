import { normalizeObservation } from "./perception/index";
import { createPlan } from "./planner/planner";
import { evaluatePolicy } from "./policy/policy";
import { executeAction } from "./executor/executor";
import { verifyResult } from "./verifier/verifier";

export class OperatorNode {
  async run(goal, rawObservation, context) {
    const observation = normalizeObservation(rawObservation);

    const plan = createPlan(goal, observation);

    const policy = evaluatePolicy(plan, context);

    if (!policy.allowed) {
      return {
        status: "blocked",
        policy
      };
    }

    const results = [];

    for (const step of plan.steps) {
      if (!step.action) continue;

      const result = await executeAction(step.action);
      results.push(result);

      const verification = verifyResult(step.expected, observation);

      if (!verification.success) {
        return {
          status: "failed",
          step,
          verification
        };
      }
    }

    return {
      status: "completed",
      results
    };
  }
}
