// Covers the CLI-side before_model_resolve emission through the exported run seam:
// same-backend overrides are applied, cross-runtime and provider-only overrides are
// rejected with the caller selection kept, and locked selections skip hooks.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { applyCliModelResolveHookForRun } from "./model-resolve-hook.js";

const hookRunnerStub = vi.hoisted(() => ({
  hasHooks: vi.fn<(hookName: string) => boolean>(() => false),
  runBeforeModelResolve: vi.fn(
    async (
      _event: { prompt: string },
      _ctx: { modelProviderId?: string; channelId?: string; accountId?: string },
    ) => undefined as { providerOverride?: string; modelOverride?: string } | undefined,
  ),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunnerStub,
}));

function stubHookRunner(params: {
  hasBeforeModelResolve?: boolean;
  override?: { providerOverride?: string; modelOverride?: string };
}): void {
  vi.clearAllMocks();
  hookRunnerStub.hasHooks.mockImplementation(() => params.hasBeforeModelResolve ?? false);
  hookRunnerStub.runBeforeModelResolve.mockImplementation(async () => params.override);
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

const BASE_PARAMS = {
  prompt: "hello",
  provider: "claude-cli",
  modelProvider: "anthropic",
  model: "claude-opus-5-5",
  sessionFile: "/tmp/workspace/session.jsonl",
  sessionId: "session-1",
  workspaceDir: "/tmp/workspace",
  config: CLI_CONFIG,
};

function runTurn(overrides: Record<string, unknown> = {}): Promise<void> {
  return applyCliModelResolveHookForRun({
    ...BASE_PARAMS,
    ...overrides,
  } as Parameters<typeof applyCliModelResolveHookForRun>[0]);
}

describe("applyCliModelResolveHookForRun", () => {
  it("returns the caller selection untouched when no hook is registered", async () => {
    stubHookRunner({ hasBeforeModelResolve: false });
    const params = { ...BASE_PARAMS };
    await applyCliModelResolveHookForRun(
      params as Parameters<typeof applyCliModelResolveHookForRun>[0],
    );
    expect(params.model).toBe("claude-opus-5-5");
    expect(hookRunnerStub.runBeforeModelResolve).not.toHaveBeenCalled();
  });

  it("applies a same-backend override to the CLI child model", async () => {
    stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    const params = { ...BASE_PARAMS };
    await applyCliModelResolveHookForRun(
      params as Parameters<typeof applyCliModelResolveHookForRun>[0],
    );
    expect(params.model).toBe("claude-sonnet-5");
    expect(hookRunnerStub.runBeforeModelResolve).toHaveBeenCalledTimes(1);
  });

  it("rejects a cross-runtime override and keeps the caller selection", async () => {
    stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "openai", modelOverride: "gpt-5.6" },
    });
    const params = { ...BASE_PARAMS };
    await applyCliModelResolveHookForRun(
      params as Parameters<typeof applyCliModelResolveHookForRun>[0],
    );
    expect(params.model).toBe("claude-opus-5-5");
  });

  it("keeps the caller selection when a provider-only override leaves the logical provider", async () => {
    stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "openai", modelOverride: "claude-opus-5-5" },
    });
    const params = { ...BASE_PARAMS };
    await applyCliModelResolveHookForRun(
      params as Parameters<typeof applyCliModelResolveHookForRun>[0],
    );
    expect(params.model).toBe("claude-opus-5-5");
    expect(hookRunnerStub.runBeforeModelResolve).toHaveBeenCalledTimes(1);
  });

  it("reports the logical provider plus channel routing in the hook context", async () => {
    stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    await runTurn({ currentChannelId: "chan-1", agentAccountId: "acct-1" });
    const call = hookRunnerStub.runBeforeModelResolve.mock.calls[0]!;
    expect(call[0]).toEqual({ prompt: "hello" });
    expect(call[1].modelProviderId).toBe("anthropic");
    expect(call[1].channelId).toBe("chan-1");
    expect(call[1].accountId).toBe("acct-1");
  });

  it("passes image-derived attachment metadata on image-bearing turns", async () => {
    stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    await runTurn({
      images: [{ type: "image", data: "aGk=", mimeType: "image/png" }],
    });
    const call = hookRunnerStub.runBeforeModelResolve.mock.calls[0]!;
    expect(call[0]).toEqual({
      prompt: "hello",
      attachments: [{ kind: "image", mimeType: "image/png" }],
    });
    expect(call[1].modelProviderId).toBe("anthropic");
  });

  it("skips the hook entirely when the session locked model selection", async () => {
    stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    const params = {
      ...BASE_PARAMS,
      sessionEntry: { modelSelectionLocked: true },
    };
    await applyCliModelResolveHookForRun(
      params as Parameters<typeof applyCliModelResolveHookForRun>[0],
    );
    expect(params.model).toBe("claude-opus-5-5");
    expect(hookRunnerStub.runBeforeModelResolve).not.toHaveBeenCalled();
  });

  it("keeps the caller selection on synthetic turns without emitting hooks", async () => {
    stubHookRunner({
      hasBeforeModelResolve: true,
      override: { providerOverride: "anthropic", modelOverride: "claude-sonnet-5" },
    });
    const params = { ...BASE_PARAMS, isolatedCompletion: true as const };
    await applyCliModelResolveHookForRun(
      params as Parameters<typeof applyCliModelResolveHookForRun>[0],
    );
    expect(params.model).toBe("claude-opus-5-5");
    expect(hookRunnerStub.runBeforeModelResolve).not.toHaveBeenCalled();
  });
});
