/**
 * Smart Router
 *
 * Integration of Escalation Gate + Unified Memory + Trace Standard.
 * Drop-in replacement for direct AI calls.
 */

import { determineLevel, type ExecutionPlan } from "./escalation-gate.js";
import { createTrace } from "./trace-standard.js";
import { retrieve, store } from "./unified-memory.js";

export interface RouterResult<T> {
  result: T;
  traceId: string;
  level: string;
  tokensUsed: number;
}

export interface Handlers<T> {
  rag: (req: string, context: unknown, plan: ExecutionPlan) => Promise<T>;
  workflow: (req: string, context: unknown, plan: ExecutionPlan) => Promise<T>;
  agent: (req: string, context: unknown, plan: ExecutionPlan) => Promise<T>;
}

/**
 * Process a request with full observability and routing
 */
export async function processRequest<T>(
  request: string,
  handlers: Handlers<T>,
  context: Record<string, unknown> = {},
): Promise<RouterResult<T>> {
  // Create trace
  const trace = createTrace(request);

  // Retrieve relevant context
  const memories = retrieve({ query: request, limit: 5 });
  trace.logStep({
    tool: "unified_memory.retrieve",
    input: request,
    output: `${memories.length} memories loaded`,
    latency: 50,
    success: true,
  });

  // Determine routing
  const plan = determineLevel(request, { context });
  trace.logRouting(plan);

  // Execute based on level
  let result: T;
  try {
    switch (plan.level) {
      case "rag":
        result = await handlers.rag(request, memories, plan);
        break;
      case "workflow":
        result = await handlers.workflow(request, memories, plan);
        break;
      case "agent":
        result = await handlers.agent(request, memories, plan);
        break;
      default:
        throw new Error(`Unknown level: ${String(plan.level)}`);
    }

    trace.logOutcome({ success: true, result });

    // Store experience
    store("experiences", {
      title: `Request: ${request.slice(0, 50)}`,
      content: `Level: ${plan.level}, Success: true`,
      approach: plan.level,
      outcome: "success",
      importance: plan.complexity === "high" ? 8 : 5,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    trace.logOutcome({ success: false, error: errorMessage });

    store("experiences", {
      title: `Failed: ${request.slice(0, 50)}`,
      content: `Error: ${errorMessage}`,
      approach: plan.level,
      outcome: "failure",
      importance: 7,
    });

    throw error;
  }

  return {
    result,
    traceId: trace.id,
    level: plan.level,
    tokensUsed: trace.data.metrics.totalTokens,
  };
}

export interface CronJobOptions {
  jobName: string;
  needsAI?: boolean;
}

/**
 * Execute a cron job with optional AI routing
 */
export async function runCronJob<T>(options: CronJobOptions, jobFn: () => Promise<T>): Promise<T> {
  const { jobName, needsAI = false } = options;

  if (!needsAI) {
    console.log(`[Router] Cron job ${jobName} → direct execution (no AI)`);
    // Execute directly without any routing overhead
    return await jobFn();
  }

  console.log(`[Router] Cron job ${jobName} requires AI`);
  return await jobFn();
}

/**
 * Quick check for request classification
 */
export function classifyRequest(request: string): ExecutionPlan {
  return determineLevel(request);
}
