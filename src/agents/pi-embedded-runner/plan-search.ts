import type { OpenClawConfig } from "../../config/config.js";
import { estimateUsageCost } from "../../utils/usage-format.js";
import type { EmbeddedPiPlanSearchMeta } from "./types.js";

const DEFAULT_PLAN_CANDIDATE_COUNT = 4;
const MIN_PLAN_CANDIDATE_COUNT = 2;
const MAX_PLAN_CANDIDATE_COUNT = 8;
const MAX_KEYWORDS = 6;
const DEFAULT_PLAN_TOKEN_BUDGET = 4_000;
const DEFAULT_PLAN_RUNTIME_BUDGET_MS = 90_000;
const DEFAULT_PLAN_COST_BUDGET_USD = 0.05;
const MIN_ESTIMATED_PROMPT_TOKENS = 64;
const ESTIMATED_OUTPUT_TOKEN_SHARE = 0.35;
const MIN_COST_BUDGET_USD = 0.000_001;

const PLAN_STOP_WORDS = new Set([
  "about",
  "after",
  "agent",
  "before",
  "build",
  "change",
  "changes",
  "feature",
  "first",
  "from",
  "have",
  "into",
  "just",
  "make",
  "need",
  "only",
  "plan",
  "runtime",
  "should",
  "task",
  "that",
  "then",
  "this",
  "with",
  "without",
]);

type BudgetViolation = "tokens" | "runtime_ms" | "cost_usd";

export type PlanSearchBudgetConfig = {
  maxTokens?: number;
  maxRuntimeMs?: number;
  maxCostUsd?: number;
};

export type PlanSearchRuntimeConfig = {
  enabled: boolean;
  candidateCount: number;
  scoringMode: "heuristic" | "llm";
  includeSelectedPlanInPrompt: boolean;
  budget: PlanSearchBudgetConfig;
};

type PlanCandidate = {
  id: string;
  title: string;
  strategy: string;
  steps: string[];
};

export type ScoredPlanCandidate = PlanCandidate & {
  score: number;
  performanceGain: number;
  computeCost: number;
  estimatedTokens: number;
  estimatedRuntimeMs: number;
  estimatedCostUsd: number;
  withinBudget: boolean;
  budgetViolations: BudgetViolation[];
  rationale: string[];
};

export type PlanScoreResult = {
  performanceGain: number;
  rationale: string[];
};

export type PlanCandidateScorer = (candidate: PlanCandidate) => PlanScoreResult;

export type PlanCandidateComputeEstimate = {
  estimatedTokens: number;
  estimatedRuntimeMs: number;
  estimatedCostUsd: number;
};

export type PlanCandidateComputeEstimator = (
  candidate: PlanCandidate,
) => PlanCandidateComputeEstimate;

export type PlanSearchResult = {
  prompt: string;
  selected: ScoredPlanCandidate;
  considered: ScoredPlanCandidate[];
  meta: EmbeddedPiPlanSearchMeta;
};

type ModelCostProfile = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function clampCandidateCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_PLAN_CANDIDATE_COUNT;
  }
  const normalized = Math.trunc(value);
  return Math.min(MAX_PLAN_CANDIDATE_COUNT, Math.max(MIN_PLAN_CANDIDATE_COUNT, normalized));
}

function normalizePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function extractPromptKeywords(prompt: string): string[] {
  const tokens = prompt
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !PLAN_STOP_WORDS.has(token));

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    unique.push(token);
    if (unique.length >= MAX_KEYWORDS) {
      break;
    }
  }
  return unique;
}

function buildFocusPhrase(keywords: string[]): string {
  if (keywords.length === 0) {
    return "the user request";
  }
  if (keywords.length === 1) {
    return keywords[0];
  }
  return `${keywords[0]} + ${keywords[1]}`;
}

