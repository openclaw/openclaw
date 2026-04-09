import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendNarrativeEntry,
  buildDiaryEntry,
  buildNarrativePrompt,
  extractNarrativeText,
  formatNarrativeDate,
  generateAndAppendDreamNarrative,
  type NarrativePhaseData,
} from "./dreaming-narrative.js";

const tempDirs: string[] = [];

async function createTempWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dreaming-narrative-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("buildNarrativePrompt", () => {
  it("builds a prompt from snippets only", () => {
    const data: NarrativePhaseData = {
      phase: "light",
      snippets: ["user prefers dark mode", "API key rotation scheduled"],
    };
    const prompt = buildNarrativePrompt(data);
    expect(prompt).toContain("user prefers dark mode");
    expect(prompt).toContain("API key rotation scheduled");
    expect(prompt).not.toContain("Recurring themes");
  });

  it("includes themes when provided", () => {
    const data: NarrativePhaseData = {
      phase: "rem",
      snippets: ["config migration path"],
      themes: ["infrastructure", "deployment"],
    };
    const prompt = buildNarrativePrompt(data);
    expect(prompt).toContain("Recurring themes");
    expect(prompt).toContain("infrastructure");
    expect(prompt).toContain("deployment");
  });

  it("includes promotions for deep phase", () => {
    const data: NarrativePhaseData = {
      phase: "deep",
      snippets: ["trading bot uses bracket orders"],
      promotions: ["always use stop-loss on options trades"],
    };
    const prompt = buildNarrativePrompt(data);
    expect(prompt).toContain("crystallized");
    expect(prompt).toContain("always use stop-loss on options trades");
  });

  it("caps snippets at 12", () => {
    const snippets = Array.from({ length: 20 }, (_, i) => `snippet-${i}`);
    const prompt = buildNarrativePrompt({ phase: "light", snippets });
    expect(prompt).toContain("snippet-11");
    expect(prompt).not.toContain("snippet-12");
  });
});

describe("extractNarrativeText", () => {
  it("extracts string content from assistant message", () => {
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "The workspace hummed quietly." },
    ];
    expect(extractNarrativeText(messages)).toBe("The workspace hummed quietly.");
  });

  it("extracts from content array with text blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "First paragraph." },
          { type: "text", text: "Second paragraph." },
        ],
      },
    ];
    expect(extractNarrativeText(messages)).toBe("First paragraph.\nSecond paragraph.");
  });

  it("returns null when no assistant message exists", () => {
    const messages = [{ role: "user", content: "hello" }];
    expect(extractNarrativeText(messages)).toBeNull();
  });

  it("returns null for empty assistant content", () => {
    const messages = [{ role: "assistant", content: "   " }];
    expect(extractNarrativeText(messages)).toBeNull();
  });

  it("picks the last assistant message", () => {
    const messages = [
      { role: "assistant", content: "First response." },
      { role: "user", content: "more" },
      { role: "assistant", content: "Final response." },
    ];
    expect(extractNarrativeText(messages)).toBe("Final response.");
  });
});

describe("formatNarrativeDate", () => {
  it("formats a UTC date", () => {
    const date = formatNarrativeDate(Date.parse("2026-04-05T03:00:00Z"), "UTC");
    expect(date).toContain("April");
    expect(date).toContain("2026");
    expect(date).toContain("3:00");
  });
});

describe("buildDiaryEntry", () => {
  it("formats narrative with date and separators", () => {
    const entry = buildDiaryEntry("The code drifted gently.", "April 5, 2026, 3:00 AM");
    expect(entry).toContain("---");
    expect(entry).toContain("*April 5, 2026, 3:00 AM*");
    expect(entry).toContain("The code drifted gently.");
  });
});

