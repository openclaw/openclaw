import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function buildWorkflowError(params: {
  errorCode:
    | "WORKFLOW_INPUT_INVALID"
    | "WORKFLOW_NOT_FOUND"
    | "WORKFLOW_DEFINE_INVALID"
    | "WORKFLOW_ACTION_UNKNOWN";
  nextAction: string;
  detail: string;
}): string {
  return (
    `回覆狀態：FAILED\n` +
    `error_code=${params.errorCode}\n` +
    `next_action=${params.nextAction}\n` +
    `detail=${params.detail}`
  );
}

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
  refactor: {
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

export function createWorkflowTool(_api: OpenClawPluginApi) {
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
        {
          description:
            "Action: list available workflows, run one, define a new one, or check status",
        },
      ),
      workflowName: Type.Optional(
        Type.String({ description: "Name of the workflow to run or define" }),
      ),
      input: Type.Optional(
        Type.String({
          description: "Input/context for the workflow execution (e.g., PR number, file path)",
        }),
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
      const workflowName =
        typeof params.workflowName === "string" ? params.workflowName : undefined;
      const input = typeof params.input === "string" ? params.input : undefined;

      switch (action) {
        case "list": {
          const list = Object.values(BUILTIN_WORKFLOWS).map((w) => ({
            name: w.name,
            description: w.description,
            stepCount: w.steps.length,
            agents: [...new Set(w.steps.map((s) => s.agent))],
          }));
          return jsonResult(list);
        }

        case "run": {
          if (!workflowName) {
            throw new Error(
              buildWorkflowError({
                errorCode: "WORKFLOW_INPUT_INVALID",
                nextAction: "PROVIDE_WORKFLOW_NAME",
                detail: "缺少 workflowName（action=run）。",
              }),
            );
          }
          const workflow = BUILTIN_WORKFLOWS[workflowName];
          if (!workflow) {
            throw new Error(
              buildWorkflowError({
                errorCode: "WORKFLOW_NOT_FOUND",
                nextAction: "USE_ACTION_LIST",
                detail: `找不到 workflow=${workflowName}。可用：${Object.keys(BUILTIN_WORKFLOWS).join(", ")}`,
              }),
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

          return jsonResult({
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
          });
        }

        case "define": {
          const steps = Array.isArray(params.steps) ? params.steps : [];
          if (!workflowName || steps.length === 0) {
            throw new Error(
              buildWorkflowError({
                errorCode: "WORKFLOW_DEFINE_INVALID",
                nextAction: "PROVIDE_WORKFLOW_NAME_AND_STEPS",
                detail: "action=define 需要 workflowName 與 steps[]。",
              }),
            );
          }
          return jsonResult({
            status: "workflow_defined",
            name: workflowName,
            steps: steps.map((step, i) => {
              const item = isRecord(step) ? step : {};
              return {
                stepNumber: i + 1,
                agent: item.agent === "codex" ? "codex" : "claude-cli",
                action: typeof item.action === "string" ? item.action : "execute",
                requiresConfirm:
                  typeof item.requiresConfirm === "boolean" ? item.requiresConfirm : false,
              };
            }),
          });
        }

        case "status": {
          return jsonResult({
            activeWorkflows: 0,
            completedToday: 0,
            note: "Workflow state tracking is session-scoped. Check agent session for active runs.",
          });
        }

        default:
          throw new Error(
            buildWorkflowError({
              errorCode: "WORKFLOW_ACTION_UNKNOWN",
              nextAction: "USE_ACTION_LIST_OR_RUN_OR_DEFINE_OR_STATUS",
              detail: `未知 action=${action}`,
            }),
          );
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
