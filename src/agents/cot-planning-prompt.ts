import type {
  SessionGoal,
  SessionGoalPlanSnapshot,
  SessionGoalPlanStep,
} from "../config/sessions/types.js";
/**
 * Chain-of-Thought pre-flight planning prompt for long-running goals.
 *
 * Provides system prompt sections that guide the agent through structured
 * decomposition, dependency analysis, and checkpoint planning before executing
 * a long-running goal. Plans are persisted as `planSnapshot` on SessionGoal and
 * survive compaction.
 */
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";

// ── Activation ──────────────────────────────────────────────────────────

const DEFAULT_MIN_BUDGET_TOKENS = 50_000;

type CotPlanningConfig = NonNullable<AgentDefaultsConfig["cotPlanning"]>;

/** Resolves the effective CoT planning mode from agent config. */
export function resolveCotPlanningMode(config?: CotPlanningConfig): "auto" | "always" | "off" {
  const mode = config?.mode;
  if (mode === "always" || mode === "off") {
    return mode;
  }
  return "auto";
}

/** Determines whether CoT planning should activate for the given goal. */
export function shouldActivateCotPlanning(params: {
  goal?: SessionGoal | null;
  config?: CotPlanningConfig;
}): boolean {
  const { goal, config } = params;
  if (!goal || goal.status !== "active") {
    return false;
  }
  const mode = resolveCotPlanningMode(config);
  if (mode === "off") {
    return false;
  }
  // Already has a plan — show progress, not planning prompt.
  if (goal.planSnapshot) {
    return false;
  }
  if (mode === "always") {
    return true;
  }
  // Auto mode: activate when budget is large enough or explicitly requested.
  const minBudget = config?.minBudgetTokens ?? DEFAULT_MIN_BUDGET_TOKENS;
  return goal.tokenBudget !== undefined && goal.tokenBudget >= minBudget;
}

/** Returns true when the goal has an existing plan that should render progress. */
export function shouldRenderCotProgress(params: {
  goal?: SessionGoal | null;
  config?: CotPlanningConfig;
}): boolean {
  const { goal, config } = params;
  if (!goal || !goal.planSnapshot) {
    return false;
  }
  const mode = resolveCotPlanningMode(config);
  return mode !== "off";
}

// ── Prompt generation ───────────────────────────────────────────────────

/**
 * Builds the CoT planning instruction block injected when a goal is active
 * and planning has not yet occurred.
 */
export function buildCotPlanningSystemPromptSection(params: { goal: SessionGoal }): string[] {
  const { goal } = params;
  const budgetLine =
    goal.tokenBudget !== undefined
      ? `Token budget: ${goal.tokenBudget.toLocaleString()} tokens.`
      : "No explicit token budget set.";

  return [
    "## CoT Pre-Flight Planning",
    "",
    "A goal is active and requires a structured execution plan before work begins.",
    `Objective: ${goal.objective}`,
    budgetLine,
    "",
    "Before taking action, produce a structured Chain-of-Thought plan inside `<cot_plan>` tags.",
    "The plan must include:",
    "",
    "1. **Approach** — A 1-2 sentence summary of the overall strategy.",
    "2. **Steps** — An ordered list of discrete, actionable steps. Each step must have:",
    "   - A short `id` (e.g. `s1`, `s2`, …)",
    "   - A clear `description` of what to do",
    "   - Optional `depends_on` listing step ids that must complete first",
    "   - Optional `checkpoint: true` if progress should be verified before continuing",
    "   - Optional `estimated_tokens` rough cost estimate",
    "3. **Risks** — Known risks or failure modes (optional).",
    "4. **Checkpoints** — Key verification points where partial results should be validated.",
    "4. **Checkpoints** — Key verification points where partial results should be validated.",
    "",
    "Format:",
    "```",
    "<cot_plan>",
    "approach: [strategy summary]",
    "steps:",
    "  - id: s1",
    "    description: [what to do]",
    "    dependsOn: []",
    "    checkpoint: false",
    "    estimatedTokens: 5000",
    "  - id: s2",
    "    description: [next step]",
    "    dependsOn: [s1]",
    "    checkpoint: true",
    "    estimatedTokens: 8000",
    "risks:",
    "  - [risk description]",
    "checkpoints:",
    "  - [checkpoint description]",
    "</cot_plan>",
    "```",
    "",
    "After producing the plan, call `update_goal_plan` with the structured plan,",
    "then begin executing step s1.",
    "",
  ];
}

