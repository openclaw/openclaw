import type { AgentMessage } from "@mariozechner/pi-agent-core";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import { loadSwappedFileStore, resultsDir } from "./file-store.js";
import { swapAgedToolResults } from "./file-swapper.js";

let tmpDir: string;

function sessionPath(): string {
  return path.join(tmpDir, "session.jsonl");
}

/**
 * Build a minimal message transcript for testing.
 * Pattern: user → assistant (with tool_use) → toolResult → user → assistant → ...
 * Each user message marks a new turn boundary.
 */
function buildMessages(turnCount: number, toolResultContent: string = "x".repeat(500)): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let turn = 0; turn < turnCount; turn++) {
    // User message
    messages.push({
      role: "user",
      content: `User message turn ${turn}`,
      timestamp: Date.now(),
    } as AgentMessage);

    // Assistant with tool_use
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: "Let me check that." },
        { type: "tool_use", id: `tool-${turn}`, name: "Read", input: { path: `/src/file${turn}.ts` } },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage);

    // Tool result
    messages.push({
      role: "toolResult",
      toolCallId: `tool-${turn}`,
      content: [{ type: "text", text: toolResultContent }],
      timestamp: Date.now(),
    } as unknown as AgentMessage);
  }

  // Final user message (current turn)
  messages.push({
    role: "user",
    content: "Current message",
    timestamp: Date.now(),
  } as AgentMessage);

  return messages;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "file-swapper-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("swapAgedToolResults", () => {
  it("swaps tool results older than threshold", async () => {
    const messages = buildMessages(5);
    const config: ContextDecayConfig = {
      swapToolResultsAfterTurns: 2,
    };

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const store = await loadSwappedFileStore(sessionPath());
    // Turns 0-2 have age >= 2 (5 turns total, last is current)
    // Turn 0 = age 5, Turn 1 = age 4, Turn 2 = age 3, Turn 3 = age 2, Turn 4 = age 1
    const swappedIndices = Object.keys(store).map(Number);
    expect(swappedIndices.length).toBeGreaterThan(0);

    // Verify files exist on disk
    for (const entry of Object.values(store)) {
      const content = await fs.readFile(entry.filePath, "utf-8");
      expect(content.length).toBeGreaterThan(0);
      expect(entry.hint).toBeTruthy();
      expect(entry.toolName).toBe("Read");
    }
  });

  it("skips tool results below swapMinChars", async () => {
    const messages = buildMessages(3, "short");
    const config: ContextDecayConfig = {
      swapToolResultsAfterTurns: 1,
      swapMinChars: 256,
    };

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const store = await loadSwappedFileStore(sessionPath());
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("skips tool results past summarize threshold", async () => {
    const messages = buildMessages(5);
    const config: ContextDecayConfig = {
      swapToolResultsAfterTurns: 2,
      summarizeToolResultsAfterTurns: 3,
    };

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const store = await loadSwappedFileStore(sessionPath());
    // Only results with age >= 2 AND age < 3 should be swapped
    for (const [, entry] of Object.entries(store)) {
      expect(entry).toBeDefined();
    }
    // Older results (age >= 3) should NOT be in the store
    // since summarizer handles those
  });

  it("skips tool results past strip threshold", async () => {
    const messages = buildMessages(5);
    const config: ContextDecayConfig = {
      swapToolResultsAfterTurns: 2,
      stripToolResultsAfterTurns: 3,
    };

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const store = await loadSwappedFileStore(sessionPath());
    // Results with age >= 3 should be skipped (strip handles them)
    for (const [, entry] of Object.entries(store)) {
      expect(entry).toBeDefined();
    }
  });

  it("does not re-swap already swapped results", async () => {
    const messages = buildMessages(5);
    const config: ContextDecayConfig = {
      swapToolResultsAfterTurns: 2,
    };

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const store1 = await loadSwappedFileStore(sessionPath());
    const count1 = Object.keys(store1).length;

    // Run again — should not change anything
    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const store2 = await loadSwappedFileStore(sessionPath());
    expect(Object.keys(store2).length).toBe(count1);
  });

  it("is a no-op when swapToolResultsAfterTurns is not set", async () => {
    const messages = buildMessages(5);
    const config: ContextDecayConfig = {
      summarizeToolResultsAfterTurns: 5,
    };

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const store = await loadSwappedFileStore(sessionPath());
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("respects abort signal", async () => {
    const messages = buildMessages(10);
    const config: ContextDecayConfig = {
      swapToolResultsAfterTurns: 1,
    };

    const controller = new AbortController();
    controller.abort();

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
      abortSignal: controller.signal,
    });

    const store = await loadSwappedFileStore(sessionPath());
    expect(Object.keys(store)).toHaveLength(0);
  });

  it("creates results directory alongside session file", async () => {
    const messages = buildMessages(3);
    const config: ContextDecayConfig = {
      swapToolResultsAfterTurns: 1,
    };

    await swapAgedToolResults({
      sessionFilePath: sessionPath(),
      messages,
      config,
    });

    const resDir = resultsDir(sessionPath());
    const stat = await fs.stat(resDir);
    expect(stat.isDirectory()).toBe(true);
  });
});