describe("appendNarrativeEntry", () => {
  it("creates DREAMS.md with diary header on fresh workspace", async () => {
    const workspaceDir = await createTempWorkspace();
    const dreamsPath = await appendNarrativeEntry({
      workspaceDir,
      narrative: "Fragments of authentication logic kept surfacing.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    expect(dreamsPath).toBe(path.join(workspaceDir, "DREAMS.md"));
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("# Dream Diary");
    expect(content).toContain("Fragments of authentication logic kept surfacing.");
    expect(content).toContain("<!-- openclaw:dreaming:diary:start -->");
    expect(content).toContain("<!-- openclaw:dreaming:diary:end -->");
  });

  it("appends a second entry within the diary markers", async () => {
    const workspaceDir = await createTempWorkspace();
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "First dream.",
      nowMs: Date.parse("2026-04-04T03:00:00Z"),
      timezone: "UTC",
    });
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "Second dream.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("First dream.");
    expect(content).toContain("Second dream.");
    // Both entries should be between start and end markers.
    const start = content.indexOf("<!-- openclaw:dreaming:diary:start -->");
    const end = content.indexOf("<!-- openclaw:dreaming:diary:end -->");
    const firstIdx = content.indexOf("First dream.");
    const secondIdx = content.indexOf("Second dream.");
    expect(firstIdx).toBeGreaterThan(start);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(secondIdx).toBeLessThan(end);
  });

  it("prepends diary before existing managed blocks", async () => {
    const workspaceDir = await createTempWorkspace();
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      "## Light Sleep\n<!-- openclaw:dreaming:light:start -->\n- Candidate: test\n<!-- openclaw:dreaming:light:end -->\n",
      "utf-8",
    );
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "The workspace was quiet tonight.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    const content = await fs.readFile(dreamsPath, "utf-8");
    const diaryIdx = content.indexOf("# Dream Diary");
    const lightIdx = content.indexOf("## Light Sleep");
    // Diary should come before the managed block.
    expect(diaryIdx).toBeLessThan(lightIdx);
    expect(content).toContain("The workspace was quiet tonight.");
  });

  it("reuses existing dreams file when present", async () => {
    const workspaceDir = await createTempWorkspace();
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(dreamsPath, "# Existing\n", "utf-8");
    const result = await appendNarrativeEntry({
      workspaceDir,
      narrative: "Appended dream.",
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
    });
    expect(result).toBe(dreamsPath);
    const content = await fs.readFile(dreamsPath, "utf-8");
    expect(content).toContain("Appended dream.");
    // Original content should still be there, after the diary.
    expect(content).toContain("# Existing");
  });
});

describe("generateAndAppendDreamNarrative", () => {
  function createMockSubagent(responseText: string) {
    return {
      run: vi.fn().mockResolvedValue({ runId: "run-123" }),
      waitForRun: vi.fn().mockResolvedValue({ status: "ok" }),
      getSessionMessages: vi.fn().mockResolvedValue({
        messages: [
          { role: "user", content: "prompt" },
          { role: "assistant", content: responseText },
        ],
      }),
      deleteSession: vi.fn().mockResolvedValue(undefined),
    };
  }

  function createMockLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }

  it("generates narrative and writes diary entry", async () => {
    const workspaceDir = await createTempWorkspace();
    const subagent = createMockSubagent("The repository whispered of forgotten endpoints.");
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: {
        phase: "light",
        snippets: ["API endpoints need authentication"],
      },
      nowMs: Date.parse("2026-04-05T03:00:00Z"),
      timezone: "UTC",
      logger,
    });

    expect(subagent.run).toHaveBeenCalledOnce();
    expect(subagent.run.mock.calls[0][0]).toMatchObject({
      deliver: false,
    });
    expect(subagent.waitForRun).toHaveBeenCalledOnce();
    expect(subagent.deleteSession).toHaveBeenCalledOnce();

    const content = await fs.readFile(path.join(workspaceDir, "DREAMS.md"), "utf-8");
    expect(content).toContain("The repository whispered of forgotten endpoints.");
    expect(logger.info).toHaveBeenCalled();
  });

  it("skips narrative when no snippets are available", async () => {
    const workspaceDir = await createTempWorkspace();
    const subagent = createMockSubagent("Should not appear.");
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: [] },
      logger,
    });

    expect(subagent.run).not.toHaveBeenCalled();
    const exists = await fs
      .access(path.join(workspaceDir, "DREAMS.md"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("handles subagent timeout gracefully", async () => {
    const workspaceDir = await createTempWorkspace();
    const subagent = createMockSubagent("");
    subagent.waitForRun.mockResolvedValue({ status: "timeout" });
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "deep", snippets: ["some memory"] },
      logger,
    });

    // Should not throw, should warn.
    expect(logger.warn).toHaveBeenCalled();
    const exists = await fs
      .access(path.join(workspaceDir, "DREAMS.md"))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it("handles subagent error gracefully", async () => {
    const workspaceDir = await createTempWorkspace();
    const subagent = createMockSubagent("");
    subagent.run.mockRejectedValue(new Error("connection failed"));
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "rem", snippets: ["pattern surfaced"] },
      logger,
    });

    // Should not throw.
    expect(logger.warn).toHaveBeenCalled();
  });

  it("cleans up session even on failure", async () => {
    const workspaceDir = await createTempWorkspace();
    const subagent = createMockSubagent("");
    subagent.getSessionMessages.mockRejectedValue(new Error("fetch failed"));
    const logger = createMockLogger();

    await generateAndAppendDreamNarrative({
      subagent,
      workspaceDir,
      data: { phase: "light", snippets: ["memory fragment"] },
      logger,
    });

    expect(subagent.deleteSession).toHaveBeenCalled();
  });
});
