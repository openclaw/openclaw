import { describe, expect, it, vi } from "vitest";
import { resolveHookModelSelection } from "./setup.js";

describe("resolveHookModelSelection", () => {
  it("extracts hookToolsAllow from before_prompt_build with precedence over legacy before_agent_start", async () => {
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
      hookContext: {},
    });

    expect(result.hookToolsAllow).toEqual(["read", "exec"]);
    expect(result.legacyBeforeAgentStartResult?.toolsAllow).toEqual(["write"]);
    expect(hookRunner.runBeforePromptBuild).toHaveBeenCalledWith(
      { prompt: "hello", messages: [] },
      {},
    );
  });

  it("falls back to legacy before_agent_start toolsAllow when before_prompt_build does not provide one", async () => {
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
      hookContext: {},
    });

    expect(result.hookToolsAllow).toEqual(["read"]);
  });
});
