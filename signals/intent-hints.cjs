// Intent Signal Layer — raw signal extraction, no decisions
// Pure function: text → { intent, confidence, keywords_matched }
// Signal ≠ Policy: this extracts hints, policies decide routing

const INTENT_KEYWORDS = {
  stock: {
    keywords: [
      "台股",
      "股票",
      "股價",
      "技術分析",
      "K線",
      "均線",
      "RSI",
      "MACD",
      "買賣",
      "漲跌",
      "盤勢",
      "個股",
      "大盤",
      "加權指數",
      "stock",
      "ticker",
      "trading",
    ],
    // Stock symbol patterns: 2330, 00878, etc.
    patterns: [/\b\d{4,6}\b/],
    weight: 0.9,
  },
  code: {
    keywords: [
      "實作",
      "實現",
      "implement",
      "重構",
      "refactor",
      "寫",
      "開發",
      "develop",
      "修",
      "fix",
      "bug",
      "測試",
      "test",
      "write code",
      "寫程式",
      "function",
      "class",
      "module",
      "API",
      "endpoint",
      "build",
      "create",
      "add feature",
      "新增功能",
    ],
    weight: 0.85,
  },
  deploy: {
    keywords: [
      "部署",
      "deploy",
      "上線",
      "推送",
      "push",
      "restart",
      "重啟",
      "docker",
      "container",
      "服務",
      "production",
    ],
    weight: 0.9,
  },
  system_status: {
    keywords: [
      "系統狀態",
      "健康檢查",
      "system status",
      "health check",
      "/status",
      "/dashboard",
      "總覽",
      "proxy狀態",
      "伺服器狀態",
      "monitoring",
      "metrics",
    ],
    weight: 0.95,
  },
  gmail_delete: {
    keywords: [
      "刪除郵件",
      "刪郵件",
      "清理郵件",
      "delete email",
      "remove email",
      "clear inbox",
      "清收件匣",
    ],
    weight: 0.95,
  },
  gmail_read: {
    keywords: [
      "讀信",
      "查看郵件",
      "看信",
      "read email",
      "view email",
      "inbox",
      "收件匣",
      "郵件列表",
    ],
    weight: 0.9,
  },
  gmail_send: {
    keywords: ["寫信", "發送郵件", "寄信", "send email", "compose", "發信"],
    weight: 0.9,
  },
  calendar: {
    keywords: [
      "會議",
      "日程",
      "日期",
      "meeting",
      "calendar",
      "schedule",
      "行程",
      "排程",
      "約會",
      "event",
    ],
    weight: 0.85,
  },
  web_search: {
    keywords: [
      "搜索",
      "搜尋",
      "搜",
      "search",
      "look up",
      "查一下",
      "幫我查",
      "google",
      "find out",
      "最新",
      "latest",
    ],
    weight: 0.8,
  },
  summarize: {
    keywords: ["摘要", "總結", "summarize", "summary", "重點", "簡介", "概述"],
    weight: 0.85,
  },
  progress: {
    keywords: ["進度", "工作進度", "progress", "做了什麼", "今天做了", "work log", "工作記錄"],
    weight: 0.9,
  },
  chat: {
    keywords: ["你好", "嗨", "哈囉", "hi", "hello", "how are you", "怎樣"],
    weight: 0.6,
  },
};

/**
 * Extract intent hints from text using keyword matching.
 * Returns { intent, confidence, keywords_matched, source: "signal" }
 *
 * @param {string} text - User input text
 * @returns {{ intent: string, confidence: number, keywords_matched: string[], source: string }}
 */
function extractHints(text) {
  if (!text || typeof text !== "string") {
    return { intent: "chat", confidence: 0, keywords_matched: [], source: "signal" };
  }

  const lower = text.toLowerCase();
  let bestMatch = null;
  let bestScore = 0;

  for (const [intent, config] of Object.entries(INTENT_KEYWORDS)) {
    const matched = [];

    // Keyword matching
    for (const kw of config.keywords) {
      if (lower.includes(kw.toLowerCase())) {
        matched.push(kw);
      }
    }

    // Pattern matching (e.g. stock symbols)
    if (config.patterns) {
      for (const pat of config.patterns) {
        if (pat.test(text)) {
          matched.push("pattern:" + pat.source);
        }
      }
    }

    if (matched.length > 0) {
      // Score = base weight * match density (more matches = higher confidence)
      // Single match: 0.7 * weight; 2 matches: 0.85 * weight; 3+: 1.0 * weight
      const density = Math.min(1, matched.length / 2.5);
      const score = config.weight * (0.7 + 0.3 * density);

      if (score > bestScore) {
        bestScore = score;
        bestMatch = { intent, confidence: score, keywords_matched: matched };
      }
    }
  }

  if (bestMatch) {
    return { ...bestMatch, source: "signal" };
  }

  return { intent: "unknown", confidence: 0, keywords_matched: [], source: "signal" };
}

module.exports = { extractHints, INTENT_KEYWORDS };
