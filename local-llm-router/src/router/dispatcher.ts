/**
 * Task dispatcher — matches classification to routing rules
 * and dispatches tasks to the correct agent.
 */

import type {
  Classification,
  Route,
  Task,
  AgentId,
  TaskStatus,
} from "../types.js";

export interface RoutingConfig {
  routes: Route[];
  confidence_threshold: number;
  fallback_on_low_confidence: "local" | "cloud";
}

/**
 * Find the matching route for a classification.
 */
export function matchRoute(
  classification: Classification,
  config: RoutingConfig,
): Route {
  // If confidence is below threshold, override engine to cloud
  const effectiveEngine =
    classification.confidence < config.confidence_threshold
      ? config.fallback_on_low_confidence
      : classification.recommended_engine;

  // Find matching route by intent
  const match = config.routes.find((r) => r.intent === classification.intent);

  if (match) {
    return {
      ...match,
      // Override model if confidence triggered cloud fallback
      model: effectiveEngine === "cloud" ? "cloud" : match.model,
    };
  }

  // Default: send unknown to comms agent via cloud
  return {
    intent: classification.intent,
    agent: "comms",
    model: effectiveEngine,
    tools: [],
    approval: "none",
  };
}

/**
 * Create a task from a user message + classification + route.
 */
export function createTask(params: {
  input: string;
  channelId: string;
  classification: Classification;
  route: Route;
}): Task {
  const now = new Date();
  const id = `task_${now.toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;

  return {
    id,
    createdAt: now.toISOString(),
    status: "pending",
    agent: params.route.agent,
    classification: params.classification,
    route: params.route,
    input: params.input,
    channelId: params.channelId,
  };
}
