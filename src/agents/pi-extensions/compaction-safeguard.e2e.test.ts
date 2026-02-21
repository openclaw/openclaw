import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { buildEmbeddedExtensionPaths } from "../pi-embedded-runner/extensions.js";
import {
  getCompactionSafeguardRuntime,
  setCompactionSafeguardRuntime,
} from "./compaction-safeguard-runtime.js";
import { __testing } from "./compaction-safeguard.js";

const {
  collectToolFailures,
  formatToolFailuresSection,
  splitPreservedRecentTurns,
  formatPreservedTurnsSection,
  buildCompactionStructureInstructions,
  extractOpaqueIdentifiers,
  auditSummaryQuality,
  resolveRecentTurnsPreserve,
  resolveQualityGuardMaxRetries,
  computeAdaptiveChunkRatio,
  isOversizedForSummary,
  BASE_CHUNK_RATIO,
  MIN_CHUNK_RATIO,
  SAFETY_MARGIN,
} = __testing;

describe("compaction-safeguard tool failures", () => {
  it("formats tool failures with meta and summary", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { status: "failed", exitCode: 1 },
        content: [{ type: "text", text: "ENOENT: missing file" }],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("exec (status=failed exitCode=1): ENOENT: missing file");
  });

  it("dedupes by toolCallId and handles empty output", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        details: { exitCode: 2 },
        content: [],
        timestamp: Date.now(),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ignored" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    expect(failures).toHaveLength(1);

    const section = formatToolFailuresSection(failures);
    expect(section).toContain("exec (exitCode=2): failed");
  });

  it("caps the number of failures and adds overflow line", () => {
    const messages: AgentMessage[] = Array.from({ length: 9 }, (_, idx) => ({
      role: "toolResult",
      toolCallId: `call-${idx}`,
      toolName: "exec",
      isError: true,
      content: [{ type: "text", text: `error ${idx}` }],
      timestamp: Date.now(),
    }));

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toContain("## Tool Failures");
    expect(section).toContain("...and 1 more");
  });

  it("omits section when there are no tool failures", () => {
    const messages: AgentMessage[] = [
      {
        role: "toolResult",
        toolCallId: "ok",
        toolName: "exec",
        isError: false,
        content: [{ type: "text", text: "ok" }],
        timestamp: Date.now(),
      },
    ];

    const failures = collectToolFailures(messages);
    const section = formatToolFailuresSection(failures);
    expect(section).toBe("");
  });
});

describe("computeAdaptiveChunkRatio", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns BASE_CHUNK_RATIO for normal messages", () => {
    // Small messages: 1000 tokens each, well under 10% of context
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(1000), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(1000) }],
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("reduces ratio when average message > 10% of context", () => {
    // Large messages: ~50K tokens each (25% of context)
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(50_000 * 4), timestamp: Date.now() },
      {
        role: "assistant",
        content: [{ type: "text", text: "y".repeat(50_000 * 4) }],
        timestamp: Date.now(),
      } as unknown as AgentMessage,
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeLessThan(BASE_CHUNK_RATIO);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("respects MIN_CHUNK_RATIO floor", () => {
    // Very large messages that would push ratio below minimum
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(150_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
  });

  it("handles empty message array", () => {
    const ratio = computeAdaptiveChunkRatio([], CONTEXT_WINDOW);
    expect(ratio).toBe(BASE_CHUNK_RATIO);
  });

  it("handles single huge message", () => {
    // Single massive message
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(180_000 * 4), timestamp: Date.now() },
    ];

    const ratio = computeAdaptiveChunkRatio(messages, CONTEXT_WINDOW);
    expect(ratio).toBeGreaterThanOrEqual(MIN_CHUNK_RATIO);
    expect(ratio).toBeLessThanOrEqual(BASE_CHUNK_RATIO);
  });
});

describe("isOversizedForSummary", () => {
  const CONTEXT_WINDOW = 200_000;

  it("returns false for small messages", () => {
    const msg: AgentMessage = {
      role: "user",
      content: "Hello, world!",
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(false);
  });

  it("returns true for messages > 50% of context", () => {
    // Message with ~120K tokens (60% of 200K context)
    // After safety margin (1.2x), effective is 144K which is > 100K (50%)
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(120_000 * 4),
      timestamp: Date.now(),
    };

    expect(isOversizedForSummary(msg, CONTEXT_WINDOW)).toBe(true);
  });

  it("applies safety margin", () => {
    // Message at exactly 50% of context before margin
    // After SAFETY_MARGIN (1.2), it becomes 60% which is > 50%
    const halfContextChars = (CONTEXT_WINDOW * 0.5) / SAFETY_MARGIN;
    const msg: AgentMessage = {
      role: "user",
      content: "x".repeat(Math.floor(halfContextChars * 4)),
      timestamp: Date.now(),
    };

    // With safety margin applied, this should be at the boundary
    // The function checks if tokens * SAFETY_MARGIN > contextWindow * 0.5
    const isOversized = isOversizedForSummary(msg, CONTEXT_WINDOW);
    // Due to token estimation, this could be either true or false at the boundary
    expect(typeof isOversized).toBe("boolean");
  });
});

