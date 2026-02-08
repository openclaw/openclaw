/**
 * Intelligent model routing based on task complexity
 * Routes messages to cost-effective models (local/Haiku/Sonnet) while maintaining quality
 */

export type TaskType =
  | "status_check"
  | "draft_message"
  | "proposal_creation"
  | "technical_discussion"
  | "file_operation"
  | "analysis"
  | "general";

export type TaskComplexity = "simple" | "medium" | "complex";

export interface TaskClassification {
  taskType: TaskType;
  complexity: TaskComplexity;
  confidence: number; // 0-1
  recommendedModel: string; // e.g., "ollama/llama3.1:8b", "anthropic/claude-3-5-haiku"
  reasoning: string;
}

export interface RoutingRule {
  taskType: TaskType;
  modelRef: string; // provider/model format
  confidence: number;
}

export interface RoutingConfig {
  enabled: boolean;
  rules: Record<TaskType, string>; // taskType -> model
  keywords: {
    local_triggers: string[];
    haiku_triggers: string[];
    sonnet_triggers: string[];
  };
  learning: {
    enabled: boolean;
    trackPerformance: boolean;
    optimizeAfterTasks: number;
  };
  override: {
    minConfidence: number;
    fallback: string;
  };
}

export interface ModelRoutingContext {
  message: string;
  sessionType?: "main" | "group" | "isolated";
  previousTasks?: TaskType[];
  userPreference?: string;
}

/**
 * Default routing configuration
 */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  enabled: false, // Opt-in by default
  rules: {
    status_check: "ollama/llama3.1:8b",
    file_operation: "ollama/llama3.1:8b",
    draft_message: "anthropic/claude-3-5-haiku-20241022",
    general: "anthropic/claude-3-5-haiku-20241022",
    proposal_creation: "anthropic/claude-sonnet-4-5",
    technical_discussion: "anthropic/claude-sonnet-4-5",
    analysis: "anthropic/claude-sonnet-4-5",
  },
  keywords: {
    local_triggers: [
      "check",
      "status",
      "list",
      "show",
      "find",
      "read",
      "get",
      "view",
      "file",
      "what's in",
      "search",
    ],
    haiku_triggers: [
      "draft",
      "follow up",
      "reply",
      "message",
      "send",
      "write",
      "summarize",
      "brief",
      "quick",
      "simple",
    ],
    sonnet_triggers: [
      "proposal",
      "create detailed",
      "analyze",
      "complex",
      "technical",
      "strategic",
      "review code",
      "explain",
      "architecture",
      "recommend",
      "compare",
      "evaluate",
    ],
  },
  learning: {
    enabled: true,
    trackPerformance: true,
    optimizeAfterTasks: 100,
  },
  override: {
    minConfidence: 0.7,
    fallback: "anthropic/claude-3-5-haiku-20241022",
  },
};

/**
 * Classify a task based on message content
 */
