// IntentPolicy — classify user intent and estimate complexity
// Pure function: (ctx) → { intent, complexity, estimatedTokens, cached }

const COMPLEXITY_KEYWORDS = {
  high: [
    "實作",
    "implement",
    "重構",
    "refactor",
    "設計",
    "design",
    "遷移",
    "migrate",
    "整合",
    "integrate",
    "架構",
    "architecture",
    "新增功能",
    "add feature",
    "建立模組",
    "create module",
    "debug",
    "除錯",
    "排查",
  ],
  medium: [
    "修復",
    "fix",
    "更新",
    "update",
    "修改",
    "change",
    "加",
    "add",
    "寫",
    "write",
    "建立",
    "create",
    "開發",
    "develop",
  ],
  low: [
    "你好",
    "hello",
    "hi",
    "嗨",
    "什麼是",
    "what is",
    "解釋",
    "explain",
    "查",
    "search",
    "看",
    "check",
    "狀態",
    "status",
    "幫我",
    "告訴我",
  ],
};

const TOKEN_ESTIMATES = {
  high: 2000,
  medium: 800,
  low: 300,
};

class IntentPolicy {
  evaluate(ctx) {
    const text = (ctx.userText || "").toLowerCase();
    const len = text.length;

    // Complexity scoring
    let complexity = 0.3; // default medium-low
    let level = "low";

    for (const kw of COMPLEXITY_KEYWORDS.high) {
      if (text.includes(kw)) {
        complexity = 0.85;
        level = "high";
        break;
      }
    }
    if (level === "low") {
      for (const kw of COMPLEXITY_KEYWORDS.medium) {
        if (text.includes(kw)) {
          complexity = 0.55;
          level = "medium";
          break;
        }
      }
    }

    // Length-based adjustment
    if (len > 200) {
      complexity = Math.min(1, complexity + 0.1);
    }
    if (len < 20) {
      complexity = Math.max(0, complexity - 0.1);
    }

    // Use intent hint from background classifier if available
    const hint = ctx.intentHint || null;

    return {
      intent: hint?.intent || "chat",
      confidence: hint?.confidence || 0,
      complexity,
      level,
      estimatedTokens: TOKEN_ESTIMATES[level] || 500,
      cached: !!hint?.cached,
      source: hint?.source || "none",
      authoritative: hint?.authoritative || false,
      method: hint?.method || "none",
    };
  }
}

module.exports = { IntentPolicy };
