import { describe, it, expect } from "vitest";
import {
  stripCodeAndQuotes,
  positionMultiplier,
  scoreMessage,
  resolveTie,
  isIncomplete,
  isComplete,
  classifyExecutionIntent,
  classifyMessage,
  toMessageClassification,
} from "../src/classifier.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import type { ScoredResult, ExecutionIntent } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 1. stripCodeAndQuotes
// ---------------------------------------------------------------------------
describe("stripCodeAndQuotes", () => {
  it("removes a fenced code block and leaves surrounding text", () => {
    const input = "prefix\n```bash\nnpm install\n```\nsuffix";
    const result = stripCodeAndQuotes(input);
    expect(result.includes("npm install")).toBe(false);
    expect(result.includes("prefix")).toBe(true);
    expect(result.includes("suffix")).toBe(true);
  });

  it("removes a fenced code block with language tag entirely", () => {
    const input = "```js\nconst x = 1;\n```";
    expect(stripCodeAndQuotes(input)).toBe("");
  });

  it("removes inline code spans", () => {
    const result = stripCodeAndQuotes("hello `code snippet` world");
    expect(result.includes("code snippet")).toBe(false);
    expect(result.includes("hello")).toBe(true);
    expect(result.includes("world")).toBe(true);
  });

  it("removes blockquote lines starting with >", () => {
    const result = stripCodeAndQuotes("> quoted line\nnormal text");
    expect(result.includes("quoted line")).toBe(false);
    expect(result.includes("normal text")).toBe(true);
  });

  it("handles mixed content — code block, inline code, blockquote, and body text", () => {
    const input = "text\n```js\nconst x = 1\n```\n> quote line\nmore text";
    const result = stripCodeAndQuotes(input);
    expect(result.includes("const x")).toBe(false);
    expect(result.includes("quote line")).toBe(false);
    expect(result.includes("text")).toBe(true);
    expect(result.includes("more text")).toBe(true);
  });

  it("returns empty string for an empty input", () => {
    expect(stripCodeAndQuotes("")).toBe("");
  });

  it("returns the original message unchanged when there is no code or quotes", () => {
    const plain = "this is a plain message";
    expect(stripCodeAndQuotes(plain)).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// 2. positionMultiplier
// ---------------------------------------------------------------------------
describe("positionMultiplier", () => {
  it("returns 1.5 when match index is in the front 30% of the message", () => {
    expect(positionMultiplier(0, 100)).toBe(1.5);
    expect(positionMultiplier(20, 100)).toBe(1.5);
  });

  it("returns 1.0 when match index is in the middle 40% of the message", () => {
    // ratio 0.3 is exactly at the boundary — not < 0.3, not > 0.7, so 1.0
    expect(positionMultiplier(30, 100)).toBe(1.0);
    expect(positionMultiplier(50, 100)).toBe(1.0);
  });

  it("returns 0.8 when match index is in the back 30% of the message", () => {
    // ratio 0.71 > 0.7 -> 0.8
    expect(positionMultiplier(71, 100)).toBe(0.8);
    expect(positionMultiplier(90, 100)).toBe(0.8);
  });

  it("returns 1.0 for an empty message (length 0) to avoid division by zero", () => {
    expect(positionMultiplier(0, 0)).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// 3. scoreMessage
// ---------------------------------------------------------------------------
describe("scoreMessage", () => {
  it("assigns a higher score to a kind whose keyword has greater weight", () => {
    // "grep" has weight 9 in search; "find" has weight 6 — same position bonus
    const withGrep = scoreMessage("grep foo", "grep foo");
    const withFind = scoreMessage("find foo", "find foo");
    const grepSearch = withGrep.find((r) => r.kind === "search")!;
    const findSearch = withFind.find((r) => r.kind === "search")!;
    expect(grepSearch.score > findSearch.score).toBe(true);
  });

  it("returns results sorted from highest to lowest score", () => {
    const results = scoreMessage("debug this error", "debug this error");
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score >= results[i].score).toBe(true);
    }
  });

  it("applies a position multiplier so keywords near the front score higher than at the back", () => {
    const front = scoreMessage("debug issue", "debug issue");
    const back = scoreMessage("issue debug", "issue debug");
    const frontDebug = front.find((r) => r.kind === "debug")!;
    const backDebug = back.find((r) => r.kind === "debug")!;
    expect(frontDebug.score > backDebug.score).toBe(true);
  });

  it("adds a context bonus when the test condition is satisfied", () => {
    // read kind has a file-path bonus for .ts extension
    const withPath = scoreMessage("查看 config.ts", "查看 config.ts");
    const withoutPath = scoreMessage("查看 something", "查看 something");
    const scoreWith = withPath.find((r) => r.kind === "read")!;
    const scoreWithout = withoutPath.find((r) => r.kind === "read")!;
    expect(scoreWith.score > scoreWithout.score).toBe(true);
  });

  it("returns 0 for non-chat kinds when the message contains no matching keywords", () => {
    // "xyz" has no technical keywords; only chat gets context bonuses
    const results = scoreMessage("xyz", "xyz");
    const nonChatZero = results.filter((r) => r.kind !== "chat");
    for (const r of nonChatZero) {
      expect(r.score).toBe(0);
    }
  });

  it("does not apply context bonuses when no keyword matched (keyword-hit guard)", () => {
    // "rm" is short (<15 chars) and has no tech terms, so chat context bonuses
    // (short-message +5, no-tech-terms +3) would fire — but no chat keyword matched,
    // so totalScore must remain 0 for chat.
    const results = scoreMessage("rm", "rm");
    const chatResult = results.find((r) => r.kind === "chat")!;
    expect(chatResult.score).toBe(0);
  });

  it("breakdown array records the contributing terms and their contributions", () => {
    const results = scoreMessage("debug", "debug");
    const debugResult = results.find((r) => r.kind === "debug")!;
    expect(debugResult.breakdown.length > 0).toBe(true);
    expect(debugResult.breakdown.some((b) => b.term === "debug")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. resolveTie
// ---------------------------------------------------------------------------
describe("resolveTie", () => {
  it("returns the single candidate when the array has exactly one element", () => {
    const candidates: ScoredResult[] = [{ kind: "search", score: 5, breakdown: [] }];
    expect(resolveTie(candidates).kind).toBe("search");
  });

  it("returns unknown with score 0 when the array is empty", () => {
    const result = resolveTie([]);
    expect(result.kind).toBe("unknown");
    expect(result.score).toBe(0);
  });

  it("returns the clear winner when candidates are already sorted and scores differ", () => {
    // resolveTie expects highest score first (as returned by scoreMessage)
    const candidates: ScoredResult[] = [
      { kind: "debug", score: 7, breakdown: [] },
      { kind: "search", score: 3, breakdown: [] },
    ];
    expect(resolveTie(candidates).kind).toBe("debug");
  });

  it("breaks a tie using TIE_BREAK_PRIORITY — debug beats search when both have equal score", () => {
    // TIE_BREAK_PRIORITY: ["debug","install","run","write","search","read","analyze","chat"]
    const candidates: ScoredResult[] = [
      { kind: "search", score: 5, breakdown: [] },
      { kind: "debug", score: 5, breakdown: [] },
    ];
    expect(resolveTie(candidates).kind).toBe("debug");
  });

  it("breaks a tie picking the earliest priority when multiple kinds share the same score", () => {
    // run (index 2) beats write (index 3) in TIE_BREAK_PRIORITY
    const candidates: ScoredResult[] = [
      { kind: "write", score: 5, breakdown: [] },
      { kind: "run", score: 5, breakdown: [] },
    ];
    expect(resolveTie(candidates).kind).toBe("run");
  });
});

// ---------------------------------------------------------------------------
// 5. isIncomplete / isComplete
// ---------------------------------------------------------------------------
describe("isIncomplete", () => {
  it("returns true when the message ends with the '...' incomplete signal", () => {
    expect(isIncomplete("待续...", DEFAULT_CONFIG)).toBe(true);
  });

  it("returns true when the message ends with the '，' (fullwidth comma) incomplete signal", () => {
    expect(isIncomplete("继续，", DEFAULT_CONFIG)).toBe(true);
  });

  it("returns true when the message is shorter than minMessageLength", () => {
    // DEFAULT_CONFIG.minMessageLength === 3; "ab" has length 2
    expect(isIncomplete("ab", DEFAULT_CONFIG)).toBe(true);
  });

  it("returns false for a normal message that does not end with an incomplete signal", () => {
    expect(isIncomplete("这是一条完整的消息", DEFAULT_CONFIG)).toBe(false);
  });
});

describe("isComplete", () => {
  it("returns true when the message ends with '。' (Chinese period)", () => {
    expect(isComplete("完成了。", DEFAULT_CONFIG)).toBe(true);
  });

  it("returns true when the message ends with '?' (ASCII question mark)", () => {
    expect(isComplete("done?", DEFAULT_CONFIG)).toBe(true);
  });

  it("returns true when the message ends with '！' (fullwidth exclamation mark)", () => {
    expect(isComplete("执行！", DEFAULT_CONFIG)).toBe(true);
  });

  it("returns false for a message that does not end with any complete signal", () => {
    expect(isComplete("mid sentence", DEFAULT_CONFIG)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. classifyExecutionIntent — integration tests using DEFAULT_CONFIG
// ---------------------------------------------------------------------------
describe("classifyExecutionIntent", () => {
  it("classifies '帮我找一下这个 bug？' as debug, not search", () => {
    const result = classifyExecutionIntent("帮我找一下这个 bug？", DEFAULT_CONFIG);
    expect(result.execution_kind).toBe("debug");
  });

  it("classifies a greeting '你好' as chat", () => {
    const result = classifyExecutionIntent("你好", DEFAULT_CONFIG);
    expect(result.execution_kind).toBe("chat");
  });

  it("classifies '帮我翻译一下这段代码。' as non-chat (task intent overrides chat)", () => {
    const result = classifyExecutionIntent("帮我翻译一下这段代码。", DEFAULT_CONFIG);
    expect(result.execution_kind).not.toBe("chat");
  });

  it("keywords inside a fenced code block do not influence classification", () => {
    // 'npm install' is inside a code fence — should not be classified as 'install'
    const message = "这段代码怎么样？\n```bash\nnpm install\n```";
    const result = classifyExecutionIntent(message, DEFAULT_CONFIG);
    expect(result.execution_kind).not.toBe("install");
  });

  it("sets input_finalized to true for a message ending with a complete signal", () => {
    const result = classifyExecutionIntent("帮我修复这个 bug。", DEFAULT_CONFIG);
    expect(result.input_finalized).toBe(true);
  });

  it("sets input_finalized to false for a message ending with an incomplete signal '...'", () => {
    const result = classifyExecutionIntent("帮我修复...", DEFAULT_CONFIG);
    expect(result.input_finalized).toBe(false);
  });

  it("sets execution_expected to false when message is not finalized", () => {
    const result = classifyExecutionIntent("帮我...", DEFAULT_CONFIG);
    expect(result.execution_expected).toBe(false);
  });

  it("does not misclassify short technical message 'rm' as chat (keyword-hit guard)", () => {
    const result = classifyExecutionIntent("rm!", DEFAULT_CONFIG);
    expect(result.execution_kind).not.toBe("chat");
  });

  it("handles an oversized message (3000 chars) without crashing and returns a valid result", () => {
    const longMessage = "debug " + "a".repeat(2994) + "!";
    const result = classifyExecutionIntent(longMessage, DEFAULT_CONFIG);
    expect(result.execution_kind).toBeTruthy();
    expect(typeof result.input_finalized).toBe("boolean");
    expect(typeof result.execution_expected).toBe("boolean");
  });

  it("truncates input to 2000 chars so classification still works on the prefix", () => {
    // Place the keyword "debug" at the start so it survives truncation
    const longMessage = "debug this error" + " x".repeat(1500) + "!";
    expect(longMessage.length > 2000).toBe(true);
    const result = classifyExecutionIntent(longMessage, DEFAULT_CONFIG);
    // After truncation the "debug" keyword at the start is still present
    expect(result.execution_kind).toBe("debug");
  });
});

// ---------------------------------------------------------------------------
// 7. toMessageClassification
// ---------------------------------------------------------------------------
describe("toMessageClassification", () => {
  const makeIntent = (overrides: Partial<ExecutionIntent> = {}): ExecutionIntent => ({
    input_finalized: true,
    execution_expected: true,
    execution_kind: "debug",
    ...overrides,
  });

  it("returns high confidence when score >= threshold * 2", () => {
    const mc = toMessageClassification(makeIntent(), 10, DEFAULT_CONFIG);
    expect(mc.confidence).toBe("high");
  });

  it("returns medium confidence when score >= threshold but < threshold * 2", () => {
    const mc = toMessageClassification(makeIntent(), 7, DEFAULT_CONFIG);
    expect(mc.confidence).toBe("medium");
  });

  it("returns low confidence when score < threshold", () => {
    const mc = toMessageClassification(makeIntent(), 2, DEFAULT_CONFIG);
    expect(mc.confidence).toBe("low");
  });

  it("maps debug kind to premium tier", () => {
    const mc = toMessageClassification(makeIntent({ execution_kind: "debug" }), 10, DEFAULT_CONFIG);
    expect(mc.suggested_tier).toBe("premium");
  });

  it("maps chat kind to fast tier", () => {
    const mc = toMessageClassification(makeIntent({ execution_kind: "chat" }), 0, DEFAULT_CONFIG);
    expect(mc.suggested_tier).toBe("fast");
  });

  it("maps search kind to standard tier", () => {
    const mc = toMessageClassification(
      makeIntent({ execution_kind: "search" }),
      10,
      DEFAULT_CONFIG,
    );
    expect(mc.suggested_tier).toBe("standard");
  });

  it("maps unknown kind to fast tier", () => {
    const mc = toMessageClassification(
      makeIntent({ execution_kind: "unknown" }),
      0,
      DEFAULT_CONFIG,
    );
    expect(mc.suggested_tier).toBe("fast");
  });

  it("preserves intent fields in classification output", () => {
    const intent = makeIntent({ input_finalized: false, execution_expected: false });
    const mc = toMessageClassification(intent, 5, DEFAULT_CONFIG);
    expect(mc.input_finalized).toBe(false);
    expect(mc.execution_expected).toBe(false);
    expect(mc.kind).toBe("debug");
    expect(mc.score).toBe(5);
    expect(mc.classifier_version).toBe("2.0-weighted");
  });
});

// ---------------------------------------------------------------------------
// 8. classifyMessage
// ---------------------------------------------------------------------------
describe("classifyMessage", () => {
  it("returns a MessageClassification with all required fields", () => {
    const mc = classifyMessage("帮我 debug 这个 error。", DEFAULT_CONFIG);
    expect(mc.kind).toBe("debug");
    expect(["high", "medium", "low"]).toContain(mc.confidence);
    expect(mc.input_finalized).toBe(true);
    expect(mc.execution_expected).toBe(true);
    expect(mc.suggested_tier).toBe("premium");
    expect(mc.classifier_version).toBe("2.0-weighted");
    expect(typeof mc.score).toBe("number");
  });

  it("classifies greeting as chat with fast tier", () => {
    const mc = classifyMessage("你好", DEFAULT_CONFIG);
    expect(mc.kind).toBe("chat");
    expect(mc.suggested_tier).toBe("fast");
  });

  it("classifies search intent as standard tier", () => {
    const mc = classifyMessage("搜索一下这个文件。", DEFAULT_CONFIG);
    expect(mc.kind).toBe("search");
    expect(mc.suggested_tier).toBe("standard");
  });

  it("returns same kind as classifyExecutionIntent for debug message", () => {
    const intent = classifyExecutionIntent("帮我 debug 这个 error。", DEFAULT_CONFIG);
    const mc = classifyMessage("帮我 debug 这个 error。", DEFAULT_CONFIG);
    expect(mc.kind).toBe(intent.execution_kind);
  });

  it("custom phrase match yields high confidence", () => {
    const config = {
      ...DEFAULT_CONFIG,
      customPhrases: [{ phrase: "deploy now", kind: "run" as const }],
    };
    const mc = classifyMessage("please deploy now!", config);
    expect(mc.kind).toBe("run");
    expect(mc.confidence).toBe("high");
  });

  it("score is 0 for chat pattern match", () => {
    const mc = classifyMessage("你好", DEFAULT_CONFIG);
    expect(mc.score).toBe(0);
  });
});
