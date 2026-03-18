import { describe, it, expect } from "vitest";
import {
  buildExecutionSignal,
  buildPreComputedVerdict,
  buildDynamicExecutionSignal,
} from "../src/signal-builder.ts";
import type { ExecutionIntent, MessageClassification } from "../src/types.ts";

// Helper: build an ExecutionIntent with sensible defaults
function makeIntent(overrides: Partial<ExecutionIntent> = {}): ExecutionIntent {
  return {
    input_finalized: true,
    execution_expected: true,
    execution_kind: "run",
    ...overrides,
  };
}

// Helper: build a MessageClassification with sensible defaults
function makeClassification(overrides: Partial<MessageClassification> = {}): MessageClassification {
  return {
    kind: "run",
    confidence: "high",
    input_finalized: true,
    execution_expected: true,
    suggested_tier: "premium",
    classifier_version: "2.0-weighted",
    score: 12,
    ...overrides,
  };
}

describe("buildExecutionSignal — early exits", () => {
  it("returns null when execution_expected is false", () => {
    const intent = makeIntent({ execution_expected: false });
    const result = buildExecutionSignal(intent);
    expect(result).toBeNull();
  });

  it("returns null when execution_kind is 'chat'", () => {
    const intent = makeIntent({ execution_kind: "chat" });
    const result = buildExecutionSignal(intent);
    expect(result).toBeNull();
  });

  it("returns null for MessageClassification with execution_expected false", () => {
    const mc = makeClassification({ execution_expected: false });
    const result = buildExecutionSignal(mc);
    expect(result).toBeNull();
  });

  it("returns null for MessageClassification with chat kind", () => {
    const mc = makeClassification({ kind: "chat" });
    const result = buildExecutionSignal(mc);
    expect(result).toBeNull();
  });
});

describe("buildExecutionSignal — XML output structure", () => {
  it("returns a non-null string for a normal intent", () => {
    const intent = makeIntent();
    const result = buildExecutionSignal(intent);
    expect(result).not.toBeNull();
    expect(typeof result === "string" && result.length > 0).toBe(true);
  });

  it("output starts with <message_classification> tag", () => {
    const result = buildExecutionSignal(makeIntent());
    expect(result!.startsWith("<message_classification>")).toBe(true);
  });

  it("output ends with </message_classification> tag", () => {
    const result = buildExecutionSignal(makeIntent());
    expect(result!.endsWith("</message_classification>")).toBe(true);
  });

  it("includes <kind> element with execution_kind value", () => {
    const intent = makeIntent({ execution_kind: "write" });
    const result = buildExecutionSignal(intent);
    expect(result!.includes("<kind>write</kind>")).toBe(true);
  });

  it("includes <input_finalized> element", () => {
    const intent = makeIntent({ input_finalized: true });
    const result = buildExecutionSignal(intent);
    expect(result!.includes("<input_finalized>true</input_finalized>")).toBe(true);
  });

  it("includes <execution_expected> element", () => {
    const intent = makeIntent({ execution_expected: true });
    const result = buildExecutionSignal(intent);
    expect(result!.includes("<execution_expected>true</execution_expected>")).toBe(true);
  });

  it("includes <classifier_version> element", () => {
    const result = buildExecutionSignal(makeIntent());
    expect(result!.includes("<classifier_version>2.0-weighted</classifier_version>")).toBe(true);
  });
});

describe("buildExecutionSignal — new MessageClassification fields", () => {
  it("includes <confidence> element for MessageClassification input", () => {
    const mc = makeClassification({ confidence: "high" });
    const result = buildExecutionSignal(mc);
    expect(result!.includes("<confidence>high</confidence>")).toBe(true);
  });

  it("includes <suggested_tier> element for MessageClassification input", () => {
    const mc = makeClassification({ suggested_tier: "premium" });
    const result = buildExecutionSignal(mc);
    expect(result!.includes("<suggested_tier>premium</suggested_tier>")).toBe(true);
  });

  it("includes <score> element for MessageClassification input", () => {
    const mc = makeClassification({ score: 15.5 });
    const result = buildExecutionSignal(mc);
    expect(result!.includes("<score>15.5</score>")).toBe(true);
  });

  it("includes all seven classification fields", () => {
    const mc = makeClassification({
      kind: "debug",
      confidence: "medium",
      suggested_tier: "premium",
      score: 8,
    });
    const result = buildExecutionSignal(mc);
    expect(result).not.toBeNull();
    expect(result!.includes("<kind>debug</kind>")).toBe(true);
    expect(result!.includes("<confidence>medium</confidence>")).toBe(true);
    expect(result!.includes("<input_finalized>true</input_finalized>")).toBe(true);
    expect(result!.includes("<execution_expected>true</execution_expected>")).toBe(true);
    expect(result!.includes("<suggested_tier>premium</suggested_tier>")).toBe(true);
    expect(result!.includes("<score>8</score>")).toBe(true);
    expect(result!.includes("<classifier_version>2.0-weighted</classifier_version>")).toBe(true);
  });
});

