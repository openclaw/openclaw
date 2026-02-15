/**
 * Topic Auto-Tagging
 *
 * Extracts topic tags from message content using rule-based matching.
 * Supports both Chinese and English keywords.
 * No external NLP dependencies.
 */

export type TopicTag = string;

/**
 * Topic definitions with keywords for matching.
 * Each topic has a list of keywords/patterns that trigger it.
 */
const TOPIC_DEFINITIONS: Record<TopicTag, string[]> = {
  // Technology
  programming: [
    "code",
    "coding",
    "programming",
    "developer",
    "software",
    "function",
    "variable",
    "编程",
    "代码",
    "程序",
    "开发",
    "软件",
    "函数",
    "变量",
    "typescript",
    "javascript",
    "python",
    "rust",
    "golang",
    "java",
    "react",
    "vue",
    "node",
  ],
  api: ["api", "endpoint", "rest", "graphql", "webhook", "接口", "请求", "响应"],
  database: ["database", "sql", "mongodb", "postgres", "mysql", "redis", "数据库", "查询"],
  ai: [
    "ai",
    "machine learning",
    "ml",
    "llm",
    "gpt",
    "claude",
    "model",
    "embedding",
    "人工智能",
    "机器学习",
    "模型",
    "神经网络",
    "深度学习",
  ],

  // Business
  finance: [
    "money",
    "payment",
    "invoice",
    "budget",
    "expense",
    "revenue",
    "profit",
    "钱",
    "支付",
    "发票",
    "预算",
    "费用",
    "收入",
    "利润",
    "stock",
    "股票",
    "基金",
    "投资",
    "理财",
  ],
  project: [
    "project",
    "task",
    "milestone",
    "deadline",
    "sprint",
    "kanban",
    "项目",
    "任务",
    "里程碑",
    "截止",
    "进度",
  ],

  // Personal
  schedule: [
    "meeting",
    "calendar",
    "appointment",
    "schedule",
    "reminder",
    "会议",
    "日历",
    "预约",
    "日程",
    "提醒",
  ],
  travel: [
    "flight",
    "hotel",
    "trip",
    "travel",
    "vacation",
    "booking",
    "航班",
    "酒店",
    "旅行",
    "旅游",
    "度假",
    "预订",
  ],
  health: [
    "health",
    "doctor",
    "medicine",
    "exercise",
    "sleep",
    "diet",
    "健康",
    "医生",
    "药",
    "运动",
    "睡眠",
    "饮食",
  ],

  // Communication
  email: [
    "email",
    "mail",
    "inbox",
    "send",
    "reply",
    "forward",
    "邮件",
    "收件箱",
    "发送",
    "回复",
    "转发",
  ],
  chat: [
    "message",
    "chat",
    "conversation",
    "discord",
    "slack",
    "telegram",
    "wechat",
    "消息",
    "聊天",
    "对话",
    "微信",
    "飞书",
  ],

  // Settings/Config
  settings: [
    "setting",
    "config",
    "preference",
    "theme",
    "dark mode",
    "light mode",
    "设置",
    "配置",
    "偏好",
    "主题",
    "深色",
    "浅色",
  ],
};

/**
 * Compile topic patterns for efficient matching.
 */
const COMPILED_PATTERNS: Array<{ topic: TopicTag; patterns: RegExp[] }> = [];

for (const [topic, keywords] of Object.entries(TOPIC_DEFINITIONS)) {
  const patterns = keywords.map((kw) => {
    // Escape special regex characters
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // For CJK characters, match anywhere (no word boundary needed)
    // For ASCII, match with word-boundary-like context
    const isCJK = /[\u4e00-\u9fff]/.test(kw);
    if (isCJK) {
      return new RegExp(escaped, "iu");
    }
    return new RegExp(`(?:^|[\\s\\p{P}])${escaped}(?:[\\s\\p{P}]|$)`, "iu");
  });
  COMPILED_PATTERNS.push({ topic, patterns });
}

/**
 * Extract topic tags from text content.
 *
 * @param text - Input text to analyze
 * @returns Array of detected topic tags (deduplicated)
 */
export function extractTopics(text: string): TopicTag[] {
  if (!text || typeof text !== "string") {
    return [];
  }

  const normalized = text.toLowerCase();
  const detected = new Set<TopicTag>();

  for (const { topic, patterns } of COMPILED_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(normalized)) {
        detected.add(topic);
        break; // One match is enough for this topic
      }
    }
  }

  return Array.from(detected);
}

/**
 * Check if text matches a specific topic.
 */
export function matchesTopic(text: string, topic: TopicTag): boolean {
  const entry = COMPILED_PATTERNS.find((p) => p.topic === topic);
  if (!entry) {
    return false;
  }

  const normalized = text.toLowerCase();
  return entry.patterns.some((pattern) => pattern.test(normalized));
}

/**
 * Filter segments by topics.
 */
export function filterByTopics<T extends { metadata?: { topics?: string[] } }>(
  segments: T[],
  topics: TopicTag[],
): T[] {
  if (!topics || topics.length === 0) {
    return segments;
  }

  const topicSet = new Set(topics.map((t) => t.toLowerCase()));

  return segments.filter((seg) => {
    const segTopics = seg.metadata?.topics ?? [];
    return segTopics.some((t) => topicSet.has(t.toLowerCase()));
  });
}

/**
 * Get all available topic tags.
 */
export function getAvailableTopics(): TopicTag[] {
  return Object.keys(TOPIC_DEFINITIONS);
}

/**
 * Add custom topic definition at runtime.
 * Useful for domain-specific topics.
 */
export function addTopicDefinition(topic: TopicTag, keywords: string[]): void {
  if (TOPIC_DEFINITIONS[topic]) {
    // Merge with existing
    const existing = new Set(TOPIC_DEFINITIONS[topic]);
    for (const kw of keywords) {
      existing.add(kw);
    }
    TOPIC_DEFINITIONS[topic] = Array.from(existing);
  } else {
    TOPIC_DEFINITIONS[topic] = keywords;
  }

  // Recompile patterns
  const patterns = TOPIC_DEFINITIONS[topic].map((kw) => {
    const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isCJK = /[\u4e00-\u9fff]/.test(kw);
    if (isCJK) {
      return new RegExp(escaped, "iu");
    }
    return new RegExp(`(?:^|[\\s\\p{P}])${escaped}(?:[\\s\\p{P}]|$)`, "iu");
  });

  const existing = COMPILED_PATTERNS.find((p) => p.topic === topic);
  if (existing) {
    existing.patterns = patterns;
  } else {
    COMPILED_PATTERNS.push({ topic, patterns });
  }
}
