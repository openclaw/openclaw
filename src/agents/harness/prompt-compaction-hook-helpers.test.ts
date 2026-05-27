import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { resolveAgentHarnessBeforePromptBuildResult } from "./prompt-compaction-hook-helpers.js";

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

function mockHookRunner(result: { prependSystemContext?: string; appendSystemContext?: string }) {
  const runner = {
    hasHooks: vi.fn((name: string) => name === "before_prompt_build"),
    runBeforePromptBuild: vi.fn(async () => result),
    runBeforeAgentStart: vi.fn(),
  } as unknown as NonNullable<ReturnType<typeof getGlobalHookRunner>>;
  mockGetGlobalHookRunner.mockReturnValue(runner);
  return runner;
}

describe("resolveAgentHarnessBeforePromptBuildResult", () => {
  beforeEach(() => {
    mockGetGlobalHookRunner.mockReset();
    mockGetGlobalHookRunner.mockReturnValue(null);
  });

  it("frames plugin system context separately from base developer instructions", async () => {
    mockHookRunner({
      appendSystemContext: "## My Custom Rules\n\nFoo bar baz.",
    });

    const result = await resolveAgentHarnessBeforePromptBuildResult({
      prompt: "hello",
      developerInstructions: "## TOOLS.md\n\n## Workspace Heading\n\nWorkspace guidance.",
      messages: [],
      ctx: { runId: "run-1" },
    });

    expect(result.prompt).toBe("hello");
    expect(result.developerInstructions).toContain("## TOOLS.md");
    expect(result.developerInstructions).toContain("# OpenClaw Plugin System Context");
    expect(result.developerInstructions).toContain(
      "They are not part of any workspace file or project document.",
    );
    expect(result.developerInstructions).toContain(
      "Workspace guidance.\n\n---\n# OpenClaw Plugin System Context",
    );
    expect(result.developerInstructions).toContain("## My Custom Rules\n\nFoo bar baz.");
  });
});
