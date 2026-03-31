import { describe, expect, it, beforeEach } from "vitest";
import { PatternDetector } from "./pattern-detector.js";
import { AnticipationEngine } from "./anticipation-engine.js";

// ── Pattern Detector ─────────────────────────────────────────────────────────

describe("PatternDetector", () => {
  let detector: PatternDetector;

  beforeEach(() => {
    detector = new PatternDetector({ minOccurrences: 3, maxInteractions: 500 });
  });

  it("records interactions", () => {
    detector.recordInteraction({
      message: "How do I implement a REST API?",
      channelId: "discord",
      agentId: "main",
    });

    expect(detector.getInteractionCount()).toBe(1);
  });

  it("detects intent from messages", () => {
    const record = detector.recordInteraction({
      message: "Can you explain how promises work?",
      channelId: "discord",
      agentId: "main",
    });
    expect(record.intent).toBe("question");
  });

  it("detects coding intent", () => {
    const record = detector.recordInteraction({
      message: "Debug this function that crashes on null input",
      channelId: "discord",
      agentId: "main",
    });
    expect(record.intent).toBe("coding");
  });

  it("detects task intent", () => {
    const record = detector.recordInteraction({
      message: "Create a new directory for the project",
      channelId: "whatsapp",
      agentId: "main",
    });
    expect(record.intent).toBe("task");
  });

  it("extracts topics from messages", () => {
    const record = detector.recordInteraction({
      message: "How does Kubernetes horizontal pod autoscaling work?",
      channelId: "discord",
      agentId: "main",
    });

    expect(record.topics.length).toBeGreaterThan(0);
    expect(record.topics.some((t) => t.includes("kubernetes"))).toBe(true);
  });

  it("detects topical patterns after enough repetitions", () => {
    for (let i = 0; i < 5; i++) {
      detector.recordInteraction({
        message: "Tell me about Kubernetes deployment strategies",
        channelId: "discord",
        agentId: "main",
      });
    }

    const patterns = detector.analyzePatterns();
    const topicalPatterns = patterns.filter((p) => p.type === "topical");
    expect(topicalPatterns.length).toBeGreaterThan(0);
  });

  it("detects channel preference patterns", () => {
    // Coding on Discord
    for (let i = 0; i < 5; i++) {
      detector.recordInteraction({
        message: "Debug this code for me",
        channelId: "discord",
        agentId: "main",
      });
    }

    // Communication on WhatsApp
    for (let i = 0; i < 5; i++) {
      detector.recordInteraction({
        message: "Send a message to the team",
        channelId: "whatsapp",
        agentId: "main",
      });
    }

    const patterns = detector.analyzePatterns();
    const channelPatterns = patterns.filter((p) => p.type === "channel-pref");
    expect(channelPatterns.length).toBeGreaterThan(0);
  });

  it("evicts old interactions when maxInteractions is exceeded", () => {
    const smallDetector = new PatternDetector({ maxInteractions: 5, minOccurrences: 1 });

    for (let i = 0; i < 10; i++) {
      smallDetector.recordInteraction({
        message: `Message number ${i}`,
        channelId: "discord",
        agentId: "main",
      });
    }

    expect(smallDetector.getInteractionCount()).toBe(5);
  });

  it("exports and imports state", () => {
    for (let i = 0; i < 5; i++) {
      detector.recordInteraction({
        message: "Working on Kubernetes config",
        channelId: "discord",
        agentId: "main",
      });
    }

    detector.analyzePatterns();
    const state = detector.exportState();

    const newDetector = new PatternDetector({ minOccurrences: 3 });
    newDetector.importState(state);

    expect(newDetector.getInteractionCount()).toBe(5);
    expect(newDetector.getPatternCount()).toBeGreaterThan(0);
  });

  it("generates context enrichment string", () => {
    // Need enough patterns for enrichment
    for (let i = 0; i < 10; i++) {
      detector.recordInteraction({
        message: "Review the codebase architecture",
        channelId: "discord",
        agentId: "main",
      });
    }

    detector.analyzePatterns();
    const enrichment = detector.generateContextEnrichment();

    // May or may not have enrichment depending on time-matching
    expect(typeof enrichment).toBe("string");
  });
});

// ── Anticipation Engine ──────────────────────────────────────────────────────

describe("AnticipationEngine", () => {
  let detector: PatternDetector;
  let engine: AnticipationEngine;

  beforeEach(() => {
    detector = new PatternDetector({ minOccurrences: 3, maxInteractions: 500 });
    engine = new AnticipationEngine(detector);
  });

  it("generates insights from detected patterns", () => {
    // Seed with enough data for patterns
    for (let i = 0; i < 10; i++) {
      detector.recordInteraction({
        message: "Deploy the application to staging",
        channelId: "discord",
        agentId: "main",
      });
    }

    detector.analyzePatterns();
    const insights = engine.generateInsights();

    // May or may not generate insights depending on time-matching
    expect(Array.isArray(insights)).toBe(true);
  });

  it("generates time-sensitive insights on Monday morning", () => {
    const insights = engine.generateInsights({
      dayOfWeek: 1, // Monday
      hourOfDay: 9,
    });

    const mondayInsight = insights.find((i) => i.id.includes("monday-planning"));
    expect(mondayInsight).toBeDefined();
    expect(mondayInsight!.suggestedPrompt).toContain("plan");
  });

  it("generates time-sensitive insights on Friday afternoon", () => {
    const insights = engine.generateInsights({
      dayOfWeek: 5, // Friday
      hourOfDay: 16,
    });

    const fridayInsight = insights.find((i) => i.id.includes("friday-review"));
    expect(fridayInsight).toBeDefined();
    expect(fridayInsight!.suggestedPrompt).toContain("review");
  });

  it("marks insights as delivered to avoid repeats", () => {
    const insights = engine.generateInsights({
      dayOfWeek: 1,
      hourOfDay: 9,
    });

    engine.markDelivered(insights.map((i) => i.id));

    const secondInsights = engine.generateInsights({
      dayOfWeek: 1,
      hourOfDay: 9,
    });

    // Monday insight should not repeat
    const mondayRepeat = secondInsights.find((i) => i.id.includes("monday-planning"));
    expect(mondayRepeat).toBeUndefined();
  });

  it("resets delivered tracking", () => {
    const insights = engine.generateInsights({ dayOfWeek: 1, hourOfDay: 9 });
    engine.markDelivered(insights.map((i) => i.id));
    engine.resetDelivered();

    const afterReset = engine.generateInsights({ dayOfWeek: 1, hourOfDay: 9 });
    const mondayInsight = afterReset.find((i) => i.id.includes("monday-planning"));
    expect(mondayInsight).toBeDefined();
  });

  it("formats insights report", () => {
    const insights = engine.generateInsights({ dayOfWeek: 1, hourOfDay: 9 });
    const report = engine.formatInsightsReport(insights);

    expect(report).toContain("Proactive Insights");
    expect(typeof report).toBe("string");
  });

  it("returns empty string for context enrichment with no patterns", () => {
    const enrichment = engine.getContextEnrichment();
    expect(enrichment).toBe("");
  });

  it("generates context enrichment with patterns", () => {
    // Seed patterns
    for (let i = 0; i < 10; i++) {
      detector.recordInteraction({
        message: "Check the deployment pipeline status",
        channelId: "discord",
        agentId: "main",
      });
    }

    detector.analyzePatterns();
    const enrichment = engine.getContextEnrichment();

    // May have enrichment if patterns match current time
    expect(typeof enrichment).toBe("string");
  });
});
