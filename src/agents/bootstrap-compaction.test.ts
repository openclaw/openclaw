import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CompactionLlmFn,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  clearCompactionCache,
  compactBootstrapFile,
  compactBootstrapFiles,
  isCompactableFile,
  resolveCompactionConfig,
} from "./bootstrap-compaction.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STRUCTURED_SUMMARY = `## Key Rules
- Rule A
- Rule B

## Recent Decisions
- Decision X made because Y

## Open Tasks / Blockers
- Task 1: in-progress

## Critical References
- /path/to/file.ts`;

/** Creates a mock llmFn that returns the given text. */
function makeLlmFn(response: string): CompactionLlmFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue(response) as CompactionLlmFn & ReturnType<typeof vi.fn>;
}

/** Creates a mock llmFn that rejects with the given error. */
function makeFailingLlmFn(error: Error): CompactionLlmFn & ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(error) as CompactionLlmFn & ReturnType<typeof vi.fn>;
}

// ── isCompactableFile ─────────────────────────────────────────────────────────

describe("isCompactableFile", () => {
  it("accepts MEMORY.md", () => {
    expect(isCompactableFile("/workspace/MEMORY.md")).toBe(true);
    expect(isCompactableFile("MEMORY.md")).toBe(true);
  });

  it("accepts memory/YYYY-MM-DD.md", () => {
    expect(isCompactableFile("/workspace/memory/2026-03-07.md")).toBe(true);
    expect(isCompactableFile("memory/2024-01-01.md")).toBe(true);
    expect(isCompactableFile("/home/user/memory/2025-12-31.md")).toBe(true);
  });

  it("rejects AGENTS.md", () => {
    expect(isCompactableFile("/workspace/AGENTS.md")).toBe(false);
  });

  it("rejects SOUL.md", () => {
    expect(isCompactableFile("/workspace/SOUL.md")).toBe(false);
  });

  it("rejects IDENTITY.md", () => {
    expect(isCompactableFile("IDENTITY.md")).toBe(false);
  });

  it("rejects CONSTITUTION.md", () => {
    expect(isCompactableFile("/workspace/CONSTITUTION.md")).toBe(false);
  });

  it("rejects arbitrary .md files", () => {
    expect(isCompactableFile("/workspace/README.md")).toBe(false);
    expect(isCompactableFile("/workspace/TOOLS.md")).toBe(false);
    expect(isCompactableFile("/workspace/memory/notes.md")).toBe(false);
  });

  it("rejects MEMORY.md in wrong directory (date-like name but wrong parent)", () => {
    // A date-named .md that is not inside a 'memory' directory
    expect(isCompactableFile("/workspace/logs/2026-03-07.md")).toBe(false);
  });

  it("accepts memory/YYYY-MM-DD.md only when parent dir is 'memory'", () => {
    expect(isCompactableFile("/workspace/archive/2026-03-07.md")).toBe(false);
    expect(isCompactableFile("/workspace/memory/2026-03-07.md")).toBe(true);
  });
});

// ── resolveCompactionConfig ───────────────────────────────────────────────────

describe("resolveCompactionConfig", () => {
  it("returns empty config when cfg is undefined", () => {
    const result = resolveCompactionConfig(undefined);
    expect(result.model).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
  });

  it("returns empty config when agents.defaults.compaction is absent", () => {
    const result = resolveCompactionConfig({ agents: { defaults: {} } } as never);
    expect(result.model).toBeUndefined();
    expect(result.timeoutMs).toBeUndefined();
  });

  it("reads model from config", () => {
    const cfg = {
      agents: { defaults: { compaction: { model: "claude-haiku-4-5-20251001" } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.model).toBe("claude-haiku-4-5-20251001");
  });

  it("reads timeoutMs from config", () => {
    const cfg = {
      agents: { defaults: { compaction: { timeoutMs: 15_000 } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.timeoutMs).toBe(15_000);
  });

  it("reads both model and timeoutMs from config", () => {
    const cfg = {
      agents: {
        defaults: { compaction: { model: "claude-opus-4-6", timeoutMs: 60_000 } },
      },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.model).toBe("claude-opus-4-6");
    expect(result.timeoutMs).toBe(60_000);
  });

  it("ignores non-string model values", () => {
    const cfg = {
      agents: { defaults: { compaction: { model: 42 } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.model).toBeUndefined();
  });

  it("ignores non-number timeoutMs values", () => {
    const cfg = {
      agents: { defaults: { compaction: { timeoutMs: "30000" } } },
    } as never;
    const result = resolveCompactionConfig(cfg);
    expect(result.timeoutMs).toBeUndefined();
  });

  it("DEFAULT_COMPACTION_TIMEOUT_MS is 30 seconds", () => {
    expect(DEFAULT_COMPACTION_TIMEOUT_MS).toBe(30_000);
  });
});

// ── compactBootstrapFile ──────────────────────────────────────────────────────

describe("compactBootstrapFile", () => {
  beforeEach(() => {
    clearCompactionCache();
  });

  it("calls llmFn and returns compacted content", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const { compacted, result } = await compactBootstrapFile({
      content: "Some long memory content that needs compaction.",
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(compacted).toBe(STRUCTURED_SUMMARY);
    expect(result.success).toBe(true);
    expect(result.path).toBe("/workspace/MEMORY.md");
    expect(result.charsBefore).toBe("Some long memory content that needs compaction.".length);
    expect(result.charsAfter).toBe(STRUCTURED_SUMMARY.length);
    expect(llmFn).toHaveBeenCalledOnce();
  });

  it("passes content as user prompt to llmFn", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    await compactBootstrapFile({
      content: "Memory content to compact",
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(llmFn).toHaveBeenCalledWith("Memory content to compact", undefined);
  });

  it("returns original content with success=false on llmFn error", async () => {
    const llmFn = makeFailingLlmFn(new Error("API error 500"));

    const content = "Original memory content";
    const { compacted, result } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(result.success).toBe(false);
    expect(compacted).toBe(content);
    expect(result.fallbackReason).toContain("API error 500");
    expect(result.charsAfter).toBe(content.length);
  });

  it("returns original content with success=false on llmFn rejection", async () => {
    const llmFn = makeFailingLlmFn(new Error("Network error"));

    const content = "Original memory content";
    const { compacted, result } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(result.success).toBe(false);
    expect(compacted).toBe(content);
    expect(result.fallbackReason).toContain("Network error");
  });

  it("truncates input to COMPACTION_MAX_INPUT_CHARS with head+tail split before sending", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const longContent = "H".repeat(5_000) + "T".repeat(10_000); // 15K, exceeds 10K limit
    await compactBootstrapFile({
      content: longContent,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    const sentPrompt = llmFn.mock.calls[0][0] as string;
    // Head 30% = 3000 chars, tail 70% = 7000 chars, plus omission marker in between
    expect(sentPrompt).toContain("[... middle content omitted for compaction ...]");
    expect(sentPrompt.startsWith("H")).toBe(true);
    expect(sentPrompt.endsWith("T")).toBe(true);
    // Total should be 10K + marker length
    const markerLen = "\n\n[... middle content omitted for compaction ...]\n\n".length;
    expect(sentPrompt.length).toBe(10_000 + markerLen);
  });

  it("passes signal to llmFn", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);
    const signal = AbortSignal.abort();

    await compactBootstrapFile({
      content: "Memory content",
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
      signal,
    });

    expect(llmFn).toHaveBeenCalledWith("Memory content", signal);
  });
});

// ── Content-hash caching ──────────────────────────────────────────────────────

describe("compactBootstrapFile - content-hash cache", () => {
  beforeEach(() => {
    clearCompactionCache();
  });

  it("returns cached result without calling LLM on second call with same content", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const content = "Memory content for caching test";

    // First call — should hit the LLM
    const first = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });
    expect(llmFn).toHaveBeenCalledOnce();

    // Second call with same content — should use cache
    const second = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });
    expect(llmFn).toHaveBeenCalledOnce(); // still only one call
    expect(second.compacted).toBe(first.compacted);
  });

  it("calls LLM again when content changes (cache miss)", async () => {
    const llmFn = vi
      .fn()
      .mockResolvedValueOnce("Summary A")
      .mockResolvedValueOnce("Summary B") as CompactionLlmFn & ReturnType<typeof vi.fn>;

    await compactBootstrapFile({
      content: "Content version 1",
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });
    expect(llmFn).toHaveBeenCalledTimes(1);

    await compactBootstrapFile({
      content: "Content version 2 — different content",
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });
    expect(llmFn).toHaveBeenCalledTimes(2);
  });

  it("cache is keyed by file path — different paths do not share cache", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const content = "Same content for both files";

    await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });
    await compactBootstrapFile({
      content,
      filePath: "/workspace/memory/2026-03-07.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    // Different file paths → two separate LLM calls
    expect(llmFn).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache when only middle content changes (full-content hash)", async () => {
    const llmFn = vi
      .fn()
      .mockResolvedValueOnce("Summary A")
      .mockResolvedValueOnce("Summary B") as CompactionLlmFn & ReturnType<typeof vi.fn>;

    // Content > 10K so it gets truncated (head 3K + tail 7K).
    // Head and tail stay identical; only the middle (which is omitted from LLM input) changes.
    const head = "H".repeat(3_000);
    const tail = "T".repeat(7_000);
    const contentV1 = head + "MIDDLE-V1".repeat(500) + tail; // well over 10K
    const contentV2 = head + "MIDDLE-V2".repeat(500) + tail; // same head/tail, different middle

    await compactBootstrapFile({
      content: contentV1,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });
    expect(llmFn).toHaveBeenCalledTimes(1);

    // Middle changed → full-content hash differs → cache miss → second LLM call
    const { compacted } = await compactBootstrapFile({
      content: contentV2,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
    });
    expect(llmFn).toHaveBeenCalledTimes(2);
    expect(compacted).toBe("Summary B");
  });

  it("cache invalidates when modelRef changes", async () => {
    const llmFn = vi
      .fn()
      .mockResolvedValueOnce("Summary model-A")
      .mockResolvedValueOnce("Summary model-B") as CompactionLlmFn & ReturnType<typeof vi.fn>;

    const content = "Same content for both calls";

    await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "provider/model-a",
    });
    expect(llmFn).toHaveBeenCalledTimes(1);

    // Same content, different model → cache miss
    const { compacted } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "provider/model-b",
    });
    expect(llmFn).toHaveBeenCalledTimes(2);
    expect(compacted).toBe("Summary model-B");
  });

  it("hits cache when both content and modelRef are identical", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const content = "Content for model-aware cache test";
    const modelRef = "anthropic/claude-haiku-4-5-20251001";

    await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef,
    });
    await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef,
    });
    expect(llmFn).toHaveBeenCalledOnce();
  });
});

// ── Timeout handling ──────────────────────────────────────────────────────────

describe("compactBootstrapFile - timeout handling", () => {
  beforeEach(() => {
    clearCompactionCache();
  });

  it("falls back gracefully when llmFn is aborted", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const llmFn = makeFailingLlmFn(abortError);

    const content = "Memory content";
    const { compacted, result } = await compactBootstrapFile({
      content,
      filePath: "/workspace/MEMORY.md",
      config: {},
      llmFn,
      modelRef: "test/model",
      signal: AbortSignal.abort(), // pre-aborted
    });

    expect(result.success).toBe(false);
    expect(compacted).toBe(content); // original content returned
    expect(result.fallbackReason).toBeTruthy();
  });
});

// ── compactBootstrapFiles (orchestrator) ──────────────────────────────────────

describe("compactBootstrapFiles", () => {
  beforeEach(() => {
    clearCompactionCache();
  });

  it("returns unchanged files when no compactable files present", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const contextFiles = [
      { path: "/workspace/AGENTS.md", content: "Agents content" },
      { path: "/workspace/SOUL.md", content: "Soul content" },
    ];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(result).toEqual(contextFiles);
    expect(results).toHaveLength(0);
    expect(llmFn).not.toHaveBeenCalled();
  });

  it("compacts MEMORY.md and replaces its content", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const contextFiles = [
      { path: "/workspace/AGENTS.md", content: "Agents content (not compactable)" },
      { path: "/workspace/MEMORY.md", content: "Long memory content".repeat(100) },
    ];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(result).toHaveLength(2);
    // AGENTS.md should be unchanged
    expect(result[0].content).toBe("Agents content (not compactable)");
    // MEMORY.md should be compacted
    expect(result[1].content).toBe(STRUCTURED_SUMMARY);
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].path).toBe("/workspace/MEMORY.md");
  });

  it("compacts memory/YYYY-MM-DD.md files", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const contextFiles = [
      { path: "/workspace/memory/2026-03-07.md", content: "Daily log content".repeat(50) },
    ];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(result[0].content).toBe(STRUCTURED_SUMMARY);
    expect(results[0].success).toBe(true);
  });

  it("selects only the largest 3 compactable files", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const contextFiles = [
      { path: "/workspace/MEMORY.md", content: "A".repeat(5000) },
      { path: "/workspace/memory/2026-03-05.md", content: "B".repeat(3000) },
      { path: "/workspace/memory/2026-03-06.md", content: "C".repeat(4000) },
      { path: "/workspace/memory/2026-03-07.md", content: "D".repeat(2000) },
      // 4 compactable files → only 3 largest should be compacted
    ];

    const { results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(results).toHaveLength(3);
    expect(llmFn).toHaveBeenCalledTimes(3);
    // Verify the 3 largest were selected (MEMORY.md=5000, 2026-03-06=4000, 2026-03-05=3000)
    const compactedPaths = results.map((r) => r.path).toSorted();
    expect(compactedPaths).toContain("/workspace/MEMORY.md");
    expect(compactedPaths).toContain("/workspace/memory/2026-03-06.md");
    expect(compactedPaths).toContain("/workspace/memory/2026-03-05.md");
    // Smallest (2026-03-07=2000) should NOT be compacted
    expect(compactedPaths).not.toContain("/workspace/memory/2026-03-07.md");
  });

  it("preserves original content for files that fail compaction", async () => {
    const llmFn = makeFailingLlmFn(new Error("API unavailable"));

    const originalContent = "Memory content to compact";
    const contextFiles = [{ path: "/workspace/MEMORY.md", content: originalContent }];

    const { contextFiles: result, results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    // Content should be unchanged on failure
    expect(result[0].content).toBe(originalContent);
    expect(results[0].success).toBe(false);
    expect(results[0].fallbackReason).toContain("API unavailable");
  });

  it("returns CompactionResult with correct charsBefore and charsAfter on success", async () => {
    const llmFn = makeLlmFn(STRUCTURED_SUMMARY);

    const originalContent = "Original content";
    const contextFiles = [{ path: "/workspace/MEMORY.md", content: originalContent }];

    const { results } = await compactBootstrapFiles({
      contextFiles,
      config: {},
      llmFn,
      modelRef: "test/model",
    });

    expect(results[0].charsBefore).toBe(originalContent.length);
    expect(results[0].charsAfter).toBe(STRUCTURED_SUMMARY.length);
  });
});