function baseCandidates(prompt: string): Array<Omit<PlanCandidate, "id">> {
  const keywords = extractPromptKeywords(prompt);
  const focus = buildFocusPhrase(keywords);
  return [
    {
      title: "Trace-first implementation",
      strategy: "trace-first",
      steps: [
        `Trace the planner/runtime path touching ${focus} and confirm current behavior.`,
        "Identify the smallest insertion point for candidate-plan search before execution.",
        "Implement an opt-in plan-search pass that keeps default runtime behavior unchanged.",
        "Run focused tests around selection logic and the fallback path.",
        "Persist selected/considered plan metadata in run meta and planner events.",
      ],
    },
    {
      title: "Safety-first rollout",
      strategy: "safety-first",
      steps: [
        "Document compatibility constraints and define an explicit feature flag boundary.",
        "Generate K candidate plans with bounded templates to keep overhead predictable.",
        "Score candidates cheaply, select the best, and keep deterministic tie-breaking.",
        "Wire selected plan into execution context only when the flag is enabled.",
        "Verify fallback behavior when scoring fails to avoid blocking execution.",
      ],
    },
    {
      title: "Vertical slice MVP",
      strategy: "vertical-slice",
      steps: [
        "Implement a minimal candidate generation pipeline for the current runtime prompt.",
        "Add heuristic scoring that rewards verification, compatibility, and concise plans.",
        "Choose one best plan and prepend it as execution guidance.",
        "Emit planner events and include considered plans in run artifacts metadata.",
        "Add TODO markers only where deeper LLM-based scoring would be added later.",
      ],
    },
    {
      title: "Verification-heavy implementation",
      strategy: "verification-heavy",
      steps: [
        "Map expected behavior for both feature-enabled and legacy runtime paths.",
        "Generate multiple candidate plans emphasizing test/lint and rollback safety.",
        "Run scoring and select the strongest candidate for full execution.",
        "Persist selected/considered metadata for diagnostics and observability.",
        "Run targeted runtime tests plus impacted lint/tests before shipping.",
      ],
    },
    {
      title: "Failure-aware implementation",
      strategy: "failure-aware",
      steps: [
        "Define failure modes for scoring, prompt shaping, and metadata persistence.",
        "Generate K candidates with explicit fallback and backward-compatibility steps.",
        "Use cheap scoring and enforce first-candidate fallback on scorer failure.",
        "Carry plan metadata to run results/events for post-run debugging.",
        "Validate selection behavior and scorer-failure fallback with focused tests.",
      ],
    },
  ];
}

function buildCandidatePlans(prompt: string, count: number): PlanCandidate[] {
  const base = baseCandidates(prompt);
  return Array.from({ length: count }, (_, index) => {
    const template = base[index % base.length];
    const variant = Math.floor(index / base.length);
    const variantLabel = variant > 0 ? ` (variant ${variant + 1})` : "";
    return {
      id: `plan-${index + 1}`,
      title: `${template.title}${variantLabel}`,
      strategy: `${template.strategy}${variantLabel}`,
      steps: template.steps,
    };
  });
}

function scoreCandidateHeuristically(prompt: string, candidate: PlanCandidate): PlanScoreResult {
  const promptKeywords = extractPromptKeywords(prompt);
  const fullText = `${candidate.title} ${candidate.steps.join(" ")}`.toLowerCase();
  const rationale: string[] = [];
  let performanceGain = 1;

  const keywordHits = promptKeywords.filter((keyword) => fullText.includes(keyword)).length;
  if (keywordHits > 0) {
    performanceGain += Math.min(4, keywordHits) * 1.2;
    rationale.push(`keyword_hits:${keywordHits}`);
  }

  const checks: Array<{ pattern: RegExp; points: number; reason: string }> = [
    { pattern: /\b(test|verify|validate|lint|smoke)\b/, points: 2, reason: "has-validation" },
    {
      pattern: /\b(feature flag|opt-in|toggle)\b/,
      points: 1.5,
      reason: "mentions-feature-flag",
    },
    {
      pattern: /\b(backward compat|backward-compatible|fallback)\b/,
      points: 1.25,
      reason: "mentions-compat-or-fallback",
    },
    {
      pattern: /\b(artifact|event|metadata|persist)\b/,
      points: 1,
      reason: "mentions-artifacts",
    },
    {
      pattern: /\b(minimal|mvp|vertical slice)\b/,
      points: 0.75,
      reason: "mentions-mvp",
    },
  ];

  for (const check of checks) {
    if (check.pattern.test(fullText)) {
      performanceGain += check.points;
      rationale.push(check.reason);
    }
  }

  if (candidate.steps.length >= 4 && candidate.steps.length <= 6) {
    performanceGain += 1;
    rationale.push("balanced-step-count");
  }

  const avgStepLength =
    candidate.steps.reduce((acc, step) => acc + step.length, 0) /
    Math.max(1, candidate.steps.length);
  if (avgStepLength > 180) {
    performanceGain -= 0.5;
    rationale.push("long-step-penalty");
  }

  return {
    performanceGain: Number(Math.max(0.25, performanceGain).toFixed(3)),
    rationale,
  };
}

