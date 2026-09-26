import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { readLocalClaudeTranscriptPage } from "./session-catalog-listing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Claude transcript nesting", () => {
  it.each(["content", "input", "metadata", "array"])(
    "reads and serializes pages with deeply nested %s",
    async (field) => {
      const home = tempDirs.make("openclaw-claude-transcript-");
      const sessionId = `deep-${field}-session`;
      const projectDir = path.join(home, ".claude", "projects", "-workspace");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, "sessions-index.json"),
        JSON.stringify({
          version: 1,
          entries: [{ sessionId, summary: "Deep transcript", isSidechain: false }],
        }),
      );
      const olderRow = JSON.stringify({
        type: "user",
        sessionId,
        message: { role: "user", content: "older message" },
      });
      // Build JSON directly so fixture serialization cannot overflow first.
      const depth = 50_000;
      const nested =
        field === "array"
          ? `${"[".repeat(depth)}"nested text"${"]".repeat(depth)}`
          : `${`{"${field}":`.repeat(depth)}"nested text"${"}".repeat(depth)}`;
      const row = JSON.stringify({
        type: "assistant",
        sessionId,
        uuid: "deep-row",
        timestamp: "2026-07-02T00:00:00.000Z",
        message: { role: "assistant", model: "claude-opus-4-8", content: "PLACEHOLDER" },
      }).replace(
        '"PLACEHOLDER"',
        `[{"type":"text","text":"before"},{"type":"tool_result","content":${nested}},{"type":"text","text":"after"}]`,
      );
      await fs.writeFile(path.join(projectDir, `${sessionId}.jsonl`), `${olderRow}\n${row}\n`);

      const page = await readLocalClaudeTranscriptPage({ threadId: sessionId, limit: 1 }, home);
      expect(page.items[0]?.truncated).toBe(true);
      expect(page.items).toEqual([
        expect.objectContaining({
          type: "agentMessage",
          uuid: "deep-row",
          model: "claude-opus-4-8",
          timestamp: "2026-07-02T00:00:00.000Z",
          text: `${field === "metadata" ? "before\n\nafter" : "before\n\nnested text\n\nafter"}\n\n[deeply nested Claude item truncated]`,
        }),
      ]);
      expect(page.items[0]?.content).toBeUndefined();
      expect(() => JSON.stringify(page)).not.toThrow();
      expect(page.nextCursor).toEqual(expect.any(String));
      const older = await readLocalClaudeTranscriptPage(
        { threadId: sessionId, limit: 1, cursor: page.nextCursor },
        home,
      );
      expect(older.items.map((item) => item.text)).toEqual(["older message"]);
      expect(older.nextCursor).toBeUndefined();
    },
  );
});
