/**
 * OpenClaw Token Optimizer Plugin
 *
 * Pre-flight message classification and intelligent routing for token savings.
 * Uses the message_received hook to intercept and classify messages before agent processing.
 */

// Complexity classification patterns
const COMPLEXITY_PATTERNS: Record<string, any> = {
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
      return "TRIVIAL"; // Fixed: was returning 'minimal' which crashes
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
    const patternMatch = config.patterns.some((p: RegExp) => p.test(message));
    const keywordMatch = config.keywords.some((k: string) => text.includes(k));

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
  const matchedPattern = config.patterns.find((p: RegExp) => p.test(message));
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

function compressContext(content: string, maxTokens: number): string {
  // Estimate ~4 chars per token
  const maxChars = maxTokens * 4;

  if (content.length <= maxChars) {
    return content;
  }

  // Simple compression: truncate with ellipsis
  return content.substring(0, maxChars - 20) + "\n\n[...truncated for brevity]";
}

// Main plugin definition
const tokenOptimizerPlugin = {
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

  register: (api: any) => {
    // Override token budget settings from config
    if (api.pluginConfig?.dailyLimit) {
      (tokenBudget as any).dailyLimit = api.pluginConfig.dailyLimit;
    }

    // Register the before_agent_start hook for pre-flight classification
    api.on("before_agent_start", async (event: any, ctx: any) => {
      api.logger.info(`[Token Optimizer] Hook fired!`);
      api.logger.debug(
        `[Token Optimizer] Event keys: ${Object.keys(event || {}).join(", ")}`,
      );
      api.logger.debug(
        `[Token Optimizer] Ctx keys: ${Object.keys(ctx || {}).join(", ")}`,
      );

      // The event contains 'prompt' with the actual message
      const content = event?.prompt || "";

      if (!content) {
        api.logger.debug(
          `[Token Optimizer] No content in event - skipping classification`,
        );
        return;
      }

      api.logger.info(
        `[Token Optimizer] Classifying: "${content.substring(0, 50)}..."`,
      );

      // Extract context
      const msgContext = extractContext(
        content,
        event?.metadata || ctx?.metadata || {},
      );

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

      // Get tier configuration
      const tierConfig = COMPLEXITY_PATTERNS[effectiveTier];

      // ANSI color codes for terminal output
      const tierColors: Record<string, string> = {
        TRIVIAL: "\x1b[32m", // Green
        LOW: "\x1b[34m", // Blue
        MEDIUM: "\x1b[33m", // Yellow/Orange
        HIGH: "\x1b[31m", // Red
        CRITICAL: "\x1b[35m", // Magenta
      };
      const resetColor = "\x1b[0m";
      const tierColor = tierColors[effectiveTier] || "\x1b[36m";

      // Output colored tier status to console for immediate visibility
      console.log(
        `${tierColor}┌────────────────────────────────────────────────────────────┐${resetColor}`,
      );
      console.log(
        `${tierColor}│  🎯 TOKEN OPTIMIZER                                        │${resetColor}`,
      );
      console.log(
        `${tierColor}│  Tier: ${effectiveTier.padEnd(8)} │ Model: ${tierConfig.model.split("/").pop()?.substring(0, 25).padEnd(25)} │${resetColor}`,
      );
      console.log(
        `${tierColor}│  Reason: ${classification.reasoning.substring(0, 45).padEnd(45)} │${resetColor}`,
      );
      console.log(
        `${tierColor}└────────────────────────────────────────────────────────────┘${resetColor}`,
      );

      // Apply context compression for lower tiers
      let processedContent = content;
      if (effectiveTier === "TRIVIAL" || effectiveTier === "LOW") {
        processedContent = compressContext(content, tierConfig.maxTokens);
      }

      // Use ctx to affect routing - set model and thinking level
      if (ctx && typeof ctx === "object") {
        ctx.recommendedModel = tierConfig.model;
        ctx.recommendedThinking = tierConfig.thinking;
        ctx.tokenOptimizer = {
          classification: classification.complexity,
          effectiveTier,
          originalLength: content.length,
          compressedLength: processedContent.length,
          reasoning: classification.reasoning,
        };
      }

      // Store classification for agent_end hook to access
      (globalThis as any).tokenOptimizerLastClassification = {
        classification: classification.complexity,
        effectiveTier,
        metadata: {
          recommendedModel: tierConfig.model,
          classificationReasoning: classification.reasoning,
        },
        timestamp: Date.now(),
      };

      // Modify event content if compressed
      if (processedContent !== content) {
        event.content = processedContent;
        api.logger.info(
          `[Token Optimizer] Compressed: ${content.length} -> ${processedContent.length} chars`,
        );
      }

      api.logger.debug(
        `[Token Optimizer] Classified: ${classification.complexity} -> ${effectiveTier} | Model: ${tierConfig.model}`,
      );
    });

    // Store classifications by timestamp for message association
    const messageClassifications: Record<string, any> = {};

    // Register agent_end hook to associate classification with the last assistant message
    api.on("agent_end", async (event: any, ctx: any) => {
      const lastClassification = (globalThis as any)
        .tokenOptimizerLastClassification;
      if (!lastClassification) return;

      // Find the last assistant message and store classification by its timestamp
      const messages = event?.messages;
      if (!messages || !Array.isArray(messages)) return;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === "assistant" && msg?.timestamp) {
          // Store classification keyed by message timestamp
          messageClassifications[msg.timestamp] = lastClassification;
          api.logger.info(
            `[Token Optimizer] Stored classification for message at ${msg.timestamp}`,
          );
          break;
        }
      }
    });

    // Intercept chat.history by creating a proxy endpoint
    // The Control UI will call this instead of the standard chat.history
    api.registerHttpRoute?.({
      method: "POST",
      path: "/token-optimizer/chat-history",
      handler: async (req: any, res: any) => {
        try {
          // Parse body if needed
          let body = req.body;
          if (!body && req.on) {
            // Need to read body manually
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(chunk);
            }
            const rawBody = Buffer.concat(chunks).toString();
            body = rawBody ? JSON.parse(rawBody) : {};
          }

          const sessionKey = body?.sessionKey;

          if (!sessionKey) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "sessionKey required" }));
            return;
          }

          // Get messages from the JSONL file
          // Read from session storage directly
          const fs = require("fs");
          const path = require("path");
          const os = require("os");

          // First get sessionId from sessions.json
          const sessionsFile = path.join(
            os.homedir(),
            ".openclaw",
            "agents",
            "main",
            "sessions",
            "sessions.json",
          );

          let messages: any[] = [];
          let sessionId: string | null = null;

          if (fs.existsSync(sessionsFile)) {
            const sessionsData = JSON.parse(
              fs.readFileSync(sessionsFile, "utf8"),
            );
            const session = sessionsData[sessionKey];
            if (session) {
              sessionId = session.sessionId;
            }
          }

          // Now read messages from the JSONL file
          if (sessionId) {
            const jsonlFile = path.join(
              os.homedir(),
              ".openclaw",
              "agents",
              "main",
              "sessions",
              `${sessionId}.jsonl`,
            );

            if (fs.existsSync(jsonlFile)) {
              const content = fs.readFileSync(jsonlFile, "utf8");
              // JSONL format: each line is a JSON object
              messages = content
                .split("\n")
                .filter((line: string) => line.trim())
                .map((line: string) => JSON.parse(line));
            }
          }

          // Inject badges into assistant messages
          for (const msg of messages) {
            if (
              msg.role === "assistant" &&
              msg.timestamp &&
              messageClassifications[msg.timestamp]
            ) {
              const classification = messageClassifications[msg.timestamp];
              const tierColors: Record<string, string> = {
                TRIVIAL: "#10b981",
                LOW: "#3b82f6",
                MEDIUM: "#f59e0b",
                HIGH: "#ef4444",
                CRITICAL: "#dc2626",
              };
              const tierColor =
                tierColors[classification.effectiveTier] || "#6b7280";
              const modelName =
                classification.metadata?.recommendedModel?.split("/").pop() ||
                "Unknown";

              const badge = `<div style="margin-top:8px;padding:6px 10px;background:${tierColor}15;border-left:3px solid ${tierColor};border-radius:6px;display:inline-flex;align-items:center;gap:8px;font-family:system-ui,sans-serif;font-size:12px"><span style="width:10px;height:10px;background:${tierColor};border-radius:50%"></span><span style="color:${tierColor};font-weight:600;text-transform:uppercase">${classification.effectiveTier}</span><span style="color:#64748b">|</span><span style="color:#475569;font-family:monospace">${modelName}</span></div>`;

              if (typeof msg.content === "string") {
                msg.content = msg.content + badge;
              } else if (Array.isArray(msg.content)) {
                const textContent = msg.content.find(
                  (c: any) => c?.type === "text",
                );
                if (textContent?.text) textContent.text += badge;
              }
            }
          }

          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              sessionKey,
              messages,
              thinkingLevel: "medium",
            }),
          );
        } catch (err: any) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      },
    });

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

    // Register HTTP route for visual dashboard
    api.registerHttpRoute?.({
      method: "GET",
      path: "/token-optimizer",
      handler: async (req: any, res: any) => {
        const usage = tokenBudget.getTodayUsage();
        const remaining = tokenBudget.getRemainingBudget();
        const percentUsed = (
          (usage / (tokenBudget as any).dailyLimit) *
          100
        ).toFixed(1);
        const lastClassification = (globalThis as any)
          .tokenOptimizerLastClassification;

        const getTierColor = (tier: string) => {
          const colors: Record<string, string> = {
            TRIVIAL: "#10b981", // Green
            LOW: "#3b82f6", // Blue
            MEDIUM: "#f59e0b", // Orange
            HIGH: "#ef4444", // Red
            CRITICAL: "#dc2626", // Dark Red
          };
          return colors[tier] || "#6b7280";
        };

        const getBudgetColor = (percent: number) => {
          if (percent < 50) return "#10b981";
          if (percent < 70) return "#f59e0b";
          if (percent < 90) return "#ef4444";
          return "#dc2626";
        };

        const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🎯 Token Optimizer Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1e1b4b 0%, #312e81 50%, #4338ca 100%);
      min-height: 100vh;
      padding: 20px;
      color: white;
    }
    .container {
      max-width: 900px;
      margin: 0 auto;
    }
    .header {
      text-align: center;
      margin-bottom: 30px;
      padding: 20px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    .header h1 {
      font-size: 2.5em;
      margin-bottom: 10px;
      background: linear-gradient(90deg, #60a5fa, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .header p {
      color: #94a3b8;
      font-size: 1.1em;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 15px;
      margin-bottom: 25px;
    }
    .stat-card {
      background: rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 20px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.1);
      transition: transform 0.2s;
    }
    .stat-card:hover {
      transform: translateY(-2px);
      background: rgba(255,255,255,0.12);
    }
    .stat-value {
      font-size: 2em;
      font-weight: bold;
      margin-bottom: 5px;
    }
    .stat-label {
      color: #94a3b8;
      font-size: 0.9em;
    }
    .budget-section {
      background: rgba(255,255,255,0.08);
      border-radius: 16px;
      padding: 25px;
      margin-bottom: 25px;
      border: 1px solid rgba(255,255,255,0.1);
    }
    .budget-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 15px;
    }
    .budget-title {
      font-size: 1.3em;
      font-weight: 600;
    }
    .budget-amount {
      color: #94a3b8;
    }
    .progress-bar {
      height: 24px;
      background: rgba(0,0,0,0.3);
      border-radius: 12px;
      overflow: hidden;
      position: relative;
    }
    .progress-fill {
      height: 100%;
      border-radius: 12px;
      transition: width 0.5s ease;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-right: 10px;
      font-size: 0.85em;
      font-weight: 600;
    }
    .tiers-section {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 12px;
      margin-bottom: 25px;
    }
    .tier-card {
      background: rgba(255,255,255,0.08);
      border-radius: 12px;
      padding: 18px;
      border-left: 4px solid;
      transition: all 0.2s;
    }
    .tier-card:hover {
      background: rgba(255,255,255,0.12);
      transform: scale(1.02);
    }
    .tier-name {
      font-weight: 600;
      font-size: 0.85em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .tier-model {
      font-size: 0.8em;
      color: #94a3b8;
      margin-bottom: 4px;
    }
    .tier-savings {
      font-size: 0.75em;
      color: #10b981;
    }
    .current-status {
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 25px;
      text-align: center;
      border: 2px solid ${lastClassification ? getTierColor(lastClassification.effectiveTier) : "#6b7280"};
    }
    .status-badge {
      display: inline-block;
      padding: 8px 20px;
      border-radius: 20px;
      font-weight: 600;
      font-size: 1.1em;
      margin-bottom: 15px;
    }
    .status-details {
      color: #94a3b8;
      font-size: 0.95em;
      line-height: 1.6;
    }
    .refresh-btn {
      margin-top: 20px;
      padding: 12px 30px;
      background: linear-gradient(90deg, #60a5fa, #a78bfa);
      border: none;
      border-radius: 8px;
      color: white;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
    }
    .refresh-btn:hover {
      opacity: 0.9;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .live-indicator {
      display: inline-block;
      width: 8px;
      height: 8px;
      background: #10b981;
      border-radius: 50%;
      margin-right: 8px;
      animation: pulse 2s infinite;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🎯 Token Optimizer</h1>
      <p><span class="live-indicator"></span>Live Dashboard | Intelligent Model Routing</p>
    </div>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value" style="color: ${getBudgetColor(parseFloat(percentUsed))}">${percentUsed}%</div>
        <div class="stat-label">Budget Used</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color: #3b82f6">${usage.toLocaleString()}</div>
        <div class="stat-label">Tokens Used Today</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color: #10b981">${remaining.toLocaleString()}</div>
        <div class="stat-label">Tokens Remaining</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" style="color: ${(tokenBudget as any).shouldDowngrade() ? "#ef4444" : "#10b981"}">${(tokenBudget as any).shouldDowngrade() ? "⚠️ Yes" : "✓ No"}</div>
        <div class="stat-label">Downgrade Active</div>
      </div>
    </div>

    <div class="budget-section">
      <div class="budget-header">
        <span class="budget-title">📊 Daily Token Budget</span>
        <span class="budget-amount">${usage.toLocaleString()} / ${(tokenBudget as any).dailyLimit.toLocaleString()} tokens</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${Math.min(parseFloat(percentUsed), 100)}%; background: ${getBudgetColor(parseFloat(percentUsed))}">
          ${percentUsed}%
        </div>
      </div>
    </div>

    <div class="tiers-section">
      <div class="tier-card" style="border-left-color: ${getTierColor("TRIVIAL")}">
        <div class="tier-name" style="color: ${getTierColor("TRIVIAL")}">🟢 TRIVIAL</div>
        <div class="tier-model">Haiku</div>
        <div class="tier-savings">~90% savings</div>
      </div>
      <div class="tier-card" style="border-left-color: ${getTierColor("LOW")}">
        <div class="tier-name" style="color: ${getTierColor("LOW")}">🔵 LOW</div>
        <div class="tier-model">Haiku</div>
        <div class="tier-savings">~85% savings</div>
      </div>
      <div class="tier-card" style="border-left-color: ${getTierColor("MEDIUM")}">
        <div class="tier-name" style="color: ${getTierColor("MEDIUM")}">🟠 MEDIUM</div>
        <div class="tier-model">Sonnet 3.5</div>
        <div class="tier-savings">Standard</div>
      </div>
      <div class="tier-card" style="border-left-color: ${getTierColor("HIGH")}">
        <div class="tier-name" style="color: ${getTierColor("HIGH")}">🔴 HIGH</div>
        <div class="tier-model">Sonnet 4.5</div>
        <div class="tier-savings">Premium</div>
      </div>
      <div class="tier-card" style="border-left-color: ${getTierColor("CRITICAL")}">
        <div class="tier-name" style="color: ${getTierColor("CRITICAL")}">⚫ CRITICAL</div>
        <div class="tier-model">Sonnet 4.5</div>
        <div class="tier-savings">Premium</div>
      </div>
    </div>

    <div class="current-status">
      ${
        lastClassification
          ? `
        <div class="status-badge" style="background: ${getTierColor(lastClassification.effectiveTier)}20; color: ${getTierColor(lastClassification.effectiveTier)}; border: 2px solid ${getTierColor(lastClassification.effectiveTier)}">
          ${lastClassification.effectiveTier}
        </div>
        <div class="status-details">
          <strong>Last Classification:</strong> ${lastClassification.classification} → ${lastClassification.effectiveTier}<br>
          <strong>Model:</strong> ${lastClassification.metadata?.recommendedModel || "N/A"}<br>
          <strong>Time:</strong> ${new Date(lastClassification.timestamp).toLocaleTimeString()}<br>
          ${lastClassification.metadata?.classificationReasoning ? `<em>${lastClassification.metadata.classificationReasoning}</em>` : ""}
        </div>
      `
          : `
        <div class="status-badge" style="background: rgba(255,255,255,0.1); color: #94a3b8;">
          Waiting for first message...
        </div>
        <div class="status-details">
          Send a message to see the classification in action!<br>
          Try: "hi" for TRIVIAL or "debug complex issue" for HIGH
        </div>
      `
      }
      <br>
      <button class="refresh-btn" onclick="location.reload()">🔄 Refresh Dashboard</button>
    </div>
  </div>
</body>
</html>`;

        res.setHeader("Content-Type", "text/html");
        res.end(html);
      },
    });

    api.logger.info("[Token Optimizer] Plugin registered successfully");
  },
};

export default tokenOptimizerPlugin;
