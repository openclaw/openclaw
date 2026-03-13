/**
 * Escalation Gate
 *
 * Strict decision gate for task routing.
 * Enforces: RAG → Workflow → Agent (with justification required)
 * Reduces API costs by preventing unnecessary AI calls.
 */

import { appendDecision } from "./decision-log.js";

// Classification patterns
const PATTERNS = {
  // Level 1: RAG-only (no AI generation)
  ragOnly: {
    patterns: [
      "what did we",
      "remind me",
      "what is",
      "where is",
      "when did",
      "show me",
      "list",
      "get info",
      "retrieve",
      "lookup",
      "find file",
      "read memory",
      "check status",
      "get config",
    ],
    tools: ["memory_search", "read", "exec (simple)"],
  },

  // Level 2: Workflow (deterministic, no reasoning)
  workflow: {
    patterns: [
      "run cron",
      "backup",
      "restart",
      "deploy",
      "update",
      "sync",
      "compress",
      "archive",
      "move file",
      "copy",
      "delete old",
      "run test",
      "check health",
      "monitor",
    ],
    tools: ["exec", "write", "edit (mechanical)"],
  },

  // Level 3: Agent (requires reasoning/generation)
  agent: {
    patterns: [
      "analyze",
      "design",
      "create",
      "build",
      "implement",
      "write code",
      "review",
      "compare",
      "recommend",
      "plan",
      "architect",
      "debug",
      "fix",
      "refactor",
      "optimize",
    ],
    tools: ["sessions_spawn", "web_search", "browser", "complex edit"],
  },
};

// Complexity indicators that force higher levels
const COMPLEXITY_FORCERS = {
  high: ["architecture", "system design", "framework", "platform", "microservices"],
  medium: ["integrate", "workflow", "automation", "pipeline"],
};

export interface ExecutionPlan {
  level: "rag" | "workflow" | "agent";
  confidence: number;
  justification: string;
  requiresAI: boolean;
  maxTokens: number;
  tools: string[];
  checkpoint: boolean;
  complexity?: string;
  maxSteps?: number;
}

/**
 * Determine the appropriate execution level for a request
 */
export function determineLevel(
  request: string,
  context: Record<string, unknown> = {},
): ExecutionPlan {
  const requestLower = request.toLowerCase();

  // Check for RAG-only patterns
  const ragScore = scorePatterns(requestLower, PATTERNS.ragOnly.patterns);
  if (ragScore > 0 && !hasComplexityForcers(requestLower)) {
    return {
      level: "rag",
      confidence: ragScore,
      justification: "Information retrieval only",
      requiresAI: false,
      maxTokens: 0,
      tools: PATTERNS.ragOnly.tools,
      checkpoint: false,
    };
  }

  // Check for workflow patterns
  const workflowScore = scorePatterns(requestLower, PATTERNS.workflow.patterns);
  if (workflowScore > 0 && !hasComplexityForcers(requestLower, "high")) {
    return {
      level: "workflow",
      confidence: workflowScore,
      justification: "Deterministic execution",
      requiresAI: false,
      maxTokens: 1000, // Minimal for formatting
      tools: PATTERNS.workflow.tools,
      checkpoint: false,
    };
  }

  // Default to agent level (requires justification)
  const justification = (context.justification as string) || generateJustification(request);
  const complexity = assessComplexity(requestLower);

  return {
    level: "agent",
    confidence: 1.0,
    justification,
    requiresAI: true,
    maxTokens: complexity === "high" ? 100000 : 50000,
    tools: PATTERNS.agent.tools,
    checkpoint: complexity === "high" || hasDestructiveOps(requestLower),
    complexity,
    maxSteps: complexity === "high" ? 10 : 5,
  };
}

/**
 * Score how well request matches patterns
 */
function scorePatterns(request: string, patterns: string[]): number {
  let score = 0;
  for (const pattern of patterns) {
    if (request.includes(pattern)) {
      score += 1;
    }
  }
  return score;
}

