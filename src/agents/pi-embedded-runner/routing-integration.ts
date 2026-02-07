/**
 * Integration layer between model routing and agent runner
 */

import type { OpenClawConfig } from "../../config/config.js";
import {
  routeMessage,
  type RoutingConfig,
  DEFAULT_ROUTING_CONFIG,
  type TaskClassification,
} from "../model-routing.js";
import { parseModelRef } from "../model-selection.js";
import { log } from "./logger.js";

export interface RoutingDecision {
  originalProvider: string;
  originalModel: string;
  routedProvider: string | null;
  routedModel: string | null;
  classification: TaskClassification | null;
  wasRouted: boolean;
  reason: string;
}

/**
 * Extract routing config from OpenClaw config
 */
export function extractRoutingConfig(cfg?: OpenClawConfig): RoutingConfig | null {
  const routing = (cfg?.agents?.defaults as any)?.modelRouting;
  if (!routing) {
    return null;
  }
  
  // Merge with defaults
  return {
    ...DEFAULT_ROUTING_CONFIG,
    ...routing,
    keywords: {
      ...DEFAULT_ROUTING_CONFIG.keywords,
      ...(routing.keywords || {}),
    },
    learning: {
      ...DEFAULT_ROUTING_CONFIG.learning,
      ...(routing.learning || {}),
    },
    override: {
      ...DEFAULT_ROUTING_CONFIG.override,
      ...(routing.override || {}),
    },
  };
}

/**
 * Apply intelligent routing to model selection
 * This is called BEFORE resolveModel in the agent runner
 */
export function applyModelRouting(params: {
  message: string;
  provider: string;
  modelId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  defaultProvider: string;
}): RoutingDecision {
  const { message, provider, modelId, sessionKey, config, defaultProvider } = params;
  
  // Extract routing config
  const routingConfig = extractRoutingConfig(config);
  
  // If no routing config or disabled, return original
  if (!routingConfig || !routingConfig.enabled) {
    return {
      originalProvider: provider,
      originalModel: modelId,
      routedProvider: null,
      routedModel: null,
      classification: null,
      wasRouted: false,
      reason: "routing_disabled",
    };
  }

  // Determine session type
  const sessionType = sessionKey?.startsWith("agent:main:main")
    ? "main"
    : sessionKey?.startsWith("agent:group:")
      ? "group"
      : "isolated";

  // Route the message
  const result = routeMessage(
    {
      message,
      sessionType,
    },
    routingConfig
  );

  // If routing doesn't suggest override, return original
  if (!result.shouldOverride || !result.suggestedModel) {
    log.info(
      `[model-routing] no_override taskType=${result.classification.taskType} confidence=${(result.classification.confidence * 100).toFixed(0)}% model=${provider}/${modelId}`
    );
    return {
      originalProvider: provider,
      originalModel: modelId,
      routedProvider: null,
      routedModel: null,
      classification: result.classification,
      wasRouted: false,
      reason: "confidence_too_low",
    };
  }

  // Parse suggested model
  const parsed = parseModelRef(result.suggestedModel, defaultProvider);
  if (!parsed) {
    log.warn(
      `[model-routing] failed_to_parse suggested=${result.suggestedModel} using=${provider}/${modelId}`
    );
    return {
      originalProvider: provider,
      originalModel: modelId,
      routedProvider: null,
      routedModel: null,
      classification: result.classification,
      wasRouted: false,
      reason: "parse_error",
    };
  }

  // Check if routing would actually change the model
  if (parsed.provider === provider && parsed.model === modelId) {
    log.info(
      `[model-routing] same_model taskType=${result.classification.taskType} model=${provider}/${modelId}`
    );
    return {
      originalProvider: provider,
      originalModel: modelId,
      routedProvider: null,
      routedModel: null,
      classification: result.classification,
      wasRouted: false,
      reason: "same_as_original",
    };
  }

  // Log routing decision
  log.info(
    `[model-routing] routed taskType=${result.classification.taskType} confidence=${(result.classification.confidence * 100).toFixed(0)}% from=${provider}/${modelId} to=${parsed.provider}/${parsed.model}`
  );

  return {
    originalProvider: provider,
    originalModel: modelId,
    routedProvider: parsed.provider,
    routedModel: parsed.model,
    classification: result.classification,
    wasRouted: true,
    reason: "routed",
  };
}

/**
 * Log routing decision to session metadata
 * This can be used for performance tracking and learning
 */
export function logRoutingDecision(
  decision: RoutingDecision,
  sessionId: string,
  runId: string
): void {
  if (!decision.wasRouted) {
    return;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    sessionId,
    runId,
    taskType: decision.classification?.taskType,
    confidence: decision.classification?.confidence,
    originalModel: `${decision.originalProvider}/${decision.originalModel}`,
    routedModel: `${decision.routedProvider}/${decision.routedModel}`,
    reasoning: decision.classification?.reasoning,
  };

  log.info(`[model-routing-decision] ${JSON.stringify(logEntry)}`);
}
