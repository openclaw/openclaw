import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  AUDIENCE_CHILD_KEY,
  AUDIENCE_ROOT_KEY,
  withChildAudience,
} from "../plugins/memory-provider-runtime.audience.test-support.js";
import { runPreparedCliAgent } from "./cli-runner.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";

const { executePreparedCliRunMock } = vi.hoisted(() => ({
  executePreparedCliRunMock: vi.fn(),
}));

// mock-isolation: the turn's hook context is the subject; no CLI process starts.
vi.mock("./cli-runner/execute.runtime.js", () => ({
  executePreparedCliRun: executePreparedCliRunMock,
}));

// mock-isolation: each case installs its own hook runner to observe the hook context.
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

const getGlobalHookRunnerMock = vi.mocked(getGlobalHookRunner);

afterEach(() => {
  executePreparedCliRunMock.mockReset();
  getGlobalHookRunnerMock.mockReset();
});

function hookRunnerFor(...hookNames: string[]) {
  return {
    hasHooks: vi.fn((hookName: string) => hookNames.includes(hookName)),
    runLlmInput: vi.fn(async (_event: unknown, _ctx: unknown) => undefined),
    runAgentEnd: vi.fn(async (_event: unknown, _ctx: unknown) => undefined),
  };
}

type HookCtx = {
  memoryAudience?: unknown;
  assertMemoryAudienceCurrent?: () => void;
};

describe("runPreparedCliAgent memory audience", () => {
  it("gives CLI turn hooks the host-minted audience and its currency check", async () => {
    await withChildAudience(true, async ({ audience, root, write }) => {
      const hookRunner = hookRunnerFor("llm_input", "agent_end");
      getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);
      executePreparedCliRunMock.mockResolvedValue({ text: "done", rawText: "done" });
      const context = buildPreparedCliRunContext({
        sessionKey: AUDIENCE_CHILD_KEY,
        agentId: "main",
      });
      context.memoryAudience = audience;

      await runPreparedCliAgent(context);

      expect(hookRunner.runLlmInput).toHaveBeenCalledOnce();
      expect(hookRunner.runAgentEnd).toHaveBeenCalledOnce();
      const contexts = [
        hookRunner.runLlmInput.mock.calls[0]?.[1] as HookCtx,
        hookRunner.runAgentEnd.mock.calls[0]?.[1] as HookCtx,
      ];
      for (const ctx of contexts) {
        expect(ctx.memoryAudience).toBe(audience);
        expect(() => ctx.assertMemoryAudienceCurrent?.()).not.toThrow();
      }
      // The guard revalidates the lineage at call time, as on embedded turns.
      write(AUDIENCE_ROOT_KEY, { ...root, lifecycleRevision: randomUUID(), updatedAt: 2 });
      for (const ctx of contexts) {
        expect(() => ctx.assertMemoryAudienceCurrent?.()).toThrow(
          "memory audience is no longer current",
        );
      }
    });
  });

  it("gives hooks no audience when the turn resolved none", async () => {
    const hookRunner = hookRunnerFor("agent_end");
    getGlobalHookRunnerMock.mockReturnValue(hookRunner as never);
    executePreparedCliRunMock.mockResolvedValue({ text: "done", rawText: "done" });

    await runPreparedCliAgent(buildPreparedCliRunContext({ sessionKey: AUDIENCE_CHILD_KEY }));

    const ctx = hookRunner.runAgentEnd.mock.calls[0]?.[1] as HookCtx;
    expect(ctx).not.toHaveProperty("memoryAudience");
    expect(ctx).not.toHaveProperty("assertMemoryAudienceCurrent");
  });
});
