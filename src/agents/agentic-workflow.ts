/**
 * Agentic Workflow - 结构化 Agent 流程设计
 *
 * 基于 Stanford HAI Agentic Workflow 设计模式
 * 返回可执行执行计划，包含具体步骤和检查点
 */

import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult, readNumberParam, readStringParam } from "./tools/common.js";

const log = createSubsystemLogger("workflow");

export type SolutionEvaluation = {
  score: number;
  feedback: string;
  issues: string[];
  strengths: string[];
};

export type ReflectionConfig = {
  maxIterations: number;
  minScore: number;
  enableParallelVerify: boolean;
};

type WorkflowStrategy = "reflection" | "divide_and_conquer" | "parallel_verify";

type WorkflowPhase = {
  id: string;
  name: string;
  description: string;
  steps: string[];
  checkpoints: string[];
  estimatedIterations?: number;
};

type WorkflowPlan = {
  phases: WorkflowPhase[];
  expectedIterations: number;
  qualityThreshold: number;
};

type WorkflowExecution = {
  plan: WorkflowPlan;
  execution: {
    currentPhase: number;
    currentStep: number;
    completedPhases: string[];
    issues: string[];
  };
  nextActions: string[];
  toolRecommendations: Array<{
    tool: string;
    purpose: string;
    priority: "required" | "recommended" | "optional";
  }>;
};

export class AgenticWorkflow {
  private readonly config: ReflectionConfig;

  constructor(config?: Partial<ReflectionConfig>) {
    this.config = {
      maxIterations: config?.maxIterations ?? 5,
      minScore: config?.minScore ?? 0.8,
      enableParallelVerify: config?.enableParallelVerify ?? true,
    };
  }

  getConfig(): ReflectionConfig {
    return { ...this.config };
  }
}

function generateExecutionPlan(task: string, strategy: WorkflowStrategy): WorkflowExecution {
  const plan = generateWorkflowPlan(task, strategy);

  const toolRecommendations = getToolRecommendations(strategy);

  const nextActions = getNextActions(plan.phases[0]);

  return {
    plan,
    execution: {
      currentPhase: 1,
      currentStep: 1,
      completedPhases: [],
      issues: [],
    },
    nextActions,
    toolRecommendations,
  };
}

function generateWorkflowPlan(task: string, strategy: WorkflowStrategy): WorkflowPlan {
  const basePlan: WorkflowPlan = {
    phases: [],
    expectedIterations: 3,
    qualityThreshold: 0.8,
  };

  switch (strategy) {
    case "reflection":
      basePlan.phases = [
        {
          id: "phase-1",
          name: "Initial Solution",
          description: "Generate an initial solution based on understanding",
          steps: [
            "Analyze the task requirements and constraints",
            "Gather relevant context from memory",
            "Generate initial approach or solution",
          ],
          checkpoints: [
            "Does the solution address all requirements?",
            "Are there any obvious issues or gaps?",
            "Is the approach feasible?",
          ],
        },
        {
          id: "phase-2",
          name: "Self-Evaluation",
          description: "Critically evaluate the initial solution",
          steps: [
            "Review the solution against each requirement",
            "Identify weaknesses, gaps, and potential issues",
            "Score the solution quality (0-1 scale)",
          ],
          checkpoints: [
            "What is the current quality score?",
            "What are the main issues to address?",
            "Is the score above the threshold?",
          ],
        },
        {
          id: "phase-3",
          name: "Iteration",
          description: "Improve based on evaluation feedback",
          steps: [
            "Address identified issues in priority order",
            "Strengthen weak areas of the solution",
            "Re-evaluate quality after changes",
          ],
          checkpoints: [
            "Has quality improved?",
            "Is the threshold (0.8) reached?",
            "Any new issues introduced?",
          ],
          estimatedIterations: 3,
        },
      ];
      basePlan.expectedIterations = 3;
      break;

    case "divide_and_conquer":
      basePlan.phases = [
        {
          id: "phase-1",
          name: "Decomposition",
          description: "Break down the complex task into smaller subtasks",
          steps: [
            "Use task_decompose to identify major components",
            "Define clear boundaries and dependencies",
            "Prioritize subtasks by importance",
          ],
          checkpoints: [
            "Are subtasks well-defined and independent?",
            "Are dependencies between subtasks clear?",
            "Is the decomposition complete?",
          ],
        },
        {
          id: "phase-2",
          name: "Parallel Execution",
          description: "Execute independent subtasks",
          steps: [
            "Identify which subtasks can run in parallel",
            "Execute parallel subtasks efficiently",
            "Track progress of each subtask",
          ],
          checkpoints: [
            "Are all parallel tasks complete?",
            "Are results consistent with requirements?",
            "Any conflicts between subtask results?",
          ],
        },
        {
          id: "phase-3",
          name: "Integration",
          description: "Combine results from all subtasks",
          steps: [
            "Merge results according to dependencies",
            "Resolve any conflicts between components",
            "Verify the integrated solution",
          ],
          checkpoints: [
            "Does the integrated solution meet all requirements?",
            "Are there any gaps or inconsistencies?",
            "Is the solution complete?",
          ],
        },
      ];
      basePlan.expectedIterations = 1;
      break;

    case "parallel_verify":
      basePlan.phases = [
        {
          id: "phase-1",
          name: "Solution Generation",
          description: "Generate the primary solution",
          steps: [
            "Develop the solution approach",
            "Implement the solution",
            "Prepare for verification",
          ],
          checkpoints: [
            "Is the solution complete?",
            "Is it ready for verification?",
            "Are all requirements addressed?",
          ],
        },
        {
          id: "phase-2",
          name: "Multi-Perspective Verification",
          description: "Verify solution from multiple angles",
          steps: [
            "Critic perspective: Find logical flaws and inconsistencies",
            "Tester perspective: Identify edge cases and failure modes",
            "Reviewer perspective: Check completeness and best practices",
          ],
          checkpoints: [
            "What issues did each perspective find?",
            "Are there critical issues that must be fixed?",
            "What is the overall quality assessment?",
          ],
        },
        {
          id: "phase-3",
          name: "Consolidation",
          description: "Address all verification findings",
          steps: [
            "Prioritize issues by severity (critical/high/medium/low)",
            "Fix critical and high-priority issues first",
            "Re-verify fixes",
          ],
          checkpoints: [
            "Are all critical issues resolved?",
            "Is the solution robust?",
            "Ready for delivery?",
          ],
        },
      ];
      basePlan.expectedIterations = 2;
      break;
  }

  return basePlan;
}

