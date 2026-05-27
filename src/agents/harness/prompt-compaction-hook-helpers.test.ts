/**
 * Regression test for #87045: plugin-injected system context lacked a
 * boundary marker, so a workspace-files block followed by an
 * `appendSystemContext` block produced Markdown headings the model
 * attributed back to the last workspace file (e.g. `TOOLS.md`).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-helpers.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

const PLUGIN_BOUNDARY = "[plugin-injected context — not a workspace file]";

afterEach(() => {
  resetGlobalHookRunner();
});

function makeCtx() {
  return {
    runId: "run-1",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    workspaceDir: "/workspace",
  } as never;
}

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  it("wraps plugin-emitted system-context segments with a boundary marker", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => ({
            appendSystemContext: "## My Custom Rules\n\nFoo bar baz.",
            prependSystemContext: "## Prep Rules\n\nQux quux.",
          }),
        },
      ]) as never,
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "user prompt",
      developerInstructions: "### /workspace/TOOLS.md\n\n## Formato por Canal\n\nbody.",
      messages: [],
      ctx: makeCtx(),
    });

    const before = result.developerInstructions.indexOf("## Prep Rules");
    const between = result.developerInstructions.indexOf("### /workspace/TOOLS.md");
    const after = result.developerInstructions.indexOf("## My Custom Rules");
    expect(before).toBeGreaterThanOrEqual(0);
    expect(between).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(between);

    // Boundary marker must appear immediately around each plugin segment, not
    // around the workspace-files block itself.
    const boundaryCount = result.developerInstructions.split(PLUGIN_BOUNDARY).length - 1;
    // 2 plugin segments × 2 boundary occurrences (open + close) = 4.
    expect(boundaryCount).toBe(4);

    // The boundary must sit *between* the workspace files and the appended
    // plugin context so the heading hierarchy is reset.
    const boundaryBeforeAppend = result.developerInstructions.lastIndexOf(PLUGIN_BOUNDARY, after);
    expect(boundaryBeforeAppend).toBeGreaterThan(between);
    expect(boundaryBeforeAppend).toBeLessThan(after);
  });

  it("leaves prompt and system prompt untouched when no plugin segments are returned", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_prompt_build",
          handler: () => ({}),
        },
      ]) as never,
    );

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "user prompt",
      developerInstructions: "system",
      messages: [],
      ctx: makeCtx(),
    });

    expect(result.developerInstructions).toBe("system");
    expect(result.developerInstructions.includes(PLUGIN_BOUNDARY)).toBe(false);
    expect(result.prompt).toBe("user prompt");
  });
});
