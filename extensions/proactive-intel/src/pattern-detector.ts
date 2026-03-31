/**
 * Interaction pattern detector and learner.
 *
 * Analyzes user interaction patterns across time dimensions:
 *   - Time-of-day patterns (when does the user ask for things?)
 *   - Day-of-week patterns (Monday standup prep, Friday reviews)
 *   - Topic recurrence (same questions repeatedly)
 *   - Workflow sequences (task A always followed by task B)
 *   - Channel preferences (which channel for which task type)
 */

export type InteractionRecord = {
  timestamp: number;
  dayOfWeek: number; // 0-6 (Sunday-Saturday)
  hourOfDay: number; // 0-23
  channelId: string;
  agentId: string;
  messageLength: number;
  /** Extracted topic keywords (lowercase, deduplicated) */
  topics: string[];
  /** Detected intent category */
  intent: IntentCategory;
};

export type IntentCategory =
  | "question"
  | "task"
  | "review"
  | "creative"
  | "coding"
  | "communication"
  | "scheduling"
  | "research"
  | "monitoring"
  | "other";

export type DetectedPattern = {
  id: string;
  type: PatternType;
  confidence: number; // 0-100
  occurrences: number;
  description: string;
  /** When this pattern typically fires */
  trigger: PatternTrigger;
  /** Suggested proactive action */
  suggestedAction: string;
  lastSeen: number;
  firstSeen: number;
};

export type PatternType =
  | "temporal"       // Same time/day recurring behavior
  | "sequential"     // Task A → Task B workflow
  | "topical"        // Recurring topic/question
  | "channel-pref"   // Preferred channel for task types
  | "routine";       // Composite daily/weekly routine

export type PatternTrigger = {
  dayOfWeek?: number[];  // Days when pattern fires (0-6)
  hourRange?: [number, number]; // Hour range [start, end)
  precedingIntent?: IntentCategory; // Fires after this intent
  minOccurrences: number;
};

// ── Intent Detection ─────────────────────────────────────────────────────────

const INTENT_PATTERNS: Array<{ pattern: RegExp; intent: IntentCategory }> = [
  { pattern: /\b(what|how|why|when|where|who|can you explain|tell me)\b/i, intent: "question" },
  { pattern: /\b(do|make|create|build|implement|add|fix|update|delete|remove)\b/i, intent: "task" },
  { pattern: /\b(review|check|verify|test|validate|audit|inspect)\b/i, intent: "review" },
  { pattern: /\b(write|draft|compose|design|brainstorm|ideate)\b/i, intent: "creative" },
  { pattern: /\b(code|function|class|module|debug|refactor|deploy|commit|push|merge|pr)\b/i, intent: "coding" },
  { pattern: /\b(send|email|message|notify|reply|forward|post|tweet)\b/i, intent: "communication" },
  { pattern: /\b(schedule|meeting|calendar|reminder|appointment|deadline)\b/i, intent: "scheduling" },
  { pattern: /\b(research|find|search|look up|investigate|analyze|compare)\b/i, intent: "research" },
  { pattern: /\b(monitor|status|health|uptime|check on|watch)\b/i, intent: "monitoring" },
];

// ── Topic Extraction ─────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "must", "to", "of", "in",
  "for", "on", "with", "at", "by", "from", "as", "into", "about", "like",
  "through", "after", "over", "between", "out", "against", "during",
  "without", "before", "under", "around", "among", "it", "this", "that",
  "these", "those", "my", "your", "his", "her", "its", "our", "their",
  "i", "me", "you", "he", "she", "we", "they", "and", "but", "or",
  "not", "no", "so", "if", "then", "else", "just", "also", "please",
  "thanks", "thank", "hi", "hello", "hey", "ok", "okay", "yes",
]);

function extractTopics(message: string): string[] {
  const words = message
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate and take top 5
  return [...new Set(words)].slice(0, 5);
}

