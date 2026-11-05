import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
/**
 * Cross-workspace prompt cache proof test.
 *
 * This test demonstrates that agents with identical context files in separate
 * workspaces produce byte-identical system prompt prefixes before the cache boundary,
 * enabling provider prompt cache reuse.
 *
 * Run with: pnpm test src/agents/cross-workspace-prompt-cache.test.ts
 */
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("Cross-workspace prompt cache sharing", () => {
  it("produces byte-identical prefixes for separate workspaces with identical context files", async () => {
    // Create two temporary workspaces with identical context files
    const workspaceA = path.resolve(".tmp/ws-a");
    const workspaceB = path.resolve(".tmp/ws-b");

    await fs.mkdir(workspaceA, { recursive: true });
    await fs.mkdir(workspaceB, { recursive: true });

    const contextFiles = [
      { name: "AGENTS.md", content: "# Agent Instructions\n\nYou are a helpful assistant." },
      { name: "SOUL.md", content: "# Soul\n\nHelpful and concise." },
      { name: "IDENTITY.md", content: "# Identity\n\nTestAgent v1.0" },
    ];

    for (const file of contextFiles) {
      await fs.writeFile(path.join(workspaceA, file.name), file.content);
      await fs.writeFile(path.join(workspaceB, file.name), file.content);
    }

    // Load context files with absolute paths
    const loadContextFiles = async (wsDir: string) => {
      return contextFiles.map((f) => ({
        path: path.join(wsDir, f.name),
        content: f.content,
      }));
    };

    const contextFilesA = await loadContextFiles(workspaceA);
    const contextFilesB = await loadContextFiles(workspaceB);

    // Build system prompts for both workspaces
    const promptA = buildAgentSystemPrompt({
      workspaceDir: workspaceA,
      contextFiles: contextFilesA,
      agentId: "test",
      agentSessionKey: "agent:test:test",
    });

    const promptB = buildAgentSystemPrompt({
      workspaceDir: workspaceB,
      contextFiles: contextFilesB,
      agentId: "test",
      agentSessionKey: "agent:test:test",
    });

    // Split at cache boundary
    const [prefixA, suffixA] = promptA.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const [prefixB, suffixB] = promptB.split(SYSTEM_PROMPT_CACHE_BOUNDARY);

    // === KEY ASSERTION: Prefixes are byte-identical ===
    expect(prefixA).toBe(prefixB);
    expect(prefixA.length).toBeGreaterThan(0);

    // === Verify prefix contains relative headings (no absolute paths) ===
    expect(prefixA).toContain("## AGENTS.md");
    expect(prefixA).toContain("## SOUL.md");
    expect(prefixA).toContain("## IDENTITY.md");
    expect(prefixA).not.toContain(workspaceA);
    expect(prefixA).not.toContain(workspaceB);

    // === Verify suffix contains per-workspace absolute paths ===
    expect(suffixA).toContain("Working directory:");
    expect(suffixA).toContain(workspaceA);
    expect(suffixB).toContain("Working directory:");
    expect(suffixB).toContain(workspaceB);
    expect(suffixA).not.toBe(suffixB); // Suffixes differ as expected

    // Cleanup
    await fs.rm(workspaceA, { recursive: true, force: true });
    await fs.rm(workspaceB, { recursive: true, force: true });
  }, 30_000);

  it("simulates provider request payloads showing identical cached prefixes", async () => {
    // This simulates what a provider transport would see
    const workspaceA = path.resolve(".tmp/ws-a-provider");
    const workspaceB = path.resolve(".tmp/ws-b-provider");

    await fs.mkdir(workspaceA, { recursive: true });
    await fs.mkdir(workspaceB, { recursive: true });

    const sharedContent = "# Agent Instructions\n\nBe helpful and concise.";

    await fs.writeFile(path.join(workspaceA, "AGENTS.md"), sharedContent);
    await fs.writeFile(path.join(workspaceB, "AGENTS.md"), sharedContent);

    const loadContextFiles = async (wsDir: string) => [
      {
        path: path.join(wsDir, "AGENTS.md"),
        content: sharedContent,
      },
    ];

    const contextFilesA = await loadContextFiles(workspaceA);
    const contextFilesB = await loadContextFiles(workspaceB);

    const promptA = buildAgentSystemPrompt({
      workspaceDir: workspaceA,
      contextFiles: contextFilesA,
      agentId: "test",
      agentSessionKey: "agent:test:test",
    });

    const promptB = buildAgentSystemPrompt({
      workspaceDir: workspaceB,
      contextFiles: contextFilesB,
      agentId: "test",
      agentSessionKey: "agent:test:test",
    });

    // Simulate Anthropic-style payload with cache_control on system prompt
    // (This is what the provider transport would send)
    const [prefixA] = promptA.split(SYSTEM_PROMPT_CACHE_BOUNDARY);
    const [prefixB] = promptB.split(SYSTEM_PROMPT_CACHE_BOUNDARY);

    // Provider request payloads would look like:
    const anthropicPayloadA = {
      model: "claude-3-5-sonnet-20241022",
      system: [
        {
          type: "text",
          text: prefixA,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: promptA.slice(prefixA.length + SYSTEM_PROMPT_CACHE_BOUNDARY.length),
        },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    const anthropicPayloadB = {
      model: "claude-3-5-sonnet-20241022",
      system: [
        {
          type: "text",
          text: prefixB,
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: promptB.slice(prefixB.length + SYSTEM_PROMPT_CACHE_BOUNDARY.length),
        },
      ],
      messages: [{ role: "user", content: "Hello" }],
    };

    // === KEY ASSERTION: Cached portions are identical ===
    expect(anthropicPayloadA.system[0].text).toBe(anthropicPayloadB.system[0].text);
    expect(anthropicPayloadA.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(anthropicPayloadB.system[0].cache_control).toEqual({ type: "ephemeral" });

    // Non-cached portions differ (contain absolute workspace paths)
    expect(anthropicPayloadA.system[1].text).not.toBe(anthropicPayloadB.system[1].text);
    expect(anthropicPayloadA.system[1].text).toContain(workspaceA);
    expect(anthropicPayloadB.system[1].text).toContain(workspaceB);

    // Cleanup
    await fs.rm(workspaceA, { recursive: true, force: true });
    await fs.rm(workspaceB, { recursive: true, force: true });
  }, 30_000);
});