function resolveScorer(
  prompt: string,
  mode: PlanSearchRuntimeConfig["scoringMode"],
): {
  scorer: PlanCandidateScorer;
  appliedScoringMode: EmbeddedPiPlanSearchMeta["appliedScoringMode"];
} {
  if (mode === "llm") {
    // TODO(wave-2): wire an actual lightweight LLM ranker; fallback stays heuristic for MVP.
    return {
      appliedScoringMode: "heuristic",
      scorer: (candidate) => {
        const base = scoreCandidateHeuristically(prompt, candidate);
        return {
          performanceGain: base.performanceGain,
          rationale: [...base.rationale, "llm_mode_fell_back_to_heuristic"],
        };
      },
    };
  }
  return {
    appliedScoringMode: "heuristic",
    scorer: (candidate) => scoreCandidateHeuristically(prompt, candidate),
  };
}

function countStepMatches(steps: string[], pattern: RegExp): number {
  return steps.reduce((count, step) => count + (pattern.test(step.toLowerCase()) ? 1 : 0), 0);
}

function estimatePromptTokens(prompt: string): number {
  return Math.max(MIN_ESTIMATED_PROMPT_TOKENS, Math.ceil(prompt.length / 4));
}

function estimateCandidateCompute(params: {
  prompt: string;
  candidate: PlanCandidate;
  modelCost?: ModelCostProfile;
}): PlanCandidateComputeEstimate {
  const serializedCandidate = [
    params.candidate.title,
    params.candidate.strategy,
    ...params.candidate.steps,
  ].join(" ");
  const promptTokens = estimatePromptTokens(params.prompt);
  const candidateTokens = Math.max(48, Math.ceil(serializedCandidate.length / 4));
  const stepCount = params.candidate.steps.length;
  const validationSteps = countStepMatches(
    params.candidate.steps,
    /\b(test|lint|verify|validate|smoke)\b/,
  );
  const implementationSteps = countStepMatches(
    params.candidate.steps,
    /\b(implement|wire|persist|execute|run|build|generate|emit)\b/,
  );
  const analysisSteps = countStepMatches(
    params.candidate.steps,
    /\b(trace|identify|map|document|define)\b/,
  );
  const fallbackSteps = countStepMatches(
    params.candidate.steps,
    /\b(fallback|rollback|backward compat|backward-compatible)\b/,
  );

  const estimatedTokens =
    promptTokens +
    candidateTokens +
    stepCount * 140 +
    validationSteps * 100 +
    implementationSteps * 80 +
    analysisSteps * 30;
  const estimatedRuntimeMs =
    12_000 +
    stepCount * 7_000 +
    validationSteps * 18_000 +
    implementationSteps * 12_000 +
    analysisSteps * 4_000 +
    fallbackSteps * 3_000;
  const estimatedOutputTokens = Math.max(
    48,
    Math.ceil(estimatedTokens * ESTIMATED_OUTPUT_TOKEN_SHARE),
  );
  const estimatedCostUsd =
    estimateUsageCost({
      usage: {
        input: estimatedTokens,
        output: estimatedOutputTokens,
      },
      cost: params.modelCost,
    }) ?? 0;

  return {
    estimatedTokens,
    estimatedRuntimeMs,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
  };
}

