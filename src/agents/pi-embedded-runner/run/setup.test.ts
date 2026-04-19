import { describe, expect, it, vi } from "vitest";
import { resolveHookModelSelection } from "./setup.js";

describe("resolveHookModelSelection", () => {
  it("does not call before_prompt_build for early toolsAllow (moved to attempt phase)", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["before_model_resolve", "before_prompt_build", "before_agent_start"].includes(hookName),
      ),
      runBeforeModelResolve: vi.fn(async () => undefined),
      runBeforePromptBuild: vi.fn(async () => ({ toolsAllow: ["read", "exec"] })),
      runBeforeAgentStart: vi.fn(async () => ({ toolsAllow: ["write"] })),
    };

    const result = await resolveHookModelSelection({
      prompt: "hello",
      provider: "openai",
      modelId: "gpt-5",
      hookRunner: hookRunner as never,
      hookContext: { sessionId: "test-session", workspaceDir: "/tmp/test" },
    });

    // before_prompt_build is no longer called in setup — toolsAllow extraction
    // happens in attempt.ts where availableTools is populated
    expect(hookRunner.runBeforePromptBuild).not.toHaveBeenCalled();
    // Legacy before_agent_start toolsAllow still flows through
    expect(result.hookToolsAllow).toEqual(["write"]);
    expect(result.legacyBeforeAgentStartResult?.toolsAllow).toEqual(["write"]);
  });

  it("falls back to legacy before_agent_start toolsAllow", async () => {
    const hookRunner = {
      hasHooks: vi.fn((hookName: string) =>
        ["before_prompt_build", "before_agent_start"].includes(hookName),
      ),
      runBeforePromptBuild: vi.fn(async () => ({ prependContext: "ctx" })),
      runBeforeAgentStart: vi.fn(async () => ({ toolsAllow: ["read"] })),
    };

    const result = await resolveHookModelSelection({
      prompt: "hello",
      provider: "openai",
      modelId: "gpt-5",
      hookRunner: hookRunner as never,
      hookContext: { sessionId: "test-session", workspaceDir: "/tmp/test" },
    });

    expect(result.hookToolsAllow).toEqual(["read"]);
  });
});
