import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type WorkflowStep = {
  id: string;
  agent: "claude-cli" | "codex";
  action: string;
  input?: string;
  requiresConfirm?: boolean;
};

export type WorkflowDefinition = {
  name: string;
  description: string;
  steps: WorkflowStep[];
};

const BUILTIN_WORKFLOWS: Record<string, WorkflowDefinition> = {
  "auto-pr": {
    name: "auto-pr",
    description: "分析需求 → 寫碼 → 測試 → 建立 PR",
    steps: [
      { id: "plan", agent: "claude-cli", action: "analyze-and-plan" },
      { id: "implement", agent: "codex", action: "implement-from-plan" },
      { id: "test", agent: "codex", action: "run-tests" },
      { id: "review", agent: "claude-cli", action: "self-review-diff" },
      { id: "push", agent: "codex", action: "create-pr", requiresConfirm: true },
    ],
  },
  "code-review": {
    name: "code-review",
    description: "拉取 PR diff → 多維度審查 → 彙報",
    steps: [
      { id: "fetch", agent: "claude-cli", action: "fetch-pr-diff" },
      { id: "security", agent: "claude-cli", action: "review-security" },
      { id: "perf", agent: "claude-cli", action: "review-performance" },
      { id: "arch", agent: "claude-cli", action: "review-architecture" },
      { id: "report", agent: "claude-cli", action: "synthesize-report" },
    ],
  },
  "daily-scan": {
    name: "daily-scan",
    description: "檢查 PR 狀態 → CI 結果 → 逾期提醒",
    steps: [
      { id: "list-prs", agent: "claude-cli", action: "list-open-prs" },
      { id: "check-ci", agent: "claude-cli", action: "check-ci-status" },
      { id: "notify", agent: "claude-cli", action: "format-notification" },
    ],
  },
  "refactor": {
    name: "refactor",
    description: "分析目標 → 重構 → 測試 → 提交",
    steps: [
      { id: "analyze", agent: "claude-cli", action: "analyze-refactor-target" },
      { id: "refactor", agent: "codex", action: "execute-refactor" },
      { id: "test", agent: "codex", action: "run-tests" },
      { id: "commit", agent: "codex", action: "commit-changes", requiresConfirm: true },
    ],
  },
};

export function createWorkflowTool(api: OpenClawPluginApi) {
  return {
    name: "automation_workflow",
    label: "Workflow Engine",
    description:
      "Execute or list multi-step automation workflows. Each workflow chains Claude CLI and Codex CLI " +
      "steps with optional confirmation gates. Built-in workflows: auto-pr, code-review, daily-scan, refactor. " +
      "Can also define custom workflows on the fly.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("list"), Type.Literal("run"), Type.Literal("define"), Type.Literal("status")],
        { description: "Action: list available workflows, run one, define a new one, or check status" },
      ),
      workflowName: Type.Optional(
        Type.String({ description: "Name of the workflow to run or define" }),
      ),
      input: Type.Optional(
        Type.String({ description: "Input/context for the workflow execution (e.g., PR number, file path)" }),
      ),
      steps: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.Union([Type.Literal("claude-cli"), Type.Literal("codex")]),
            action: Type.String(),
            requiresConfirm: Type.Optional(Type.Boolean()),
          }),
          { description: "Custom workflow steps (only for action=define)" },
        ),
      ),
    }),

    async execute(
      _id: string,
      params: {
        action?: unknown;
        workflowName?: unknown;
        input?: unknown;
        steps?: unknown;
      },
    ) {
      const action = typeof params.action === "string" ? params.action : "list";
      const workflowName = typeof params.workflowName === "string" ? params.workflowName : undefined;
      const input = typeof params.input === "string" ? params.input : undefined;

      switch (action) {
        case "list": {
          const list = Object.values(BUILTIN_WORKFLOWS).map((w) => ({
            name: w.name,
            description: w.description,
            stepCount: w.steps.length,
            agents: [...new Set(w.steps.map((s) => s.agent))],
          }));
          return [{ type: "text" as const, text: JSON.stringify(list, null, 2) }];
        }

        case "run": {
          if (!workflowName) throw new Error("workflowName is required for action=run");
          const workflow = BUILTIN_WORKFLOWS[workflowName];
          if (!workflow) {
            throw new Error(
              `Unknown workflow: ${workflowName}. Available: ${Object.keys(BUILTIN_WORKFLOWS).join(", ")}`,
            );
          }

          const executionPlan = workflow.steps.map((step, i) => ({
            stepNumber: i + 1,
            id: step.id,
            agent: step.agent,
            action: step.action,
            requiresConfirm: step.requiresConfirm ?? false,
            prompt: buildStepPrompt(step, input, i, workflow.steps),
          }));

          return [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "execution_plan_ready",
                  workflow: workflowName,
                  description: workflow.description,
                  input,
                  totalSteps: executionPlan.length,
                  plan: executionPlan,
                  instruction:
                    "Execute each step sequentially. For steps with requiresConfirm=true, " +
                    "use automation_confirm_gate before proceeding. " +
                    "Use automation_codex_execute for codex steps. " +
                    "Report progress after each step.",
                },
                null,
                2,
              ),
            },
          ];
        }

        case "define": {
          const steps = Array.isArray(params.steps) ? params.steps : [];
          if (!workflowName || steps.length === 0) {
            throw new Error("workflowName and steps[] are required for action=define");
          }
          return [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "workflow_defined",
                name: workflowName,
                steps: steps.map((s: any, i: number) => ({
                  stepNumber: i + 1,
                  agent: s.agent ?? "claude-cli",
                  action: s.action ?? "execute",
                  requiresConfirm: s.requiresConfirm ?? false,
                })),
              }, null, 2),
            },
          ];
        }

        case "status": {
          return [
            {
              type: "text" as const,
              text: JSON.stringify({
                activeWorkflows: 0,
                completedToday: 0,
                note: "Workflow state tracking is session-scoped. Check agent session for active runs.",
              }, null, 2),
            },
          ];
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}

function buildStepPrompt(
  step: WorkflowStep,
  userInput: string | undefined,
  index: number,
  allSteps: WorkflowStep[],
): string {
  const context = userInput ? ` Context: ${userInput}` : "";
  const prevStep = index > 0 ? allSteps[index - 1] : undefined;
  const prevRef = prevStep ? ` (use output from previous step: ${prevStep.id})` : "";
  return `[Step ${index + 1}/${allSteps.length}] ${step.action}${context}${prevRef}`;
}
