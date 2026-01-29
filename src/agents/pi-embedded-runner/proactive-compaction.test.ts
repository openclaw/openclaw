import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { checkProactiveCompaction, resolveProactiveThreshold } from "./proactive-compaction.js";

vi.mock("./logger.js", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe("proactive-compaction", () => {
  describe("resolveProactiveThreshold", () => {
    it("returns 85% of context by default", () => {
      const threshold = resolveProactiveThreshold({
        contextTokens: 200_000,
        config: undefined,
      });
      // 200k * 0.85 = 170k, but reserve-based may be lower
      expect(threshold).toBeLessThanOrEqual(170_000);
      expect(threshold).toBeGreaterThan(0);
    });

    it("respects custom proactiveThresholdRatio config", () => {
      const threshold = resolveProactiveThreshold({
        contextTokens: 200_000,
        config: {
          agents: {
            defaults: {
              compaction: {
                proactiveThresholdRatio: 0.7,
              },
            },
          },
        } as any,
      });
      // Should be min(140k ratio, reserve-based)
      expect(threshold).toBeLessThanOrEqual(140_000);
    });

    it("accounts for reserveTokensFloor in threshold", () => {
      const threshold = resolveProactiveThreshold({
        contextTokens: 50_000,
        config: {
          agents: {
            defaults: {
              compaction: {
                reserveTokensFloor: 25_000,
              },
            },
          },
        } as any,
      });
      // (50000 - 25000) / 1.2 = ~20833
      // vs 50000 * 0.85 = 42500
      // min = ~20833
      expect(threshold).toBeLessThanOrEqual(25_000);
    });

    it("returns 0 for very small context windows", () => {
      const threshold = resolveProactiveThreshold({
        contextTokens: 1_000,
        config: {
          agents: {
            defaults: {
              compaction: {
                reserveTokensFloor: 20_000,
              },
            },
          },
        } as any,
      });
      expect(threshold).toBe(0);
    });
  });

  describe("checkProactiveCompaction", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "proactive-compaction-test-"));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it("returns shouldCompact=false for missing session file", async () => {
      const result = await checkProactiveCompaction({
        sessionFile: path.join(tmpDir, "nonexistent.jsonl"),
        contextTokens: 200_000,
      });
      expect(result.shouldCompact).toBe(false);
      expect(result.reason).toBe("no_session_file");
    });

    it("returns shouldCompact=false for empty session", async () => {
      const sessionFile = path.join(tmpDir, "empty-session.jsonl");
      // Create empty session file with just header (no message entries)
      await fs.writeFile(sessionFile, JSON.stringify({ v: 1, id: "test", cwd: tmpDir }) + "\n");

      const result = await checkProactiveCompaction({
        sessionFile,
        contextTokens: 200_000,
      });
      expect(result.shouldCompact).toBe(false);
      expect(result.reason).toBe("empty_session");
    });

    it("returns shouldCompact=false when tokens below threshold", async () => {
      const sessionFile = path.join(tmpDir, "small-session.jsonl");
      // Create session with small messages using correct JSONL format (type: "message")
      const header = { v: 1, id: "test", cwd: tmpDir };
      const userEntry = {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "Hello" }] },
      };
      const assistantEntry = {
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Hi there!" }] },
      };
      await fs.writeFile(
        sessionFile,
        [JSON.stringify(header), JSON.stringify(userEntry), JSON.stringify(assistantEntry)].join(
          "\n",
        ) + "\n",
      );

      const result = await checkProactiveCompaction({
        sessionFile,
        contextTokens: 200_000,
        promptTokenEstimate: 100,
      });
      expect(result.shouldCompact).toBe(false);
      expect(result.reason).toBe("below_threshold");
      expect(result.estimatedTokens).toBeGreaterThan(0);
    });

    it("returns shouldCompact=true when tokens exceed threshold", async () => {
      const sessionFile = path.join(tmpDir, "large-session.jsonl");
      // Create session with a very large message
      const header = { v: 1, id: "test", cwd: tmpDir };
      const largeText = "x".repeat(100_000); // ~25k tokens at 4 chars/token
      const userEntry = {
        type: "message",
        message: { role: "user", content: [{ type: "text", text: largeText }] },
      };
      await fs.writeFile(
        sessionFile,
        [JSON.stringify(header), JSON.stringify(userEntry)].join("\n") + "\n",
      );

      const result = await checkProactiveCompaction({
        sessionFile,
        contextTokens: 30_000, // Small context to trigger compaction
        promptTokenEstimate: 1000,
      });
      expect(result.shouldCompact).toBe(true);
      expect(result.reason).toBe("exceeded");
    });

    it("handles file with no valid message entries gracefully", async () => {
      const sessionFile = path.join(tmpDir, "no-messages-session.jsonl");
      // File exists but has no message-type entries
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({ v: 1, id: "test", cwd: tmpDir }),
          JSON.stringify({ type: "other", data: "something" }),
        ].join("\n") + "\n",
      );

      const result = await checkProactiveCompaction({
        sessionFile,
        contextTokens: 200_000,
      });
      expect(result.shouldCompact).toBe(false);
      expect(result.reason).toBe("empty_session");
    });
  });
});