function assessBudget(params: {
  estimate: PlanCandidateComputeEstimate;
  budget: PlanSearchBudgetConfig;
}): {
  computeCost: number;
  withinBudget: boolean;
  budgetViolations: BudgetViolation[];
} {
  const { estimate, budget } = params;
  const budgetViolations: BudgetViolation[] = [];

  if (budget.maxTokens !== undefined && estimate.estimatedTokens > budget.maxTokens) {
    budgetViolations.push("tokens");
  }
  if (budget.maxRuntimeMs !== undefined && estimate.estimatedRuntimeMs > budget.maxRuntimeMs) {
    budgetViolations.push("runtime_ms");
  }
  if (budget.maxCostUsd !== undefined && estimate.estimatedCostUsd > budget.maxCostUsd) {
    budgetViolations.push("cost_usd");
  }

  const normalizedTokenCost =
    estimate.estimatedTokens / (budget.maxTokens ?? DEFAULT_PLAN_TOKEN_BUDGET);
  const normalizedRuntimeCost =
    estimate.estimatedRuntimeMs / (budget.maxRuntimeMs ?? DEFAULT_PLAN_RUNTIME_BUDGET_MS);
  const normalizedUsdCost =
    estimate.estimatedCostUsd /
    Math.max(MIN_COST_BUDGET_USD, budget.maxCostUsd ?? DEFAULT_PLAN_COST_BUDGET_USD);
  const computeCost = Number(
    (1 + normalizedTokenCost + normalizedRuntimeCost + normalizedUsdCost).toFixed(6),
  );

  return {
    computeCost,
    withinBudget: budgetViolations.length === 0,
    budgetViolations,
  };
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (typeof error === "number" || typeof error === "boolean") {
    return `${error}`;
  }
  if (error && typeof error === "object") {
    const record = error as { message?: unknown };
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message.trim();
    }
  }
  return "scoring failed";
}

function buildPromptWithSelectedPlan(prompt: string, selected: ScoredPlanCandidate): string {
  const numberedSteps = selected.steps.map((step, idx) => `${idx + 1}. ${step}`).join("\n");
  return [
    "Selected execution plan (auto-selected before run):",
    `Plan: ${selected.id} — ${selected.title}`,
    `Strategy: ${selected.strategy}`,
    numberedSteps,
    "",
    "Execute this plan pragmatically; adapt if new information appears.",
    "",
    "Original user request:",
    prompt,
  ].join("\n");
}

function resolvePlanSearchBudgetConfig(
  raw:
    | {
        maxTokens?: number;
        maxRuntimeMs?: number;
        maxCostUsd?: number;
      }
    | undefined,
): PlanSearchBudgetConfig {
  return {
    maxTokens: normalizePositiveNumber(raw?.maxTokens),
    maxRuntimeMs: normalizePositiveNumber(raw?.maxRuntimeMs),
    maxCostUsd: normalizePositiveNumber(raw?.maxCostUsd),
  };
}

export function resolvePlanSearchRuntimeConfig(
  config?: OpenClawConfig,
): PlanSearchRuntimeConfig | undefined {
  const raw = config?.agents?.defaults?.planSearch;
  if (!raw?.enabled) {
    return undefined;
  }

  return {
    enabled: true,
    candidateCount: clampCandidateCount(raw.candidates),
    scoringMode: raw.scoring === "llm" ? "llm" : "heuristic",
    includeSelectedPlanInPrompt: raw.includeSelectedPlanInPrompt !== false,
    budget: resolvePlanSearchBudgetConfig(raw.budget),
  };
}

