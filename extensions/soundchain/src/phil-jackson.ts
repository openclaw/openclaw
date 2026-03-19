/**
 * Phil Jackson Triangle Pipeline — 7 Ollama Models, Zero Tokens
 *
 * The legendary triangle offense, adapted for code diagnostics.
 * Each model has a role. Each role has a trigger. The pipeline
 * chains them in sequence — syntax → deep analysis → fast fix →
 * deps → architect → captain → backup — until the problem is solved.
 *
 * "The strength of the team is each individual member.
 *  The strength of each member is the team." — Phil Jackson
 *
 * Team Chemistry (from agentide_optimizer.py):
 *   falcon:7b       — Syntax Specialist (Steph Curry's shooting)
 *   jmorgan/grok    — Deep Analyst (LeBron: sees the whole court)
 *   mistral:latest  — First Responder (Curry: fast handles, instant patch)
 *   gemma:7b        — Dependency Coordinator (Draymond: organizes the team)
 *   mixtral:8x22b   — Architect (Durant: builds with long-range vision)
 *   llama3.1        — Team Captain (Jordan: closes with dominance)
 *   qwen:7b         — Backup (Iguodala: steps up when needed)
 */

import type { WarRoomClient } from "./warroom.js";

// ---------------------------------------------------------------------------
// Pipeline stage definitions (mirrors ORCHESTRATION_CONFIG from Python)
// ---------------------------------------------------------------------------

export interface PipelineStage {
  name: string;
  model: string;
  role: string;
  trigger: string;
  tasks: string[];
  output: string;
  /** NBA analogy from team_chemistry */
  chemistry: string;
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    name: "syntax_correction",
    model: "falcon:7b",
    role: "Syntax Specialist",
    trigger: "any_syntax_error",
    tasks: [
      "Detect and fix syntax errors (missing >, ;, unterminated regex)",
      "Ensure JSX/TSX validity",
    ],
    output: "syntax_patch",
    chemistry: "Steph Curry's shooting — precision from deep",
  },
  {
    name: "logic_validation",
    model: "jmorgan/grok:latest",
    role: "Deep Analyst",
    trigger: "any_type_error",
    tasks: [
      "Detect logic conflicts across tsconfig, next.config.js, dockerfiles",
      "Explain error causes in human-friendly terms",
      "Validate and update type definitions",
    ],
    output: "validated_fix",
    chemistry: "LeBron — sees the whole court, validates plays",
  },
  {
    name: "fast_reaction",
    model: "mistral:latest",
    role: "First Responder",
    trigger: "any_build_error",
    tasks: [
      "Scan logs instantly",
      "Apply quick fixes like missing imports and typos",
      "Suggest yarn install if lockfile integrity fails",
    ],
    output: "quick_fix_patch",
    chemistry: "Curry — fast handles, instant patch",
  },
  {
    name: "dependency_management",
    model: "gemma:7b",
    role: "Dependency Coordinator",
    trigger: "after_quick_fix_patch",
    tasks: [
      "Validate dependency versions in package.json and lock files",
      "Suggest yarn/pnpm add/remove for missing or conflicting deps",
    ],
    output: "dependency_patch",
    chemistry: "Draymond — organizes the team, sets the screen",
  },
  {
    name: "strategic_reasoning",
    model: "mixtral:8x22b",
    role: "Architect",
    trigger: "after_validated_fix",
    tasks: [
      "Analyze project-wide implications of fixes",
      "Suggest architectural or config-level improvements",
      "Future-proof corrections for CI/CD and workspace",
    ],
    output: "strategic_fix_plan",
    chemistry: "Durant — builds with long-range vision",
  },
  {
    name: "final_review",
    model: "llama3.1:latest",
    role: "Team Captain",
    trigger: "after_strategic_fix_plan",
    tasks: ["Review all fixes for consistency", "Ensure build success", "Make the final call"],
    output: "final_patch",
    chemistry: "Jordan — closes with dominance",
  },
  {
    name: "fallback",
    model: "qwen:7b",
    role: "Backup",
    trigger: "after_final_review_fail",
    tasks: [
      "Provide alternative fixes if primary pipeline fails",
      "Fresh perspective on the problem",
    ],
    output: "fallback_fix",
    chemistry: "Iguodala — steps up when it matters most",
  },
];

// ---------------------------------------------------------------------------
// Decision flow — routes errors to the right starting stage
// ---------------------------------------------------------------------------

export type ErrorCategory = "syntax" | "type" | "build" | "dependency" | "complex" | "unknown";

