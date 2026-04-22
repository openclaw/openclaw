import { describe, expect, it, vi } from "vitest";
import type { PluginHookAgentContext } from "../../plugins/types.js";
import {
  applyPromptBuildHookToSystemPrompt,
  resolveCliPromptBuildHook,
  type CliPromptBuildHookRunner,
} from "./prompt-build-hook.js";

const HOOK_CTX: PluginHookAgentContext = {
  runId: "run-1",
  agentId: "agent-1",
  sessionKey: "session-1",
  sessionId: "session-id-1",
  workspaceDir: "/tmp/ws",
  modelProviderId: "claude",
  modelId: "claude/default",
  messageProvider: "test",
};

function makeRunner(overrides: Partial<CliPromptBuildHookRunner> = {}): CliPromptBuildHookRunner {
  return {
    hasHooks: vi.fn(() => false),
    runBeforePromptBuild: vi.fn(async () => undefined),
    runBeforeAgentStart: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("resolveCliPromptBuildHook", () => {
  it("returns an empty-shape result when no hooks are registered", async () => {
    const runner = makeRunner();
    const result = await resolveCliPromptBuildHook({
      prompt: "hello",
      hookCtx: HOOK_CTX,
      hookRunner: runner,
    });
    expect(result).toEqual({
      systemPrompt: undefined,
      prependContext: undefined,
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
    expect(runner.runBeforePromptBuild).not.toHaveBeenCalled();
    expect(runner.runBeforeAgentStart).not.toHaveBeenCalled();
  });

  it("surfaces before_prompt_build result fields verbatim", async () => {
    const runBeforePromptBuild = vi.fn(async () => ({
      systemPrompt: "override-system",
      prependContext: "prompt context",
      prependSystemContext: "prompt prepend",
      appendSystemContext: "prompt append",
    }));
    const runner = makeRunner({
      hasHooks: vi.fn((name) => name === "before_prompt_build"),
      runBeforePromptBuild,
    });

    const result = await resolveCliPromptBuildHook({
      prompt: "hello",
      hookCtx: HOOK_CTX,
      hookRunner: runner,
    });

    expect(runBeforePromptBuild).toHaveBeenCalledWith({ prompt: "hello", messages: [] }, HOOK_CTX);
    expect(result).toEqual({
      systemPrompt: "override-system",
      prependContext: "prompt context",
      prependSystemContext: "prompt prepend",
      appendSystemContext: "prompt append",
    });
    expect(runner.runBeforeAgentStart).not.toHaveBeenCalled();
  });

  it("falls back to before_agent_start when before_prompt_build isn't registered", async () => {
    const runBeforeAgentStart = vi.fn(async () => ({
      systemPrompt: "legacy-system",
      prependContext: "legacy context",
    }));
    const runner = makeRunner({
      hasHooks: vi.fn((name) => name === "before_agent_start"),
      runBeforeAgentStart,
    });

    const result = await resolveCliPromptBuildHook({
      prompt: "hello",
      hookCtx: HOOK_CTX,
      hookRunner: runner,
    });

    expect(runner.runBeforePromptBuild).not.toHaveBeenCalled();
    expect(runBeforeAgentStart).toHaveBeenCalledTimes(1);
    expect(result.systemPrompt).toBe("legacy-system");
    expect(result.prependContext).toBe("legacy context");
  });

  it("merges prompt-build and legacy fields deterministically when both are present", async () => {
    const runner = makeRunner({
      hasHooks: vi.fn(() => true),
      runBeforePromptBuild: vi.fn(async () => ({
        prependContext: "prompt context",
        prependSystemContext: "prompt prepend",
        appendSystemContext: "prompt append",
      })),
      runBeforeAgentStart: vi.fn(async () => ({
        prependContext: "legacy context",
        prependSystemContext: "legacy prepend",
        appendSystemContext: "legacy append",
      })),
    });

    const result = await resolveCliPromptBuildHook({
      prompt: "hello",
      hookCtx: HOOK_CTX,
      hookRunner: runner,
    });

    expect(result.prependContext).toBe("prompt context\n\nlegacy context");
    expect(result.prependSystemContext).toBe("prompt prepend\n\nlegacy prepend");
    expect(result.appendSystemContext).toBe("prompt append\n\nlegacy append");
  });

  it("swallows errors and returns empty shape when a hook throws", async () => {
    const runner = makeRunner({
      hasHooks: vi.fn((name) => name === "before_prompt_build"),
      runBeforePromptBuild: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const result = await resolveCliPromptBuildHook({
      prompt: "hello",
      hookCtx: HOOK_CTX,
      hookRunner: runner,
    });

    expect(result.systemPrompt).toBeUndefined();
    expect(result.prependContext).toBeUndefined();
  });

  it("is a no-op when hookRunner is null", async () => {
    const result = await resolveCliPromptBuildHook({
      prompt: "hello",
      hookCtx: HOOK_CTX,
      hookRunner: null,
    });
    expect(result).toEqual({
      systemPrompt: undefined,
      prependContext: undefined,
      prependSystemContext: undefined,
      appendSystemContext: undefined,
    });
  });
});

describe("applyPromptBuildHookToSystemPrompt", () => {
  it("returns the base system prompt when the hook is empty", () => {
    expect(
      applyPromptBuildHookToSystemPrompt({
        systemPrompt: "base",
        hookResult: {},
      }),
    ).toBe("base");
  });

  it("replaces the base prompt when systemPrompt override is present", () => {
    expect(
      applyPromptBuildHookToSystemPrompt({
        systemPrompt: "base",
        hookResult: { systemPrompt: "override" },
      }),
    ).toBe("override");
  });

  it("prepends and appends around the chosen base (override takes precedence)", () => {
    expect(
      applyPromptBuildHookToSystemPrompt({
        systemPrompt: "base",
        hookResult: {
          systemPrompt: "override",
          prependSystemContext: "PRE",
          appendSystemContext: "POST",
        },
      }),
    ).toBe("PRE\n\noverride\n\nPOST");
  });

  it("prepends and appends around the original base when no override is given", () => {
    expect(
      applyPromptBuildHookToSystemPrompt({
        systemPrompt: "base",
        hookResult: {
          prependSystemContext: "PRE",
          appendSystemContext: "POST",
        },
      }),
    ).toBe("PRE\n\nbase\n\nPOST");
  });
});