function getToolRecommendations(strategy: WorkflowStrategy): Array<{
  tool: string;
  purpose: string;
  priority: "required" | "recommended" | "optional";
}> {
  const common: Array<{
    tool: string;
    purpose: string;
    priority: "required" | "recommended" | "optional";
  }> = [
    { tool: "memory_search", purpose: "Retrieve relevant context", priority: "recommended" },
  ];

  switch (strategy) {
    case "reflection":
      return [
        { tool: "task_decompose", purpose: "Break down complex requirements", priority: "optional" },
        { tool: "self_rag", purpose: "Get context with confidence assessment", priority: "recommended" },
        ...common,
      ];
    case "divide_and_conquer":
      return [
        { tool: "task_decompose", purpose: "Decompose into subtasks", priority: "required" },
        { tool: "self_rag", purpose: "Context for each subtask", priority: "recommended" },
        ...common,
      ];
    case "parallel_verify":
      return [
        { tool: "task_decompose", purpose: "Identify verification dimensions", priority: "optional" },
        { tool: "self_rag", purpose: "Reference material for verification", priority: "recommended" },
        ...common,
      ];
  }
}

function getNextActions(phase: WorkflowPhase | undefined): string[] {
  if (!phase) {
    return ["Task plan generated. Ready to begin execution."];
  }

  return [
    `Current Phase: ${phase.name}`,
    ...phase.steps.slice(0, 3).map((step, i) => `${i + 1}. ${step}`),
  ];
}

function getWorkflowRecommendation(strategy: WorkflowStrategy): string {
  switch (strategy) {
    case "reflection":
      return "Iterate until quality threshold (0.8) is reached. Use self_rag to gather context before each iteration.";
    case "divide_and_conquer":
      return "Ensure subtasks are truly independent before parallel execution. Use task_decompose for structured decomposition.";
    case "parallel_verify":
      return "Use all three perspectives for comprehensive verification. Critical issues must be resolved before proceeding.";
  }
}

export function createAgenticWorkflowTool(options?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options?.config;
  if (!cfg) {
    return null;
  }

  resolveSessionAgentId({
    sessionKey: options?.agentSessionKey,
    config: cfg,
  });

  return {
    name: "agentic_workflow",
    label: "Agentic Workflow",
    description:
      "Get a structured execution plan for complex tasks. Returns phased plan with checkpoints, tool recommendations, and next actions. Use for complex tasks requiring systematic approach.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The complex problem to plan for",
        },
        strategy: {
          type: "string",
          enum: ["reflection", "divide_and_conquer", "parallel_verify"],
          description:
            "Strategy: reflection (iterate), divide_and_conquer (parallel subtasks), parallel_verify (multi-angle verification)",
        },
        maxIterations: {
          type: "number",
          description: "Maximum iterations for reflection strategy (default: 3)",
        },
        qualityThreshold: {
          type: "number",
          description: "Quality threshold 0-1 to stop iteration (default: 0.8)",
        },
      },
      required: ["task"],
    },
    execute: async (_toolCallId, params) => {
      const task = readStringParam(params, "task", { required: true });
      const strategy = (readStringParam(params, "strategy") ?? "reflection") as WorkflowStrategy;
      const maxIterations = readNumberParam(params, "maxIterations") ?? 3;
      const qualityThreshold = readNumberParam(params, "qualityThreshold") ?? 0.8;

      log.debug(`agentic_workflow: task="${task.substring(0, 50)}..." strategy=${strategy}`);

      const workflow = new AgenticWorkflow({
        maxIterations,
        minScore: qualityThreshold,
      });

      const execution = generateExecutionPlan(task, strategy);

      execution.plan.phases.forEach((phase) => {
        if (phase.id === "phase-3" && strategy === "reflection") {
          phase.estimatedIterations = maxIterations;
        }
      });

      execution.plan.expectedIterations = maxIterations;
      execution.plan.qualityThreshold = qualityThreshold;

      const recommendation = getWorkflowRecommendation(strategy);

      log.debug(
        `agentic_workflow: ${execution.plan.phases.length} phases, ${execution.toolRecommendations.length} tool recommendations`,
      );

      return jsonResult({
        task,
        strategy,
        config: workflow.getConfig(),
        plan: execution.plan,
        execution: execution.execution,
        nextActions: execution.nextActions,
        toolRecommendations: execution.toolRecommendations,
        recommendation,
      });
    },
  };
}