function detectIntent(message: string): IntentCategory {
  for (const { pattern, intent } of INTENT_PATTERNS) {
    if (pattern.test(message)) {
      return intent;
    }
  }
  return "other";
}

// ── Pattern Detector ─────────────────────────────────────────────────────────

export class PatternDetector {
  private interactions: InteractionRecord[] = [];
  private patterns: Map<string, DetectedPattern> = new Map();
  private maxInteractions: number;
  private maxPatterns: number;
  private minOccurrences: number;

  constructor(options?: {
    maxInteractions?: number;
    maxPatterns?: number;
    minOccurrences?: number;
  }) {
    this.maxInteractions = options?.maxInteractions ?? 500;
    this.maxPatterns = options?.maxPatterns ?? 100;
    this.minOccurrences = options?.minOccurrences ?? 5;
  }

  /**
   * Record a new user interaction for pattern analysis.
   */
  recordInteraction(params: {
    message: string;
    channelId: string;
    agentId: string;
  }): InteractionRecord {
    const now = new Date();
    const record: InteractionRecord = {
      timestamp: Date.now(),
      dayOfWeek: now.getDay(),
      hourOfDay: now.getHours(),
      channelId: params.channelId,
      agentId: params.agentId,
      messageLength: params.message.length,
      topics: extractTopics(params.message),
      intent: detectIntent(params.message),
    };

    this.interactions.push(record);

    // Evict oldest if full
    if (this.interactions.length > this.maxInteractions) {
      this.interactions = this.interactions.slice(-this.maxInteractions);
    }

    return record;
  }