export function classifyError(error: string): ErrorCategory {
  const lower = error.toLowerCase();
  if (
    lower.includes("unexpected token") ||
    lower.includes("unterminated") ||
    lower.includes("missing >") ||
    lower.includes("jsx") ||
    lower.includes("parsing error")
  ) {
    return "syntax";
  }
  if (
    lower.includes("type error") ||
    lower.includes("does not exist on type") ||
    lower.includes("is not assignable") ||
    lower.includes("ts(") ||
    lower.includes("cannot find name")
  ) {
    return "type";
  }
  if (
    lower.includes("module not found") ||
    lower.includes("cannot find module") ||
    lower.includes("yarn add") ||
    lower.includes("pnpm add") ||
    lower.includes("peer dep") ||
    lower.includes("version mismatch")
  ) {
    return "dependency";
  }
  if (
    lower.includes("build") ||
    lower.includes("compile") ||
    lower.includes("webpack") ||
    lower.includes("next build") ||
    lower.includes("tsc")
  ) {
    return "build";
  }
  if (
    lower.includes("architecture") ||
    lower.includes("refactor") ||
    lower.includes("circular") ||
    lower.includes("design")
  ) {
    return "complex";
  }
  return "unknown";
}

/** Get the starting stage index for an error category */
function getStartStage(category: ErrorCategory): number {
  switch (category) {
    case "syntax":
      return 0; // Start with falcon (syntax specialist)
    case "type":
      return 1; // Start with grok (deep analyst)
    case "build":
      return 2; // Start with mistral (fast reaction)
    case "dependency":
      return 3; // Start with gemma (dep coordinator)
    case "complex":
      return 4; // Start with mixtral (architect)
    case "unknown":
      return 2; // Default to mistral (first responder)
  }
}

// ---------------------------------------------------------------------------
// Pipeline execution
// ---------------------------------------------------------------------------

export interface StageResult {
  stage: string;
  model: string;
  role: string;
  chemistry: string;
  response: unknown;
  durationMs: number;
}

export interface DiagnoseResult {
  problem: string;
  category: ErrorCategory;
  stagesRun: StageResult[];
  totalDurationMs: number;
}

/**
 * Run the Phil Jackson Triangle Pipeline.
 *
 * Routes the problem through models in sequence based on error category.
 * Each stage builds on the previous — like passing the ball around the
 * triangle until someone has the open shot.
 *
 * @param maxStages - Max models to consult (default: all 7). Use fewer for speed.
 */
export async function runPipeline(
  client: WarRoomClient,
  problem: string,
  maxStages = 7,
): Promise<DiagnoseResult> {
  const category = classifyError(problem);
  const startIdx = getStartStage(category);
  const totalStart = Date.now();

  const stagesRun: StageResult[] = [];

  // Build context that accumulates across stages
  let context = problem;

  for (let i = 0; i < maxStages && i < PIPELINE_STAGES.length; i++) {
    const stageIdx = (startIdx + i) % PIPELINE_STAGES.length;
    const stage = PIPELINE_STAGES[stageIdx];

    const prompt = buildStagePrompt(stage, context, stagesRun);

    const stageStart = Date.now();
    let response: unknown;
    try {
      response = await client.ollamaGenerate(stage.model, prompt);
    } catch (err) {
      response = { error: `Model ${stage.model} unavailable: ${err}` };
    }
    const durationMs = Date.now() - stageStart;

    const result: StageResult = {
      stage: stage.name,
      model: stage.model,
      role: stage.role,
      chemistry: stage.chemistry,
      response,
      durationMs,
    };
    stagesRun.push(result);

    // Add this stage's output to the rolling context
    const responseText =
      typeof response === "object" && response !== null && "response" in response
        ? String((response as Record<string, unknown>).response)
        : JSON.stringify(response);
    context += `\n\n--- ${stage.role} (${stage.model}) ---\n${responseText}`;
  }

  return {
    problem,
    category,
    stagesRun,
    totalDurationMs: Date.now() - totalStart,
  };
}

/**
 * Quick diagnose — only runs the most relevant model for the error type.
 * Fast. One model. One answer. Like a fast break.
 */
export async function quickDiagnose(
  client: WarRoomClient,
  problem: string,
): Promise<DiagnoseResult> {
  return runPipeline(client, problem, 1);
}

/**
 * Deep diagnose — runs all 7 models. Full triangle rotation.
 * Takes longer but gives a 360-degree view of the problem.
 */
export async function deepDiagnose(
  client: WarRoomClient,
  problem: string,
): Promise<DiagnoseResult> {
  return runPipeline(client, problem, 7);
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildStagePrompt(
  stage: PipelineStage,
  context: string,
  previousResults: StageResult[],
): string {
  const taskList = stage.tasks.map((t, i) => `  ${i + 1}. ${t}`).join("\n");

  let prompt = `You are the ${stage.role} in the Phil Jackson Triangle Pipeline.
Your job: ${stage.tasks[0]}

PROBLEM:
${context}

YOUR TASKS:
${taskList}

`;

  if (previousResults.length > 0) {
    prompt += `PREVIOUS ANALYSIS FROM THE TEAM:\n`;
    for (const prev of previousResults) {
      const text =
        typeof prev.response === "object" && prev.response !== null && "response" in prev.response
          ? String((prev.response as Record<string, unknown>).response)
          : JSON.stringify(prev.response);
      prompt += `- ${prev.role} (${prev.model}): ${text.slice(0, 500)}\n`;
    }
    prompt += `\nBuild on their analysis. Don't repeat what they already found.\n`;
  }

  prompt += `\nBe concise and actionable. Give specific file paths, line numbers, and code fixes where possible. No fluff.`;

  return prompt;
}
