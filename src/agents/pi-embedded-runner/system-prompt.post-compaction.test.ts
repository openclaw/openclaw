import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "../system-prompt.js";

describe("Task Ledger section", () => {
  it("includes the Task Ledger section in full prompt mode", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("## Task Ledger (TASKS.md)");
  });

  it("describes the task format with required fields", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("**Status:**");
    expect(prompt).toContain("**Started:**");
    expect(prompt).toContain("**Updated:**");
    expect(prompt).toContain("**Current Step:**");
  });

  it("mentions stale task archival by sleep cycle", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toContain("sleep cycle");
    expect(prompt).toContain(">24h");
  });

  it("omits the section in minimal (subagent) prompt mode", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "minimal",
    });

    expect(prompt).not.toContain("## Task Ledger (TASKS.md)");
  });

  it("omits the section in none prompt mode", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      promptMode: "none",
    });

    expect(prompt).not.toContain("## Task Ledger (TASKS.md)");
  });
});

describe("Post-Compaction Recovery", () => {
  it("does NOT include a static recovery section (handled by framework injection)", () => {
    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });

    // Recovery instructions are injected dynamically via post-compaction-recovery.ts,
    // not baked into the system prompt (avoids wasting tokens on every turn).
    expect(prompt).not.toContain("## Post-Compaction Recovery");
  });
});