  /**
   * Analyze recorded interactions and detect patterns.
   * Call periodically (e.g., during heartbeat or daily cron).
   */
  analyzePatterns(): DetectedPattern[] {
    const newPatterns: DetectedPattern[] = [];

    newPatterns.push(...this.detectTemporalPatterns());
    newPatterns.push(...this.detectTopicalPatterns());
    newPatterns.push(...this.detectChannelPreferences());
    newPatterns.push(...this.detectRoutines());

    // Merge with existing patterns
    for (const pattern of newPatterns) {
      const existing = this.patterns.get(pattern.id);
      if (existing) {
        existing.confidence = Math.max(existing.confidence, pattern.confidence);
        existing.occurrences = pattern.occurrences;
        existing.lastSeen = pattern.lastSeen;
      } else if (this.patterns.size < this.maxPatterns) {
        this.patterns.set(pattern.id, pattern);
      }
    }

    return [...this.patterns.values()].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get patterns relevant to the current context (time, day, channel).
   */
  getRelevantPatterns(context?: {
    dayOfWeek?: number;
    hourOfDay?: number;
    channelId?: string;
  }): DetectedPattern[] {
    const now = new Date();
    const day = context?.dayOfWeek ?? now.getDay();
    const hour = context?.hourOfDay ?? now.getHours();

    return [...this.patterns.values()].filter((pattern) => {
      const trigger = pattern.trigger;

      if (trigger.dayOfWeek && !trigger.dayOfWeek.includes(day)) {
        return false;
      }

      if (trigger.hourRange) {
        const [start, end] = trigger.hourRange;
        if (hour < start || hour >= end) {
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Generate a proactive context enrichment string for the system prompt.
   */
  generateContextEnrichment(): string {
    const relevant = this.getRelevantPatterns();
    if (relevant.length === 0) {
      return "";
    }

    const lines = ["## Proactive Context (learned patterns)"];
    lines.push("");

    const top = relevant.slice(0, 5);
    for (const pattern of top) {
      lines.push(`- **${pattern.description}** (confidence: ${pattern.confidence}%)`);
      lines.push(`  Suggested: ${pattern.suggestedAction}`);
    }

    return lines.join("\n");
  }

  /**
   * Export state for persistence.
   */
  exportState(): {
    interactions: InteractionRecord[];
    patterns: DetectedPattern[];
  } {
    return {
      interactions: [...this.interactions],
      patterns: [...this.patterns.values()],
    };
  }

  /**
   * Import previously persisted state.
   */
  importState(state: {
    interactions?: InteractionRecord[];
    patterns?: DetectedPattern[];
  }): void {
    if (state.interactions) {
      this.interactions.push(...state.interactions);
      if (this.interactions.length > this.maxInteractions) {
        this.interactions = this.interactions.slice(-this.maxInteractions);
      }
    }
    if (state.patterns) {
      for (const pattern of state.patterns) {
        this.patterns.set(pattern.id, pattern);
      }
    }
  }

  getInteractionCount(): number {
    return this.interactions.length;
  }

  getPatternCount(): number {
    return this.patterns.size;
  }

  // ── Private Pattern Detection Methods ────────────────────────────────────

  private detectTemporalPatterns(): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const dayHourBuckets = new Map<string, InteractionRecord[]>();

    for (const record of this.interactions) {
      const key = `${record.dayOfWeek}:${record.hourOfDay}`;
      const bucket = dayHourBuckets.get(key) ?? [];
      bucket.push(record);
      dayHourBuckets.set(key, bucket);
    }

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

    for (const [key, records] of dayHourBuckets) {
      if (records.length < this.minOccurrences) {
        continue;
      }

      const [dayStr, hourStr] = key.split(":");
      const day = Number(dayStr);
      const hour = Number(hourStr);
      const confidence = Math.min(95, Math.round((records.length / this.interactions.length) * 500));

      // Find dominant intent in this time slot
      const intentCounts = new Map<IntentCategory, number>();
      for (const r of records) {
        intentCounts.set(r.intent, (intentCounts.get(r.intent) ?? 0) + 1);
      }
      const dominantIntent = [...intentCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";

      const hourLabel = hour < 12 ? `${hour}AM` : hour === 12 ? "12PM" : `${hour - 12}PM`;

      patterns.push({
        id: `temporal:${key}`,
        type: "temporal",
        confidence,
        occurrences: records.length,
        description: `You typically use ${dominantIntent} around ${hourLabel} on ${dayNames[day]}s`,
        trigger: {
          dayOfWeek: [day],
          hourRange: [hour, hour + 1],
          minOccurrences: this.minOccurrences,
        },
        suggestedAction: `Prepare ${dominantIntent}-related context proactively`,
        lastSeen: Math.max(...records.map((r) => r.timestamp)),
        firstSeen: Math.min(...records.map((r) => r.timestamp)),
      });
    }

    return patterns;
  }

  private detectTopicalPatterns(): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const topicCounts = new Map<string, { count: number; first: number; last: number }>();

    for (const record of this.interactions) {
      for (const topic of record.topics) {
        const existing = topicCounts.get(topic) ?? { count: 0, first: record.timestamp, last: record.timestamp };
        existing.count += 1;
        existing.last = Math.max(existing.last, record.timestamp);
        topicCounts.set(topic, existing);
      }
    }

    for (const [topic, data] of topicCounts) {
      if (data.count < this.minOccurrences) {
        continue;
      }

      const confidence = Math.min(90, Math.round((data.count / this.interactions.length) * 300));

      patterns.push({
        id: `topical:${topic}`,
        type: "topical",
        confidence,
        occurrences: data.count,
        description: `"${topic}" is a recurring topic (${data.count} mentions)`,
        trigger: { minOccurrences: this.minOccurrences },
        suggestedAction: `Keep context about "${topic}" readily available`,
        lastSeen: data.last,
        firstSeen: data.first,
      });
    }

    return patterns.sort((a, b) => b.occurrences - a.occurrences).slice(0, 20);
  }

  private detectChannelPreferences(): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];
    const channelIntentMap = new Map<string, Map<IntentCategory, InteractionRecord[]>>();

    for (const record of this.interactions) {
      const channelMap = channelIntentMap.get(record.channelId) ?? new Map();
      const records = channelMap.get(record.intent) ?? [];
      records.push(record);
      channelMap.set(record.intent, records);
      channelIntentMap.set(record.channelId, channelMap);
    }

    for (const [channel, intentMap] of channelIntentMap) {
      const sorted = [...intentMap.entries()].sort((a, b) => b[1].length - a[1].length);
      const top = sorted[0];
      if (!top || top[1].length < this.minOccurrences) {
        continue;
      }

      const topIntent = top[0];
      const records = top[1];
      const occurrences = records.length;

      const totalForChannel = [...intentMap.values()].reduce((a, b) => a + b.length, 0);
      const dominance = (occurrences / totalForChannel) * 100;

      if (dominance < 40) {
        continue; // Not dominant enough
      }

      patterns.push({
        id: `channel-pref:${channel}:${topIntent}`,
        type: "channel-pref",
        confidence: Math.min(85, Math.round(dominance)),
        occurrences: occurrences,
        description: `You prefer ${channel} for ${topIntent} tasks (${Math.round(dominance)}% of ${channel} usage)`,
        trigger: { minOccurrences: this.minOccurrences },
        suggestedAction: `Route ${topIntent}-related proactive messages to ${channel}`,
        lastSeen: Math.max(...records.map((r) => r.timestamp)),
        firstSeen: Math.min(...records.map((r) => r.timestamp)),
      });
    }

    return patterns;
  }

  private detectRoutines(): DetectedPattern[] {
    const patterns: DetectedPattern[] = [];

    // Detect morning/evening routines by looking for clustered activity
    const morningActivity = this.interactions.filter((r) => r.hourOfDay >= 7 && r.hourOfDay <= 10);
    const eveningActivity = this.interactions.filter((r) => r.hourOfDay >= 17 && r.hourOfDay <= 21);

    if (morningActivity.length >= this.minOccurrences * 2) {
      const morningIntents = new Map<IntentCategory, number>();
      for (const r of morningActivity) {
        morningIntents.set(r.intent, (morningIntents.get(r.intent) ?? 0) + 1);
      }
      const topIntents = [...morningIntents.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([intent]) => intent);

      patterns.push({
        id: "routine:morning",
        type: "routine",
        confidence: Math.min(80, Math.round((morningActivity.length / this.interactions.length) * 200)),
        occurrences: morningActivity.length,
        description: `Your morning routine typically involves: ${topIntents.join(", ")}`,
        trigger: {
          hourRange: [7, 10],
          minOccurrences: this.minOccurrences * 2,
        },
        suggestedAction: `Prepare morning briefing with ${topIntents[0]} focus`,
        lastSeen: Math.max(...morningActivity.map((r) => r.timestamp)),
        firstSeen: Math.min(...morningActivity.map((r) => r.timestamp)),
      });
    }

    if (eveningActivity.length >= this.minOccurrences * 2) {
      const eveningIntents = new Map<IntentCategory, number>();
      for (const r of eveningActivity) {
        eveningIntents.set(r.intent, (eveningIntents.get(r.intent) ?? 0) + 1);
      }
      const topIntents = [...eveningIntents.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([intent]) => intent);

      patterns.push({
        id: "routine:evening",
        type: "routine",
        confidence: Math.min(80, Math.round((eveningActivity.length / this.interactions.length) * 200)),
        occurrences: eveningActivity.length,
        description: `Your evening routine typically involves: ${topIntents.join(", ")}`,
        trigger: {
          hourRange: [17, 21],
          minOccurrences: this.minOccurrences * 2,
        },
        suggestedAction: `Prepare evening summary with ${topIntents[0]} focus`,
        lastSeen: Math.max(...eveningActivity.map((r) => r.timestamp)),
        firstSeen: Math.min(...eveningActivity.map((r) => r.timestamp)),
      });
    }

    return patterns;
  }
}