export function classifyTask(
  message: string,
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): TaskClassification {
  const lowerMsg = message.toLowerCase();
  const wordCount = message.split(/\s+/).length;

  // Count keyword matches for each tier
  const scores = {
    local: 0,
    haiku: 0,
    sonnet: 0,
  };

  // Check local triggers
  config.keywords.local_triggers.forEach((keyword) => {
    if (lowerMsg.includes(keyword.toLowerCase())) {
      scores.local += 2;
    }
  });

  // Check haiku triggers
  config.keywords.haiku_triggers.forEach((keyword) => {
    if (lowerMsg.includes(keyword.toLowerCase())) {
      scores.haiku += 2;
    }
  });

  // Check sonnet triggers
  config.keywords.sonnet_triggers.forEach((keyword) => {
    if (lowerMsg.includes(keyword.toLowerCase())) {
      scores.sonnet += 2;
    }
  });

  // Message length analysis
  if (wordCount < 10) {
    scores.local += 1;
  } else if (wordCount < 30) {
    scores.haiku += 1;
  } else {
    scores.sonnet += 1;
  }

  // Technical terms increase sonnet score
  const technicalTerms = [
    "api",
    "database",
    "architecture",
    "algorithm",
    "optimization",
    "integration",
    "implementation",
    "deployment",
  ];
  technicalTerms.forEach((term) => {
    if (lowerMsg.includes(term)) {
      scores.sonnet += 3;
    }
  });

  // Determine task type based on keywords
  let taskType: TaskType = "general";
  let complexity: TaskComplexity = "medium";

  if (lowerMsg.match(/\b(check|status|list|show)\b/)) {
    taskType = "status_check";
    complexity = "simple";
  } else if (lowerMsg.match(/\b(draft|follow|reply|message)\b/)) {
    taskType = "draft_message";
    complexity = "medium";
  } else if (lowerMsg.match(/\b(proposal|create|detailed)\b/)) {
    taskType = "proposal_creation";
    complexity = "complex";
  } else if (lowerMsg.match(/\b(analyze|technical|review)\b/)) {
    taskType = "technical_discussion";
    complexity = "complex";
  } else if (lowerMsg.match(/\b(read|file|get|find)\b/)) {
    taskType = "file_operation";
    complexity = "simple";
  } else if (lowerMsg.match(/\b(compare|evaluate|explain)\b/)) {
    taskType = "analysis";
    complexity = "complex";
  }

  // Get recommended model from rules or determine from scores
  let recommendedModel =
    config.rules[taskType] || config.override.fallback || DEFAULT_ROUTING_CONFIG.override.fallback;

  // Calculate confidence
  const maxScore = Math.max(scores.local, scores.haiku, scores.sonnet);
  const totalScore = scores.local + scores.haiku + scores.sonnet;
  const confidence = totalScore > 0 ? maxScore / totalScore : 0.5;

  // Override based on scores if confidence is high enough
  if (confidence > config.override.minConfidence) {
    if (scores.sonnet === maxScore) {
      // Keep sonnet from rules if already set
      if (!recommendedModel.includes("sonnet")) {
        recommendedModel = "anthropic/claude-sonnet-4-5";
      }
    } else if (scores.haiku === maxScore) {
      recommendedModel = "anthropic/claude-3-5-haiku-20241022";
    } else if (scores.local === maxScore) {
      recommendedModel = "ollama/llama3.1:8b";
    }
  }

  const reasoning = `Classified as ${taskType} (complexity: ${complexity}) with ${(confidence * 100).toFixed(0)}% confidence. Scores: local=${scores.local}, haiku=${scores.haiku}, sonnet=${scores.sonnet}`;

  return {
    taskType,
    complexity,
    confidence,
    recommendedModel,
    reasoning,
  };
}

/**
 * Route a message to the optimal model
 */
export function routeMessage(
  context: ModelRoutingContext,
  config: RoutingConfig = DEFAULT_ROUTING_CONFIG,
): {
  classification: TaskClassification;
  shouldOverride: boolean;
  suggestedModel: string | null;
} {
  // If routing disabled, don't override
  if (!config.enabled) {
    return {
      classification: classifyTask(context.message, config),
      shouldOverride: false,
      suggestedModel: null,
    };
  }

  // Check for user-specified model preference (e.g., "[use sonnet]")
  const userOverride = context.message.match(/\[use (local|haiku|sonnet)\]/i);
  if (userOverride) {
    const pref = userOverride[1].toLowerCase();
    const modelMap: Record<string, string> = {
      local: "ollama/llama3.1:8b",
      haiku: "anthropic/claude-3-5-haiku-20241022",
      sonnet: "anthropic/claude-sonnet-4-5",
    };
    return {
      classification: classifyTask(context.message, config),
      shouldOverride: true,
      suggestedModel: modelMap[pref] || null,
    };
  }

  // Classify the task
  const classification = classifyTask(context.message, config);

  // Only override if confidence is high enough
  const shouldOverride = classification.confidence >= config.override.minConfidence;

  return {
    classification,
    shouldOverride,
    suggestedModel: shouldOverride ? classification.recommendedModel : null,
  };
}

/**
 * Format routing decision for logging
 */
export function formatRoutingDecision(
  classification: TaskClassification,
  actualModel: string,
  _shouldOverride: boolean,
): string {
  const match = classification.recommendedModel === actualModel;
  const savings = match ? "✓" : "→";
  return `${savings} ${classification.taskType} (${(classification.confidence * 100).toFixed(0)}%): ${classification.recommendedModel} ${match ? "==" : "!="} ${actualModel}`;
}