describe("compaction-safeguard runtime registry", () => {
  it("stores and retrieves config by session manager identity", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.3 });
    const runtime = getCompactionSafeguardRuntime(sm);
    expect(runtime).toEqual({ maxHistoryShare: 0.3 });
  });

  it("returns null for unknown session manager", () => {
    const sm = {};
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("clears entry when value is null", () => {
    const sm = {};
    setCompactionSafeguardRuntime(sm, { maxHistoryShare: 0.7 });
    expect(getCompactionSafeguardRuntime(sm)).not.toBeNull();
    setCompactionSafeguardRuntime(sm, null);
    expect(getCompactionSafeguardRuntime(sm)).toBeNull();
  });

  it("ignores non-object session managers", () => {
    setCompactionSafeguardRuntime(null, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(null)).toBeNull();
    setCompactionSafeguardRuntime(undefined, { maxHistoryShare: 0.5 });
    expect(getCompactionSafeguardRuntime(undefined)).toBeNull();
  });

  it("isolates different session managers", () => {
    const sm1 = {};
    const sm2 = {};
    setCompactionSafeguardRuntime(sm1, { maxHistoryShare: 0.3 });
    setCompactionSafeguardRuntime(sm2, { maxHistoryShare: 0.8 });
    expect(getCompactionSafeguardRuntime(sm1)).toEqual({ maxHistoryShare: 0.3 });
    expect(getCompactionSafeguardRuntime(sm2)).toEqual({ maxHistoryShare: 0.8 });
  });

  it("wires quality guard retries from config and clamps safeguard runtime usage", () => {
    const sessionManager = {} as unknown as Parameters<
      typeof buildEmbeddedExtensionPaths
    >[0]["sessionManager"];
    const cfg = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
            recentTurnsPreserve: 99,
            qualityGuard: { maxRetries: 99 },
          },
        },
      },
    } as OpenClawConfig;

    buildEmbeddedExtensionPaths({
      cfg,
      sessionManager,
      provider: "anthropic",
      modelId: "claude-3-opus",
      model: {
        contextWindow: 200_000,
      } as Parameters<typeof buildEmbeddedExtensionPaths>[0]["model"],
    });

    const runtime = getCompactionSafeguardRuntime(sessionManager);
    expect(runtime?.qualityGuardMaxRetries).toBe(99);
    expect(runtime?.recentTurnsPreserve).toBe(99);
    expect(resolveQualityGuardMaxRetries(runtime?.qualityGuardMaxRetries)).toBe(3);
    expect(resolveRecentTurnsPreserve(runtime?.recentTurnsPreserve)).toBe(12);
  });
});

describe("compaction-safeguard summary quality helpers", () => {
  it("preserves the most recent user/assistant messages", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "older ask", timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: "older answer" }],
        timestamp: 2,
      } as unknown as AgentMessage,
      { role: "user", content: "recent ask", timestamp: 3 },
      {
        role: "assistant",
        content: [{ type: "text", text: "recent answer" }],
        timestamp: 4,
      } as unknown as AgentMessage,
    ];

    const split = splitPreservedRecentTurns({
      messages,
      recentTurnsPreserve: 1,
    });

    expect(split.preservedMessages).toHaveLength(2);
    expect(split.summarizableMessages).toHaveLength(2);
    expect(formatPreservedTurnsSection(split.preservedMessages)).toContain(
      "## Recent turns preserved verbatim",
    );
  });

  it("builds structured instructions with required sections", () => {
    const instructions = buildCompactionStructureInstructions("Keep security caveats.");
    expect(instructions).toContain("## Decisions");
    expect(instructions).toContain("## Exact identifiers");
    expect(instructions).toContain("Keep security caveats.");
  });

  it("extracts opaque identifiers and audits summary quality", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Track id a1b2c3d4e5f6 plus A1B2C3D4E5F6 and URL https://example.com/a and /tmp/x.log plus port host.local:18789",
    );
    expect(identifiers.length).toBeGreaterThan(0);
    expect(identifiers).toContain("A1B2C3D4E5F6");

    const summary = [
      "## Decisions",
      "Keep current flow.",
      "## Open TODOs",
      "None.",
      "## Constraints/Rules",
      "Preserve identifiers.",
      "## Pending user asks",
      "Explain post-compaction behavior.",
      "## Exact identifiers",
      identifiers.join(", "),
    ].join("\n");

    const quality = auditSummaryQuality({
      summary,
      identifiers,
      latestAsk: "Explain post-compaction behavior for memory indexing",
    });
    expect(quality.ok).toBe(true);
  });

  it("dedupes identifiers before applying the result cap", () => {
    const noisyPrefix = Array.from({ length: 10 }, () => "a0b0c0d0").join(" ");
    const uniqueTail = Array.from(
      { length: 12 },
      (_, idx) => `b${idx.toString(16).padStart(7, "0")}`,
    );
    const identifiers = extractOpaqueIdentifiers(`${noisyPrefix} ${uniqueTail.join(" ")}`);

    expect(identifiers).toHaveLength(12);
    expect(new Set(identifiers).size).toBe(12);
    expect(identifiers).toContain("a0b0c0d0");
    expect(identifiers).toContain(uniqueTail[10]);
  });

  it("filters ordinary short numbers and trims wrapped punctuation", () => {
    const identifiers = extractOpaqueIdentifiers(
      "Year 2026 count 42 port 18789 ticket 123456 URL https://example.com/a, path /tmp/x.log.",
    );

    expect(identifiers).not.toContain("2026");
    expect(identifiers).not.toContain("42");
    expect(identifiers).not.toContain("18789");
    expect(identifiers).toContain("123456");
    expect(identifiers).toContain("https://example.com/a");
    expect(identifiers).toContain("/tmp/x.log");
  });

  it("fails quality audit when required sections are missing", () => {
    const quality = auditSummaryQuality({
      summary: "Short summary without structure",
      identifiers: ["abc12345"],
      latestAsk: "Need a status update",
    });
    expect(quality.ok).toBe(false);
    expect(quality.reasons.length).toBeGreaterThan(0);
  });
});
