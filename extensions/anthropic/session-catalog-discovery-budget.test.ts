import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { listLocalClaudeSessionPage } from "./session-catalog.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Claude session catalog discovery budget", () => {
  it("finds an exact session ID beyond the metadata scan budget", async () => {
    const home = tempDirs.make("openclaw-catalog-budget-");
    try {
      const projectDir = path.join(home, ".claude", "projects", "-workspace");
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(
        path.join(projectDir, "sessions-index.json"),
        JSON.stringify({ version: 1, entries: [] }),
      );

      const fileBytes = 1024 * 1024;
      const chunkBytes = 16 * 1024;
      const leadingFiller = Buffer.from(`${"x".repeat(chunkBytes - 1)}\n`.repeat(63));
      for (let index = 0; index < 66; index += 1) {
        const sessionId = `budget-${String(index).padStart(2, "0")}`;
        const message = {
          type: "user",
          sessionId,
          uuid: `${sessionId}-1`,
          timestamp: "2026-07-01T00:00:00.000Z",
          isSidechain: false,
          message: { role: "user", content: [{ type: "text", text: sessionId }] },
          entrypoint: "sdk-cli",
          cwd: `/work/${sessionId}`,
          version: "2.1.204",
        };
        const messageLine = Buffer.from(`${JSON.stringify(message)}\n`);
        const finalFillerBytes = fileBytes - leadingFiller.length - messageLine.length;
        const finalFiller = Buffer.from(`${"x".repeat(finalFillerBytes - 1)}\n`);
        await fs.writeFile(
          path.join(projectDir, `${sessionId}.jsonl`),
          Buffer.concat([leadingFiller, finalFiller, messageLine]),
        );
      }

      const sessionFiles = (await fs.readdir(projectDir)).filter((name) => name.endsWith(".jsonl"));
      const targetFile = sessionFiles.at(-1);
      if (!targetFile) {
        throw new Error("expected a session beyond the metadata scan budget");
      }
      const targetId = targetFile.slice(0, -".jsonl".length);
      const ordinaryPage = await listLocalClaudeSessionPage({ limit: 100 }, home, {
        includeDesktop: false,
      });
      expect(ordinaryPage.sessions.some((session) => session.threadId === targetId)).toBe(false);

      const exactSearch = await listLocalClaudeSessionPage(
        { limit: 100, searchTerm: targetId },
        home,
        { includeDesktop: false },
      );
      expect(exactSearch.sessions.map((session) => session.threadId)).toContain(targetId);

      const negativeControl = await listLocalClaudeSessionPage(
        { limit: 100, searchTerm: "missing-budget-session" },
        home,
        { includeDesktop: false },
      );
      expect(negativeControl.sessions).toEqual([]);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});