export function runPlanSearch(params: {
  prompt: string;
  runtimeConfig: PlanSearchRuntimeConfig;
  scorer?: PlanCandidateScorer;
  computeEstimator?: PlanCandidateComputeEstimator;
  modelCost?: ModelCostProfile;
}): PlanSearchResult {
  const { prompt, runtimeConfig } = params;
  const candidates = buildCandidatePlans(prompt, runtimeConfig.candidateCount);
  const resolvedScorer = resolveScorer(prompt, runtimeConfig.scoringMode);
  const scorer = params.scorer ?? resolvedScorer.scorer;
  const computeEstimator =
    params.computeEstimator ??
    ((candidate) =>
      estimateCandidateCompute({
        prompt,
        candidate,
        modelCost: params.modelCost,
      }));

  let appliedScoringMode: EmbeddedPiPlanSearchMeta["appliedScoringMode"] = params.scorer
    ? runtimeConfig.scoringMode
    : resolvedScorer.appliedScoringMode;
  let scored: ScoredPlanCandidate[];
  let scoringFailed = false;
  let scoringError: string | undefined;

  try {
    scored = candidates.map((candidate) => {
      const result = scorer(candidate);
      const estimate = computeEstimator(candidate);
      const budget = assessBudget({
        estimate,
        budget: runtimeConfig.budget,
      });
      const score = Number(
        (result.performanceGain / Math.max(0.001, budget.computeCost)).toFixed(6),
      );
      return {
        ...candidate,
        score,
        performanceGain: result.performanceGain,
        computeCost: budget.computeCost,
        estimatedTokens: Math.max(1, Math.trunc(estimate.estimatedTokens)),
        estimatedRuntimeMs: Math.max(1, Math.trunc(estimate.estimatedRuntimeMs)),
        estimatedCostUsd: Number(Math.max(0, estimate.estimatedCostUsd).toFixed(6)),
        withinBudget: budget.withinBudget,
        budgetViolations: budget.budgetViolations,
        rationale: result.rationale,
      };
    });
  } catch (error) {
    scoringFailed = true;
    scoringError = describeError(error);
    appliedScoringMode = "heuristic";
    scored = candidates.map((candidate, index) => {
      const estimate = computeEstimator(candidate);
      const budget = assessBudget({
        estimate,
        budget: runtimeConfig.budget,
      });
      return {
        ...candidate,
        score: Number(((index === 0 ? 1 : 0.25) / Math.max(0.001, budget.computeCost)).toFixed(6)),
        performanceGain: index === 0 ? 1 : 0.25,
        computeCost: budget.computeCost,
        estimatedTokens: Math.max(1, Math.trunc(estimate.estimatedTokens)),
        estimatedRuntimeMs: Math.max(1, Math.trunc(estimate.estimatedRuntimeMs)),
        estimatedCostUsd: Number(Math.max(0, estimate.estimatedCostUsd).toFixed(6)),
        withinBudget: budget.withinBudget,
        budgetViolations: budget.budgetViolations,
        rationale: ["scoring_failed_fallback_to_first_candidate"],
      };
    });
  }

  const considered = scored.toSorted((a, b) => {
    if (a.withinBudget !== b.withinBudget) {
      return a.withinBudget ? -1 : 1;
    }
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (a.computeCost !== b.computeCost) {
      return a.computeCost - b.computeCost;
    }
    return a.id.localeCompare(b.id);
  });
  const selected = considered[0] ?? {
    ...candidates[0],
    score: 0,
    performanceGain: 0.25,
    computeCost: 1,
    estimatedTokens: estimatePromptTokens(prompt),
    estimatedRuntimeMs: DEFAULT_PLAN_RUNTIME_BUDGET_MS,
    estimatedCostUsd: 0,
    withinBudget: true,
    budgetViolations: [],
    rationale: ["single_candidate_default"],
  };

  const promptIncludesSelectedPlan =
    runtimeConfig.includeSelectedPlanInPrompt && selected.withinBudget;
  const promptWithPlan = promptIncludesSelectedPlan
    ? buildPromptWithSelectedPlan(prompt, selected)
    : prompt;
  const withinBudgetCount = considered.filter((candidate) => candidate.withinBudget).length;
  const overBudgetCount = considered.length - withinBudgetCount;

  const meta: EmbeddedPiPlanSearchMeta = {
    enabled: true,
    candidateCount: runtimeConfig.candidateCount,
    configuredScoringMode: runtimeConfig.scoringMode,
    appliedScoringMode,
    objective: "performance_gain / compute_cost",
    selectedCandidateId: selected.id,
    selectedScore: selected.score,
    selectedPerformanceGain: selected.performanceGain,
    selectedComputeCost: selected.computeCost,
    selectedWithinBudget: selected.withinBudget,
    promptIncludesSelectedPlan,
    budget: {
      maxTokens: runtimeConfig.budget.maxTokens,
      maxRuntimeMs: runtimeConfig.budget.maxRuntimeMs,
      maxCostUsd: runtimeConfig.budget.maxCostUsd,
      withinBudgetCount,
      overBudgetCount,
    },
    considered: considered.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      strategy: candidate.strategy,
      score: candidate.score,
      performanceGain: candidate.performanceGain,
      computeCost: candidate.computeCost,
      estimatedTokens: candidate.estimatedTokens,
      estimatedRuntimeMs: candidate.estimatedRuntimeMs,
      estimatedCostUsd: candidate.estimatedCostUsd,
      withinBudget: candidate.withinBudget,
      budgetViolations: candidate.budgetViolations,
      rationale: candidate.rationale,
      stepCount: candidate.steps.length,
    })),
    scoringFailed: scoringFailed ? true : undefined,
    scoringError,
  };

  return {
    prompt: promptWithPlan,
    selected,
    considered,
    meta,
  };
}
