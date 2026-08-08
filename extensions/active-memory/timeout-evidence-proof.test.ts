import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachPartialTimeoutData,
  buildTimeoutRecallResult,
  readPartialTimeoutData,
} from "./transcript-result.js";
import { fileTranscriptSource } from "./transcript.js";
import type { RecallSubagentResult } from "./types.js";

describe("buildTimeoutRecallResult evidence gate (#84034)", () => {
  it("rejects timeout-partial summary WITHOUT recorded memory evidence", async () => {
    const result = await buildTimeoutRecallResult({
      elapsedMs: 1000,
      maxSummaryChars: 200,
      transcriptSources: [],
      rawReply: "user prefers aisle seats and extra legroom",
      toolsAllow: ["memory_search"],
    });
    expect(result.status).toBe("timeout");
    expect(result.summary).toBeNull();
  });

  it("rejects chitchat timeout-partial even with fallback evidence", async () => {
    const result = await buildTimeoutRecallResult({
      elapsedMs: 1000,
      maxSummaryChars: 200,
      transcriptSources: [],
      rawReply: "Hello! How can I help you today?",
      toolsAllow: ["memory_search"],
      fallbackHasUsableMemoryResult: true,
    });
    expect(result.status).toBe("timeout");
    expect(result.summary).toBeNull();
  });

  it("accepts timeout-partial WITH fallback memory evidence", async () => {
    const result = await buildTimeoutRecallResult({
      elapsedMs: 1000,
      maxSummaryChars: 200,
      transcriptSources: [],
      rawReply: "user prefers aisle seats and extra legroom",
      toolsAllow: ["memory_search"],
      fallbackHasUsableMemoryResult: true,
    });
    expect(result.status).toBe("timeout_partial");
    expect(result.summary).toBe("user prefers aisle seats and extra legroom");
  });

  it("accepts timeout-partial WITH callback-only evidence (settled subagent)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-proof-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "user's favorite food is ramen" },
      }) + "\n",
    );
    const subagentPromise = Promise.resolve({
      hasUsableMemoryResult: true,
    } as RecallSubagentResult);
    const result = await buildTimeoutRecallResult({
      elapsedMs: 1000,
      maxSummaryChars: 200,
      transcriptSources: [fileTranscriptSource(sessionFile)],
      subagentPromise,
      toolsAllow: ["memory_search"],
    });
    expect(result.status).toBe("timeout_partial");
    expect(result.summary).toBe("user's favorite food is ramen");
  });

  it("rejects timeout-partial when subagent settles WITHOUT usable evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "am-proof-"));
    const sessionFile = join(dir, "session.jsonl");
    writeFileSync(
      sessionFile,
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: "user's favorite food is ramen" },
      }) + "\n",
    );
    const subagentPromise = Promise.resolve({
      hasUsableMemoryResult: false,
    } as RecallSubagentResult);
    const result = await buildTimeoutRecallResult({
      elapsedMs: 1000,
      maxSummaryChars: 200,
      transcriptSources: [fileTranscriptSource(sessionFile)],
      subagentPromise,
      toolsAllow: ["memory_search"],
    });
    expect(result.status).toBe("timeout");
    expect(result.summary).toBeNull();
  });
});

describe("P1 fix: callback evidence through abort rejects", () => {
  it("attachPartialTimeoutData carries hasUsableMemoryResult through the error payload", () => {
    const error = new Error("Operation aborted");
    error.name = "AbortError";
    attachPartialTimeoutData(error, "partial reply text", undefined, false, true);
    const data = readPartialTimeoutData(error);
    expect(data.rawReply).toBe("partial reply text");
    expect(data.hasUsableMemoryResult).toBe(true);
  });

  it("readPartialTimeoutData returns hasUsableMemoryResult=false when not set", () => {
    const error = new Error("Operation aborted");
    error.name = "AbortError";
    attachPartialTimeoutData(error, "partial reply text", undefined, false, false);
    const data = readPartialTimeoutData(error);
    expect(data.rawReply).toBe("partial reply text");
    expect(data.hasUsableMemoryResult).toBe(false);
  });

  it("accepts timeout-partial when abort error carries callback evidence", async () => {
    const abortError = new Error("Operation aborted");
    abortError.name = "AbortError";
    attachPartialTimeoutData(abortError, "user prefers ramen", undefined, false, true);
    const subagentPromise = Promise.reject(abortError);
    const result = await buildTimeoutRecallResult({
      elapsedMs: 1000,
      maxSummaryChars: 200,
      transcriptSources: [],
      subagentPromise,
      toolsAllow: ["memory_search"],
    });
    expect(result.status).toBe("timeout_partial");
    expect(result.summary).toBe("user prefers ramen");
  });

  it("rejects timeout-partial when abort error carries no callback evidence", async () => {
    const abortError = new Error("Operation aborted");
    abortError.name = "AbortError";
    attachPartialTimeoutData(abortError, "user prefers ramen", undefined, false, false);
    const subagentPromise = Promise.reject(abortError);
    const result = await buildTimeoutRecallResult({
      elapsedMs: 1000,
      maxSummaryChars: 200,
      transcriptSources: [],
      subagentPromise,
      toolsAllow: ["memory_search"],
    });
    expect(result.status).toBe("timeout");
    expect(result.summary).toBeNull();
  });
});
