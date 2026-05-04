import {
  writeCoordinationStepResult,
  type CoordinationStepResult,
  type CoordinationStepResultWriteResult,
} from "./step-result-writer.js";
import type {
  CoordinationAllowedCommandPolicy,
  CoordinationWorkAuthorizationContract,
} from "./work-authorization-contract.js";

export type CoordinationPlannedStep = {
  step_id: string;
  step_name: string;
  planned_files: string[];
  command_category: CoordinationAllowedCommandPolicy["category"];
  proof_attempt_id: string;
};

export type CoordinationStepExecutionResult = Omit<CoordinationStepResult, "authorization_id">;

export type CoordinationBoundedBuildLoopResult = {
  authorization_id: string;
  status: "pass" | "fail" | "blocked";
  steps_completed: number;
  steps_attempted: string[];
  final_step_id: string | null;
  stop_reason: string;
  step_artifacts: CoordinationStepResultWriteResult[];
  next_step_recommendation: string | null;
};

export class CoordinationBoundedBuildLoopError extends Error {
  readonly code:
    | "step_outside_allowed_roots"
    | "forbidden_command_category"
    | "max_runtime_steps_exceeded";

  constructor(code: CoordinationBoundedBuildLoopError["code"], message: string) {
    super(message);
    this.name = "CoordinationBoundedBuildLoopError";
    this.code = code;
  }
}

export async function runBoundedCoordinationBuildLoop(input: {
  authorization: CoordinationWorkAuthorizationContract;
  plannedSteps: CoordinationPlannedStep[];
  executeStep: (step: CoordinationPlannedStep) => Promise<CoordinationStepExecutionResult>;
  writeStepResult?: typeof writeCoordinationStepResult;
}): Promise<CoordinationBoundedBuildLoopResult> {
  const writeStep = input.writeStepResult ?? writeCoordinationStepResult;
  const incompleteSteps = [...input.plannedSteps];
  const stepArtifacts: CoordinationStepResultWriteResult[] = [];
  const stepsAttempted: string[] = [];

  if (incompleteSteps.length > input.authorization.max_runtime_steps) {
    throw new CoordinationBoundedBuildLoopError(
      "max_runtime_steps_exceeded",
      "planned steps exceed authorization max_runtime_steps",
    );
  }

  for (const step of incompleteSteps) {
    assertStepWithinScope(input.authorization, step);
    stepsAttempted.push(step.step_id);

    const execution = await input.executeStep(step);
    const stepResult: CoordinationStepResult = {
      ...execution,
      authorization_id: input.authorization.authorization_id,
    };
    const artifact = await writeStep(input.authorization, stepResult);
    stepArtifacts.push(artifact);

    if (execution.status === "blocked") {
      return {
        authorization_id: input.authorization.authorization_id,
        status: "blocked",
        steps_completed: stepArtifacts.length - 1,
        steps_attempted: stepsAttempted,
        final_step_id: step.step_id,
        stop_reason: execution.blocker_reason ?? "step_blocked",
        step_artifacts: stepArtifacts,
        next_step_recommendation: execution.next_step_recommendation,
      };
    }

    if (execution.status === "fail") {
      return {
        authorization_id: input.authorization.authorization_id,
        status: "fail",
        steps_completed: stepArtifacts.length - 1,
        steps_attempted: stepsAttempted,
        final_step_id: step.step_id,
        stop_reason: execution.blocker_reason ?? "step_failed",
        step_artifacts: stepArtifacts,
        next_step_recommendation: execution.next_step_recommendation,
      };
    }
  }

  return {
    authorization_id: input.authorization.authorization_id,
    status: "pass",
    steps_completed: stepArtifacts.length,
    steps_attempted: stepsAttempted,
    final_step_id: stepsAttempted.at(-1) ?? null,
    stop_reason: "all_steps_passed",
    step_artifacts: stepArtifacts,
    next_step_recommendation: null,
  };
}

function assertStepWithinScope(
  authorization: CoordinationWorkAuthorizationContract,
  step: CoordinationPlannedStep,
): void {
  const allowedRoots = authorization.allowed_work_roots;
  for (const filePath of step.planned_files) {
    if (!allowedRoots.some((root) => filePath === root || filePath.startsWith(`${root}/`))) {
      throw new CoordinationBoundedBuildLoopError(
        "step_outside_allowed_roots",
        `planned file is outside allowed roots: ${filePath}`,
      );
    }
  }

  const allowedCategories = authorization.allowed_commands.map((entry) => entry.category);
  if (!allowedCategories.includes(step.command_category)) {
    throw new CoordinationBoundedBuildLoopError(
      "forbidden_command_category",
      `command category is not authorized: ${step.command_category}`,
    );
  }
}