describe("buildPreComputedVerdict", () => {
  it("maps ExecutionIntent fields to PreComputedVerdict correctly", () => {
    const intent = makeIntent({ execution_kind: "debug" });
    const verdict = buildPreComputedVerdict(intent);
    expect(verdict.input_finalized).toBe(true);
    expect(verdict.execution_expected).toBe(true);
    expect(verdict.execution_kind).toBe("debug");
    expect(verdict.classifier_version).toBe("2.0-weighted");
  });

  it("returns classifier_version as '2.0-weighted'", () => {
    const verdict = buildPreComputedVerdict(makeIntent());
    expect(verdict.classifier_version).toBe("2.0-weighted");
  });

  it("does not include policy_required or delegation_preferred", () => {
    const verdict = buildPreComputedVerdict(makeIntent());
    expect("policy_required" in verdict).toBe(false);
    expect("delegation_preferred" in verdict).toBe(false);
  });
});

describe("buildExecutionSignal — all execution_kind values", () => {
  const kinds = [
    "search",
    "install",
    "read",
    "run",
    "write",
    "debug",
    "analyze",
    "unknown",
  ] as const;

  for (const kind of kinds) {
    it(`produces a valid signal for execution_kind='${kind}'`, () => {
      const intent = makeIntent({ execution_kind: kind });
      const result = buildExecutionSignal(intent);
      expect(result!.includes(`<kind>${kind}</kind>`)).toBe(true);
    });
  }
});

describe("buildDynamicExecutionSignal — locale support", () => {
  it("returns null when execution_expected is false", () => {
    const intent = makeIntent({ execution_expected: false });
    const result = buildDynamicExecutionSignal(intent, "zh-CN");
    expect(result).toBeNull();
  });

  it("returns null when execution_kind is chat", () => {
    const intent = makeIntent({ execution_kind: "chat" });
    const result = buildDynamicExecutionSignal(intent, "en");
    expect(result).toBeNull();
  });

  it("produces <message_classification> XML for a normal intent", () => {
    const intent = makeIntent();
    const result = buildDynamicExecutionSignal(intent, "zh-CN");
    expect(result !== null).toBe(true);
    expect(result!.includes("<message_classification>")).toBe(true);
    expect(result!.includes("</message_classification>")).toBe(true);
  });

  it("includes all classification fields for ExecutionIntent input", () => {
    const intent = makeIntent({ execution_kind: "debug" });
    const result = buildDynamicExecutionSignal(intent, "en");
    expect(result !== null).toBe(true);
    expect(result!.includes("<kind>debug</kind>")).toBe(true);
    expect(result!.includes("<input_finalized>true</input_finalized>")).toBe(true);
    expect(result!.includes("<execution_expected>true</execution_expected>")).toBe(true);
    expect(result!.includes("<classifier_version>2.0-weighted</classifier_version>")).toBe(true);
    // ExecutionIntent backward compat: also includes confidence/tier/score (via default conversion)
    expect(result!.includes("<confidence>")).toBe(true);
    expect(result!.includes("<suggested_tier>")).toBe(true);
    expect(result!.includes("<score>")).toBe(true);
  });

  it("includes all classification fields for MessageClassification input", () => {
    const mc = makeClassification({
      kind: "debug",
      confidence: "high",
      suggested_tier: "premium",
      score: 15,
    });
    const result = buildDynamicExecutionSignal(mc, "en");
    expect(result !== null).toBe(true);
    expect(result!.includes("<kind>debug</kind>")).toBe(true);
    expect(result!.includes("<confidence>high</confidence>")).toBe(true);
    expect(result!.includes("<suggested_tier>premium</suggested_tier>")).toBe(true);
    expect(result!.includes("<score>15</score>")).toBe(true);
  });
});

describe("buildExecutionSignal — locale passthrough", () => {
  it("en locale produces valid XML output", () => {
    const intent = makeIntent();
    const result = buildExecutionSignal(intent, "en");
    expect(result !== null).toBe(true);
    expect(result!.includes("<message_classification>")).toBe(true);
    expect(result!.includes("<kind>run</kind>")).toBe(true);
  });

  it("backward compatible — no locale arg defaults to zh-CN", () => {
    const intent = makeIntent();
    const result = buildExecutionSignal(intent);
    expect(result !== null).toBe(true);
    expect(result!.includes("<message_classification>")).toBe(true);
  });
});
