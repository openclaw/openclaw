/**
 * sandbox-playbook-runner.ts — 共享 Playbook 沙盒干跑（draft review + evolution regression）
 */
import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import type { SimulateStepLog } from "../planes/orch/playbook-simulator.js";
import { createPlaybookSimulator } from "../planes/orch/playbook-simulator.js";

export type SandboxSimulateOptions = {
  testPayload?: Record<string, unknown>;
  /** draft review 路径附加 _draft_review */
  draftReview?: boolean;
};

export type SandboxPlaybookSimulationResult = {
  passed: boolean;
  status: "ok" | "error";
  error?: string;
  duration_ms?: number;
  step_count?: number;
};

type PlaybookRunStep = {
  stepId: string;
  status: string;
  output?: unknown;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
};

type PlaybookEngineLike = ClaworksRuntime["playbookEngine"] & {
  trigger?: (
    pid: string,
    event: Record<string, unknown>,
    opts?: { variables?: Record<string, unknown> },
  ) => Promise<{ steps?: PlaybookRunStep[]; error?: string; status?: string } | undefined>;
};

export function buildSandboxSimulateVariables(
  opts: SandboxSimulateOptions = {},
): Record<string, unknown> {
  return {
    ...(opts.testPayload ?? {}),
    _simulate: true,
    _sandbox: true,
    ...(opts.draftReview ? { _draft_review: true } : {}),
  };
}

function mapRunStepsToSimulateSteps(runSteps: PlaybookRunStep[]): SimulateStepLog[] {
  const steps: SimulateStepLog[] = [];
  for (let i = 0; i < runSteps.length; i++) {
    const s = runSteps[i]!;
    const durationMs =
      s.completedAt && s.startedAt ? s.completedAt.getTime() - s.startedAt.getTime() : 0;
    steps.push({
      step: i,
      type: s.stepId,
      name: s.stepId,
      status: s.status === "failed" ? "error" : "ok",
      durationMs,
      output: s.output,
      error: s.error,
    });
  }
  return steps;
}

export function createSandboxPlaybookTriggerRunner(
  playbookEngine: PlaybookEngineLike,
  opts: SandboxSimulateOptions = {},
) {
  return async (
    pid: string,
    initVars: Record<string, unknown>,
    trigEvent: Record<string, unknown>,
    _mockStore: unknown,
  ): Promise<{ steps: SimulateStepLog[]; error?: string }> => {
    const steps: SimulateStepLog[] = [];
    if (!playbookEngine?.trigger) {
      return { steps, error: "playbookEngine.trigger 不可用" };
    }
    try {
      const variables = buildSandboxSimulateVariables({
        testPayload: { ...initVars, ...(opts.testPayload ?? {}) },
        draftReview: opts.draftReview,
      });
      const run = await playbookEngine.trigger(
        pid,
        typeof trigEvent === "object" && trigEvent !== null && !Array.isArray(trigEvent)
          ? (trigEvent as Record<string, unknown>)
          : {},
        { variables },
      );
      if (run?.steps) {
        steps.push(...mapRunStepsToSimulateSteps(run.steps));
      }
      return { steps, error: run?.error };
    } catch (e) {
      return { steps, error: String(e) };
    }
  };
}

export async function runSandboxPlaybookSimulation(
  playbookEngine: PlaybookEngineLike,
  playbookId: string,
  opts: {
    testPayload?: Record<string, unknown>;
    triggerEventType: string;
    draftReview?: boolean;
  },
): Promise<SandboxPlaybookSimulationResult> {
  const simulator = createPlaybookSimulator(
    createSandboxPlaybookTriggerRunner(playbookEngine, {
      testPayload: opts.testPayload,
      draftReview: opts.draftReview,
    }),
  );
  const simulatePayload = buildSandboxSimulateVariables({
    testPayload: opts.testPayload,
    draftReview: opts.draftReview,
  });
  const result = await simulator.simulate(playbookId, simulatePayload, {
    type: opts.triggerEventType,
  });
  return {
    passed: result.status === "ok",
    status: result.status === "ok" ? "ok" : "error",
    error: result.error,
    duration_ms: result.duration_ms,
    step_count: result.steps.length,
  };
}