/**
 * Builds a progress-tracking prompt section when an existing plan is being executed.
 */
export function buildCotPlanProgressSection(params: { goal: SessionGoal }): string[] {
  const { goal } = params;
  const plan = goal.planSnapshot;
  if (!plan) {
    return [];
  }

  const lines: string[] = [
    "## Goal Plan Progress",
    "",
    `Objective: ${goal.objective}`,
    `Approach: ${plan.approach}`,
    "",
    "### Steps",
  ];

  for (const step of plan.steps) {
    const status = step.status ?? "pending";
    const icon = STATUS_ICONS[status] ?? "⬜";
    const deps =
      step.dependsOn && step.dependsOn.length > 0 ? ` (depends: ${step.dependsOn.join(", ")})` : "";
    const checkpoint = step.checkpoint ? " 🔍" : "";
    const note = step.note ? ` — ${step.note}` : "";
    lines.push(`${icon} **${step.id}**: ${step.description}${deps}${checkpoint}${note}`);
  }

  const completed = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  lines.push("", `Progress: ${completed}/${total} steps complete.`);

  // Identify the next actionable step.
  const nextStep = resolveNextActionableStep(plan);
  if (nextStep) {
    lines.push(`Next: **${nextStep.id}** — ${nextStep.description}`);
  }

  if (plan.risks && plan.risks.length > 0) {
    lines.push("", "### Risks");
    for (const risk of plan.risks) {
      lines.push(`- ${risk}`);
    }
  }

  lines.push("");
  return lines;
}

const STATUS_ICONS: Record<string, string> = {
  pending: "⬜",
  active: "🔵",
  done: "✅",
  blocked: "🟥",
  skipped: "⏭️",
};

// ── Plan parsing ────────────────────────────────────────────────────────

/**
 * Extracts a structured plan from model output containing `<cot_plan>` tags.
 * Returns undefined if no valid plan is found.
 */
export function parseCotPlanResponse(text: string): SessionGoalPlanSnapshot | undefined {
  const match = /<cot_plan>([\s\S]*?)<\/cot_plan>/i.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  const content = match[1].trim();

  try {
    const approach = extractField(content, "approach");
    if (!approach) {
      return undefined;
    }

    const steps = extractSteps(content);
    if (steps.length === 0) {
      return undefined;
    }

    const risks = extractListField(content, "risks");
    const checkpoints = extractListField(content, "checkpoints");

    return {
      schemaVersion: 1,
      createdAt: Date.now(),
      approach,
      steps,
      ...(risks.length > 0 ? { risks } : {}),
      ...(checkpoints.length > 0 ? { checkpoints } : {}),
    };
  } catch {
    return undefined;
  }
}

function extractField(content: string, name: string): string | undefined {
  const regex = new RegExp(`^${name}:\\s*(.+)$`, "mi");
  const match = regex.exec(content);
  return match?.[1]?.trim() || undefined;
}

function extractListField(content: string, name: string): string[] {
  const sectionRegex = new RegExp(`^${name}:\\s*$`, "mi");
  const sectionMatch = sectionRegex.exec(content);
  if (!sectionMatch) {
    return [];
  }
  const afterSection = content.slice(sectionMatch.index + sectionMatch[0].length);
  const items: string[] = [];
  for (const line of afterSection.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(trimmed.slice(2).trim());
    } else if (trimmed.length > 0 && !trimmed.startsWith("-")) {
      break;
    }
  }
  return items;
}

