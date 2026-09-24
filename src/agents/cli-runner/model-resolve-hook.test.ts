// Covers the CLI-side before_model_resolve emission: same-backend overrides are
// applied, cross-runtime overrides are rejected, and locked selections skip hooks.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { HookRunner } from "../../plugins/hooks.js";
import { resolveCliModelOverrideForTurn } from "./model-resolve-hook.js";

type HookRunnerStub = Pick<HookRunner, "hasHooks" | "runBeforeModelResolve">;

function stubHookRunner(params: {
  hasBeforeModelResolve?: boolean;
  override?: { providerOverride?: string; modelOverride?: string };
}): HookRunnerStub {
  return {
    hasHooks: vi.fn(() => params.hasBeforeModelResolve ?? false),
    runBeforeModelResolve: vi.fn(async () => params.override),
  };
}

const CLI_CONFIG: OpenClawConfig = {
  agents: {
    defaults: {
      model: "anthropic/claude-opus-5-5",
      models: {
        "anthropic/claude-opus-5-5": { agentRuntime: { id: "claude-cli" } },
        "anthropic/claude-sonnet-5": { agentRuntime: { id: "claude-cli" } },
        "openai/gpt-5.6": { agentRuntime: { id: "openclaw" } },
      },
    },
  },
};

const BASE_INPUT = {
  prompt: "hello",
  executionProvider: "claude-cli",
  logicalProvider: "anthropic",
  modelId: "claude-opus-5-5",
  sessionId: "session-1",
  workspaceDir: "/tmp/workspace",
};

describe("resolveCliModelOverrideForTurn", () => {
  it("returns the caller selection untouched when no hook is registered", async () => {
    const hookRunner = stubHookRunner({ hasBeforeModelResolve: false });
    const outcome = await resolveCliModelOverrideForTurn({ ...BASE_INPUT, hookRunner });
    expect(outcome).toEqual({
      provider: "claude-cli",
      modelId: "claude-opus-5-5",
      applied: false,
    });
  });

  it("applies a same-backend override to the CLI child model", async () => {
    const hookRunner = stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    const outcome = await resolveCliModelOverrideForTurn({
      ...BASE_INPUT,
      config: CLI_CONFIG,
      hookRunner,
    });
    expect(outcome).toEqual({
      provider: "claude-cli",
      modelId: "claude-sonnet-5",
      applied: true,
    });
    expect(hookRunner.runBeforeModelResolve).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-runtime override and keeps the caller selection", async () => {
    const hookRunner = stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "openai", modelOverride: "gpt-5.6" },
    });
    const outcome = await resolveCliModelOverrideForTurn({
      ...BASE_INPUT,
      config: CLI_CONFIG,
      hookRunner,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.rejectedOverride).toEqual({
      provider: "openai",
      modelId: "gpt-5.6",
    });
  });

  it("reports the logical provider in the hook context", async () => {
    const hookRunner = stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    await resolveCliModelOverrideForTurn({
      ...BASE_INPUT,
      config: CLI_CONFIG,
      hookRunner,
    });
    const [event, context] = (hookRunner.runBeforeModelResolve as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(event).toEqual({ prompt: "hello" });
    expect(context.modelProviderId).toBe("anthropic");
  });

  it("skips the hook entirely when the session locked model selection", async () => {
    const hookRunner = stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    const outcome = await resolveCliModelOverrideForTurn({
      ...BASE_INPUT,
      config: CLI_CONFIG,
      hookRunner,
      sessionEntry: { modelSelectionLocked: true } as never,
    });
    expect(outcome.applied).toBe(false);
    expect(hookRunner.runBeforeModelResolve).not.toHaveBeenCalled();
  });
});