/**
 * Check if request has complexity indicators
 */
function hasComplexityForcers(request: string, level: "high" | "any" = "any"): boolean {
  if (level === "high" || level === "any") {
    for (const term of COMPLEXITY_FORCERS.high) {
      if (request.includes(term)) {
        return true;
      }
    }
  }
  if (level === "any") {
    for (const term of COMPLEXITY_FORCERS.medium) {
      if (request.includes(term)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Assess complexity for agent-level tasks
 */
function assessComplexity(request: string): string {
  const indicators = {
    high: ["architecture", "system", "framework", "platform", "multiple", "integrate"],
    low: ["quick", "simple", "small", "one file", "minor"],
  };

  let highScore = 0;
  let lowScore = 0;

  for (const term of indicators.high) {
    if (request.includes(term)) {
      highScore++;
    }
  }
  for (const term of indicators.low) {
    if (request.includes(term)) {
      lowScore++;
    }
  }

  if (highScore > 0) {
    return "high";
  }
  if (lowScore > 0) {
    return "low";
  }
  return "medium";
}

/**
 * Check if request involves destructive operations
 */
function hasDestructiveOps(request: string): boolean {
  const destructive = ["delete", "remove", "drop", "destroy", "wipe", "clean"];
  return destructive.some((term) => request.includes(term));
}

/**
 * Generate automatic justification for agent level
 */
function generateJustification(request: string): string {
  const reasons: string[] = [];

  if (hasComplexityForcers(request.toLowerCase())) {
    reasons.push("Complex system design required");
  }
  if (/create|build|implement|write/i.test(request)) {
    reasons.push("Content/code generation needed");
  }
  if (/analyze|compare|review/i.test(request)) {
    reasons.push("Reasoning and evaluation required");
  }
  if (/debug|fix|optimize/i.test(request)) {
    reasons.push("Problem diagnosis and solution");
  }

  return reasons.join("; ") || "Multi-step reasoning required";
}

export interface Handlers<T> {
  rag: (req: string, context: unknown, plan: ExecutionPlan) => Promise<T>;
  workflow: (req: string, context: unknown, plan: ExecutionPlan) => Promise<T>;
  agent: (req: string, context: unknown, plan: ExecutionPlan) => Promise<T>;
}

/**
 * Execute with escalation gate
 */
export async function executeWithGate<T>(
  request: string,
  { rag, workflow, agent }: Handlers<T>,
  context: Record<string, unknown> = {},
): Promise<T> {
  const plan = determineLevel(request, context);

  // Log the routing decision
  appendDecision({
    decision: `Route to ${plan.level}`,
    context: request,
    rationale: plan.justification,
    alternatives: ["rag", "workflow", "agent"].filter((l) => l !== plan.level),
  });

  switch (plan.level) {
    case "rag":
      console.log(`[Gate] RAG level: ${plan.justification}`);
      return await rag(request, context, plan);

    case "workflow":
      console.log(`[Gate] Workflow level: ${plan.justification}`);
      return await workflow(request, context, plan);

    case "agent":
      console.log(`[Gate] Agent level: ${plan.justification}`);
      if (plan.checkpoint) {
        console.log(`[Gate] ⚠️  Human checkpoint required for ${plan.complexity} complexity`);
      }
      return await agent(request, context, plan);

    default:
      throw new Error(`Unknown level: ${String(plan.level)}`);
  }
}

/**
 * Check if a cron job should use AI
 */
export function cronJobNeedsAI(jobName: string): boolean {
  // Jobs that definitely don't need AI
  const noAIJobs = [
    "reminder-poller",
    "health-monitor",
    "backup",
    "ttl-guardian",
    "file-watcher",
    "cleanup",
    "sync",
    "archive",
  ];

  const normalized = jobName.toLowerCase();
  return !noAIJobs.some((job) => normalized.includes(job));
}
