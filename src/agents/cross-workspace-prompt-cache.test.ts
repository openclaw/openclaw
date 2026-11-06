import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("Cross-workspace prompt cache sharing", () => {
  it("produces byte-identical prefixes for separate workspaces with identical context files", () => {
    const workspaceA = "/tmp/ws-a";
    const workspaceB = "/tmp/ws-b";

    const sharedFiles = [
      { name: "AGENTS.md", content: "# Agent Instructions\n\nYou are a helpful assistant." },
      { name: "SOUL.md", content: "# Soul\n\nHelpful and concise." },
      { name: "IDENTITY.md", content: "# Identity\n\nTestAgent v1.0" },
    ];

    const contextFilesA = sharedFiles.map((f) => ({ path: f.name, content: f.content }));
    const contextFilesB = sharedFiles.map((f) => ({ path: f.name, content: f.content }));

    const promptA = buildAgentSystemPrompt({
      workspaceDir: workspaceA,
      contextFiles: contextFilesA,
    });

    const promptB = buildAgentSystemPrompt({
      workspaceDir: workspaceB,
      contextFiles: contextFilesB,
    });

    const partsA = promptA.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const partsB = promptB.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const prefixA = partsA[0];
    const prefixB = partsB[0];

    expect(prefixA).toBe(prefixB);
    expect(prefixA.length).toBeGreaterThan(0);
    expect(prefixA).toContain("## AGENTS.md");
    expect(prefixA).toContain("## SOUL.md");
    expect(prefixA).toContain("## IDENTITY.md");
    expect(prefixA).not.toContain(workspaceA);
    expect(prefixA).not.toContain(workspaceB);
  });
});