function extractSteps(content: string): SessionGoalPlanStep[] {
  const stepsRegex = /^steps:\s*$/im;
  const stepsMatch = stepsRegex.exec(content);
  if (!stepsMatch) {
    return [];
  }
  const afterSteps = content.slice(stepsMatch.index + stepsMatch[0].length);
  const steps: SessionGoalPlanStep[] = [];
  let currentStep: Partial<SessionGoalPlanStep> | null = null;

  for (const line of afterSteps.split("\n")) {
    const trimmed = line.trim();

    // New step starts with "- id:"
    if (trimmed.startsWith("- id:")) {
      if (currentStep?.id && currentStep?.description) {
        steps.push(finalizeStep(currentStep));
      }
      currentStep = { id: trimmed.slice(5).trim() };
      continue;
    }

    // Step properties
    if (currentStep && trimmed.startsWith("description:")) {
      currentStep.description = trimmed.slice(12).trim();
    } else if (currentStep && trimmed.startsWith("dependsOn:")) {
      currentStep.dependsOn = parseInlineList(trimmed.slice(10).trim());
    } else if (currentStep && trimmed.startsWith("checkpoint:")) {
      currentStep.checkpoint = trimmed.slice(11).trim().toLowerCase() === "true";
    } else if (currentStep && trimmed.startsWith("estimatedTokens:")) {
      const parsed = parseInt(trimmed.slice(16).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        currentStep.estimatedTokens = parsed;
      }
    } else if (
      trimmed.length > 0 &&
      !trimmed.startsWith("-") &&
      !trimmed.startsWith("description:") &&
      !trimmed.startsWith("dependsOn:") &&
      !trimmed.startsWith("checkpoint:") &&
      !trimmed.startsWith("estimatedTokens:") &&
      currentStep?.id
    ) {
      // End of steps section — hit a new top-level field.
      if (!trimmed.startsWith("- id:")) {
        if (currentStep.description) {
          steps.push(finalizeStep(currentStep));
        }
        currentStep = null;
        break;
      }
    }
  }

  if (currentStep?.id && currentStep?.description) {
    steps.push(finalizeStep(currentStep));
  }

  return steps;
}

function parseInlineList(value: string): string[] {
  // Handles [s1, s2] or s1, s2
  const cleaned = value.replace(/[\[\]]/g, "").trim();
  if (!cleaned) {
    return [];
  }
  return cleaned
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function finalizeStep(partial: Partial<SessionGoalPlanStep>): SessionGoalPlanStep {
  return {
    id: partial.id!,
    description: partial.description!,
    status: "pending",
    ...(partial.dependsOn && partial.dependsOn.length > 0 ? { dependsOn: partial.dependsOn } : {}),
    ...(partial.checkpoint ? { checkpoint: true } : {}),
    ...(partial.estimatedTokens ? { estimatedTokens: partial.estimatedTokens } : {}),
  };
}

// ── Plan helpers ────────────────────────────────────────────────────────

/** Returns the next step that is pending and has all dependencies satisfied. */
export function resolveNextActionableStep(
  plan: SessionGoalPlanSnapshot,
): SessionGoalPlanStep | undefined {
  const doneIds = new Set(
    plan.steps.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id),
  );
  return plan.steps.find((step) => {
    if (step.status !== "pending" && step.status !== undefined) {
      return false;
    }
    const deps = step.dependsOn ?? [];
    return deps.every((depId) => doneIds.has(depId));
  });
}

/** Returns a compact status summary of the plan for compaction/handoff. */
export function buildPlanCompactionSummary(plan: SessionGoalPlanSnapshot): string {
  const completed = plan.steps.filter((s) => s.status === "done").length;
  const blocked = plan.steps.filter((s) => s.status === "blocked").length;
  const total = plan.steps.length;
  const next = resolveNextActionableStep(plan);

  const lines = [
    `Plan: ${plan.approach}`,
    `Progress: ${completed}/${total} steps done${blocked > 0 ? `, ${blocked} blocked` : ""}.`,
  ];

  for (const step of plan.steps) {
    const status = step.status ?? "pending";
    const icon = STATUS_ICONS[status] ?? "⬜";
    const note = step.note ? ` (${step.note})` : "";
    lines.push(`  ${icon} ${step.id}: ${step.description}${note}`);
  }

  if (next) {
    lines.push(`Next actionable: ${next.id} — ${next.description}`);
  }

  if (plan.risks && plan.risks.length > 0) {
    lines.push(`Risks: ${plan.risks.join("; ")}`);
  }

  return lines.join("\n");
}

// ── Testing surface ─────────────────────────────────────────────────────

export const cotPlanningTesting = {
  extractField,
  extractListField,
  extractSteps,
  parseInlineList,
  finalizeStep,
  DEFAULT_MIN_BUDGET_TOKENS,
};
