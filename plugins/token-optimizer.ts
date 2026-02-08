/**
 * OpenClaw Token Optimizer Plugin
 *
 * Pre-flight message classification and intelligent routing for token savings.
 * Uses the message_received hook to intercept and classify messages before agent processing.
 */

import type {
    OpenClawPluginApi,
    OpenClawPluginDefinition,
    PluginHookMessageContext,
    PluginHookMessageReceivedEvent,
} from "../plugins/types.js";

// Complexity classification patterns
const COMPLEXITY_PATTERNS = {
  TRIVIAL: {
    patterns: [
      /^(hi|hello|hey|status|ping|test)\b/i,
      /^what('s| is) (the )?(time|date|weather)/i,
      /^(check|show|list|get) (status|version|info)/i,
      /^is .+ (running|online|working|up)/i,
    ],
    keywords: ["hello", "hi", "status", "ping", "version", "uptime"],
    maxTokens: 50,
    model: "anthropic/claude-3-5-haiku-20241022",
    thinking: "off",
  },

  LOW: {
    patterns: [
      /^(validate|verify|confirm|check if)/i,
      /^(read|show|display|print) (file|log|config)/i,
      /^(start|stop|restart) (bot|service|process)/i,
      /^(update|set|change) (config|setting|parameter)/i,
      /^(calculate|compute) \w+ (from|using|with)/i,
    ],
    keywords: ["validate", "check", "verify", "show", "list", "read", "simple"],
    maxTokens: 150,
    model: "anthropic/claude-3-5-haiku-20241022",
    thinking: "minimal",
  },

  MEDIUM: {
    patterns: [
      /^(analyze|review|compare|evaluate)/i,
      /^(explain|describe|summarize) (how|why|what)/i,
      /^(find|identify|detect) (issue|problem|error)/i,
      /^(optimize|improve|enhance|refactor)/i,
      /^(design|plan|strategy|approach) for/i,
    ],
    keywords: [
      "analyze",
      "review",
      "compare",
      "explain",
      "optimize",
      "multiple",
      "several",
    ],
    maxTokens: 500,
    model: "anthropic/claude-3-5-sonnet-20241022",
    thinking: "low",
  },

  HIGH: {
    patterns: [
      /^(debug|troubleshoot|diagnose|investigate)/i,
      /^(why (is|does|did)|what('s| is) causing)/i,
      /^(design|architect|build) (new|novel|complex)/i,
      /^(solve|fix|resolve) (complex|difficult|tricky)/i,
      /^(research|explore|discover|figure out)/i,
    ],
    keywords: [
      "debug",
      "complex",
      "novel",
      "difficult",
      "why",
      "investigate",
      "research",
    ],
    maxTokens: 2000,
    model: "anthropic/claude-sonnet-4-5-20250929",
    thinking: "medium",
  },

  CRITICAL: {
    patterns: [
      /^(urgent|emergency|critical|immediate)/i,
      /^(system|bot|service) (down|crashed|failing|broken)/i,
      /^(losing|lost) (money|funds|position)/i,
      /^(security|breach|hack|attack)/i,
    ],
    keywords: [
      "urgent",
      "emergency",
      "critical",
      "down",
      "crashed",
      "security",
      "breach",
    ],
    maxTokens: 4000,
    model: "anthropic/claude-sonnet-4-5-20250929",
    thinking: "high",
  },
};

// Token budget tracking
class TokenBudget {
  private dailyLimit = 100000; // 100k tokens per day
  private usage = new Map<string, number>();

  getDateKey(): string {
    return new Date().toISOString().split("T")[0];
  }

  getTodayUsage(): number {
    const today = this.getDateKey();
    return this.usage.get(today) || 0;
  }

  recordUsage(tokens: number, model: string): void {
    const today = this.getDateKey();
    const current = this.usage.get(today) || 0;
    this.usage.set(today, current + tokens);
  }

  getRemainingBudget(): number {
    return this.dailyLimit - this.getTodayUsage();
  }

  shouldDowngrade(): boolean {
    const remaining = this.getRemainingBudget();
    const percentUsed = ((this.dailyLimit - remaining) / this.dailyLimit) * 100;
    return percentUsed > 70;
  }

  getRecommendedTier(requestedTier: string): string {
    if (!this.shouldDowngrade()) {
      return requestedTier;
    }

    const tiers = ["TRIVIAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
    const currentIndex = tiers.indexOf(requestedTier);

    const remaining = this.getRemainingBudget();
    const percentRemaining = (remaining / this.dailyLimit) * 100;

    if (percentRemaining < 10) {
      return "minimal";
    } else if (percentRemaining < 30) {
      return tiers[Math.max(0, currentIndex - 2)];
    } else {
      return tiers[Math.max(0, currentIndex - 1)];
    }
  }
}

const tokenBudget = new TokenBudget();

// Classification functions
function classifyComplexity(
  message: string,
  context: any = {},
): {
  complexity: string;
  config: any;
  score: number;
  reasoning: string;
} {
  const text = message.toLowerCase().trim();
  const wordCount = text.split(/\s+/).length;

  // Start with base classification
  let complexity = "MEDIUM";
  let score = 0;

  // Check each tier's patterns
  for (const [tier, config] of Object.entries(COMPLEXITY_PATTERNS)) {
    const patternMatch = config.patterns.some((p) => p.test(message));
    const keywordMatch = config.keywords.some((k) => text.includes(k));

    if (patternMatch || keywordMatch) {
      complexity = tier;
      break;
    }
  }

  // Apply context signals
  const CONTEXT_SIGNALS = {
    COMPLEXITY_BOOSTERS: [
      { pattern: /\b(multiple|several|many|various)\b/i, boost: 1 },
      { pattern: /\b(complex|complicated|difficult|tricky)\b/i, boost: 2 },
      { pattern: /\b(novel|new|unprecedented|unique)\b/i, boost: 2 },
      { pattern: /\b(why|how come|what's causing)\b/i, boost: 1 },
      { pattern: /\b(debug|troubleshoot|investigate)\b/i, boost: 2 },
      { pattern: /\b(design|architect|strategy)\b/i, boost: 1 },
    ],

    COMPLEXITY_REDUCERS: [
      { pattern: /\b(simple|basic|straightforward|easy)\b/i, reduce: 1 },
      { pattern: /\b(just|only|merely)\b/i, reduce: 1 },
      { pattern: /\b(quick|fast|brief)\b/i, reduce: 1 },
    ],
  };

  for (const booster of CONTEXT_SIGNALS.COMPLEXITY_BOOSTERS) {
    if (booster.pattern.test(message)) {
      score += booster.boost;
    }
  }

  for (const reducer of CONTEXT_SIGNALS.COMPLEXITY_REDUCERS) {
    if (reducer.pattern.test(message)) {
      score -= reducer.reduce;
    }
  }

  // Adjust based on message length
  if (wordCount > 100) score += 1;
  if (wordCount > 200) score += 1;

  // Adjust based on context
  if (context.hasCodeBlock) score += 1;
  if (context.hasError) score += 2;
  if (context.isFollowUp && context.previousFailed) score += 2;
  if (context.mentionsMultipleFiles) score += 1;

  // Apply score adjustments
  const tiers = ["TRIVIAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
  let currentIndex = tiers.indexOf(complexity);
  currentIndex = Math.max(0, Math.min(tiers.length - 1, currentIndex + score));
  complexity = tiers[currentIndex];

  const reasons = [];
  const config = COMPLEXITY_PATTERNS[complexity];
  const matchedPattern = config.patterns.find((p) => p.test(message));
  if (matchedPattern) {
    reasons.push(`Pattern match: ${matchedPattern.source}`);
  }

  if (score > 0) reasons.push(`Complexity boosted by ${score}`);
  if (score < 0) reasons.push(`Complexity reduced by ${Math.abs(score)}`);

  if (context.hasCodeBlock) reasons.push("Contains code block");
  if (context.hasError) reasons.push("Contains error message");
  if (context.isFollowUp) reasons.push("Follow-up question");

  return {
    complexity,
    config,
    score,
    reasoning: reasons.join("; "),
  };
}

function extractContext(message: string, metadata: any = {}) {
  return {
    hasCodeBlock: /```/.test(message),
    hasError: /error|exception|failed|crash/i.test(message),
    isFollowUp: metadata.isFollowUp || false,
    previousFailed: metadata.previousFailed || false,
    mentionsMultipleFiles:
      (message.match(/\.(js|py|json|md|txt|ts|jsx)/g) || []).length > 2,
    hasStackTrace:
      /at \w+\.\w+/.test(message) || /File ".*", line \d+/.test(message),
    hasURL: /https?:\/\//.test(message),
  };
}

function compressContext(message: string, classification: any): string {
  const { complexity, config } = classification;

  if (complexity === "TRIVIAL" || complexity === "LOW") {
    let compressed = message;

    if (!/```/.test(message)) {
      compressed = message.substring(0, config.maxTokens * 4);
    }

    compressed = compressed.replace(/\s+/g, " ");

    compressed = compressed.replace(/```[\s\S]{500,}?```/g, (match) => {
      return match.substring(0, 500) + "\n... (truncated)\n```";
    });

    if (compressed.length > 2000) {
      compressed =
        compressed.substring(0, 2000) +
        "\n... (context truncated for efficiency)";
    }

    return compressed;
  }

  return message;
}

// Main plugin definition
const tokenOptimizerPlugin: OpenClawPluginDefinition = {
  id: "token-optimizer",
  name: "Token Optimizer",
  version: "1.0.0",
  description:
    "Pre-flight complexity classification and intelligent routing for token savings",

  configSchema: {
    safeParse: (value: unknown) => {
      try {
        const parsed = typeof value === "string" ? JSON.parse(value) : value;
        return { success: true, data: parsed };
      } catch {
        return { success: false, error: { issues: [] } };
      }
    },
    uiHints: {
      dailyLimit: {
        label: "Daily Token Limit",
        help: "Maximum tokens to use per day (default: 100000)",
        placeholder: "100000",
      },
      enableBudgetDowngrade: {
        label: "Enable Budget Downgrade",
        help: "Automatically downgrade model tiers when approaching daily limit",
      },
    },
    jsonSchema: {
      type: "object",
      properties: {
        dailyLimit: {
          type: "number",
          default: 100000,
          minimum: 10000,
          maximum: 1000000,
        },
        enableBudgetDowngrade: {
          type: "boolean",
          default: true,
        },
        logClassifications: {
          type: "boolean",
          default: false,
        },
      },
    },
  },

  register: (api: OpenClawPluginApi) => {
    // Override token budget settings from config
    if (api.pluginConfig?.dailyLimit) {
      (tokenBudget as any).dailyLimit = api.pluginConfig.dailyLimit;
    }

    // Register the message_received hook for pre-flight classification
    api.on(
      "message_received",
      async (
        event: PluginHookMessageReceivedEvent,
        ctx: PluginHookMessageContext,
      ) => {
        const { content, metadata } = event;

        // Extract context
        const msgContext = extractContext(content, metadata);

        // Classify complexity
        const classification = classifyComplexity(content, msgContext);

        // Log classification if enabled
        if (api.pluginConfig?.logClassifications) {
          api.logger.info(
            `[Token Optimizer] ${classification.complexity} | ${classification.reasoning}`,
          );
        }

        // Check budget and potentially downgrade
        let effectiveTier = classification.complexity;
        if (api.pluginConfig?.enableBudgetDowngrade) {
          effectiveTier = (tokenBudget as any).getRecommendedTier(
            classification.complexity,
          );
          if (effectiveTier !== classification.complexity) {
            api.logger.info(
              `[Token Optimizer] Budget constraint: ${classification.complexity} -> ${effectiveTier}`,
            );
          }
        }

        // Compress context if needed
        const compressedContent = compressContext(content, classification);

        // Store classification in global registry for downstream processing
        (globalThis as any).tokenOptimizerLastClassification = {
          classification,
          effectiveTier,
          metadata: {
            ...metadata,
            complexity: classification.complexity,
            effectiveTier,
            originalLength: content.length,
            compressedLength: compressedContent.length,
            classificationReasoning: classification.reasoning,
            recommendedModel: COMPLEXITY_PATTERNS[effectiveTier].model,
            recommendedThinking: COMPLEXITY_PATTERNS[effectiveTier].thinking,
          },
          timestamp: Date.now(),
        };

        api.logger.debug(
          `[Token Optimizer] Classified: ${classification.complexity} -> ${effectiveTier} (${content.length} -> ${compressedContent.length} chars)`,
        );
      },
    );

    // Register a gateway method to get classification info
    api.registerGatewayMethod(
      "token_optimizer_classify",
      async (params: any) => {
        const { message } = params;
        const classification = classifyComplexity(message);
        return {
          classification,
          recommendation: COMPLEXITY_PATTERNS[classification.complexity],
          budget: {
            dailyLimit: (tokenBudget as any).dailyLimit,
            used: tokenBudget.getTodayUsage(),
            remaining: tokenBudget.getRemainingBudget(),
            shouldDowngrade: (tokenBudget as any).shouldDowngrade(),
          },
        };
      },
    );

    // Register a CLI command to check token usage
    api.registerCommand({
      name: "token-usage",
      description: "Check current token usage and budget status",
      handler: async (args: any, options: any) => {
        const usage = tokenBudget.getTodayUsage();
        const remaining = tokenBudget.getRemainingBudget();
        const percentUsed =
          (((tokenBudget as any).dailyLimit - remaining) /
            (tokenBudget as any).dailyLimit) *
          100;

        return {
          usage,
          remaining,
          percentUsed: Math.round(percentUsed * 10) / 10,
          dailyLimit: (tokenBudget as any).dailyLimit,
          shouldDowngrade: (tokenBudget as any).shouldDowngrade(),
          lastClassification: (globalThis as any)
            .tokenOptimizerLastClassification,
        };
      },
    });

    api.logger.info("[Token Optimizer] Plugin registered successfully");
  },
};

export default tokenOptimizerPlugin;
