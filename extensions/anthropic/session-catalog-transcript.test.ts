import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { readLocalClaudeTranscriptPage } from "./session-catalog-listing.js";

const homes = useAutoCleanupTempDirTracker(afterEach);

it.each(["content", "metadata"])(
  "pages deeply nested Claude %s without losing text",
  async (key) => {
    const home = homes.make("claude-deep-history-");
    const threadId = "deep-history";
    const project = path.join(home, ".claude", "projects", "-fixture");
    await fs.mkdir(project, { recursive: true });
    await fs.writeFile(
      path.join(project, "sessions-index.json"),
      JSON.stringify({ version: 1, entries: [{ sessionId: threadId, summary: "Deep history" }] }),
    );
    const older = JSON.stringify({
      type: "user",
      sessionId: threadId,
      message: { role: "user", content: "earlier question" },
    });
    // Construct wire JSON directly: serializing the fixture would overflow before the reader runs.
    const nested = `${`{"${key}":[`.repeat(50_000)}{"text":"answer","thinking":"thought","content":"detail","input":"argument"}${"]}".repeat(50_000)}`;
    const latest = `{"type":"assistant","uuid":"latest","timestamp":"2026-01-01T00:00:00Z","message":{"role":"assistant","model":"fixture-model","content":[{"type":"text","text":"before"},{"type":"tool_result","content":${nested}},{"type":"text","text":"after"}]}}`;
    const transcript = path.join(project, `${threadId}.jsonl`);
    const source = `${older}\n${latest}\n`;
    await fs.writeFile(transcript, source);

    const page = await readLocalClaudeTranscriptPage({ threadId, limit: 1 }, home);
    const item = page.items[0];
    expect(item).toMatchObject({
      type: "agentMessage",
      uuid: "latest",
      timestamp: "2026-01-01T00:00:00Z",
      model: "fixture-model",
      truncated: true,
    });
    expect(item?.text).toBe(
      `${key === "content" ? "before\n\nanswer\n\nthought\n\ndetail\n\nargument\n\nafter" : "before\n\nafter"}\n\n[oversized or deeply nested Claude item truncated]`,
    );
    expect(item?.content).toBeUndefined();
    expect(() => JSON.stringify(page)).not.toThrow();
    expect(page.nextCursor).toEqual(expect.any(String));
    const previous = await readLocalClaudeTranscriptPage(
      { threadId, limit: 1, cursor: page.nextCursor },
      home,
    );
    expect(previous.items.map((entry) => entry.text)).toEqual(["earlier question"]);
    expect(previous.nextCursor).toBeUndefined();
    expect(await fs.readFile(transcript, "utf8")).toBe(source);
  },
);
