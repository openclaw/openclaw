import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../../plugins/hooks.test-fixtures.js";
import { withPluginRuntimeGenerationRegistryScope } from "../../plugins/runtime/generation-state.js";
import {
  closePluginTestAdmissions,
  createExecution,
  runPlugin,
  SUCCESS_RESULT,
} from "./execute-plugin.test-support.js";

type FinalizeRelay = (stop: { stopHookActive: boolean; lastAssistantMessage?: string }) => unknown;

afterEach(() => {
  resetGlobalHookRunner();
  closePluginTestAdmissions();
});

describe("plugin-owned CLI before_agent_finalize relay", () => {
  it("hands the runtime a relay that runs the hook with the run's identity", async () => {
    const hook = vi.fn(() => ({ action: "revise" as const, reason: "check the tests" }));
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "before_agent_finalize", handler: hook }]),
    );
    const { context } = await createExecution();
    let decision: unknown;
    await runPlugin(context, async function* (execution) {
      const relay = (execution as { runBeforeAgentFinalize?: FinalizeRelay })
        .runBeforeAgentFinalize;
      decision = await relay?.({ stopHookActive: false, lastAssistantMessage: "Done." });
      yield SUCCESS_RESULT;
    });

    expect(decision).toMatchObject({ action: "revise", reason: "check the tests" });
    expect(hook).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: context.params.runId,
        sessionId: context.params.sessionId,
        lastAssistantMessage: "Done.",
      }),
      expect.objectContaining({ runId: context.params.runId }),
    );
  });

  it("passes no relay when no plugin registers the hook", async () => {
    const { context } = await createExecution();
    let relay: unknown = "unset";
    await runPlugin(context, async function* (execution) {
      relay = (execution as { runBeforeAgentFinalize?: unknown }).runBeforeAgentFinalize;
      yield SUCCESS_RESULT;
    });
    expect(relay).toBeUndefined();
  });

  it("runs the admitted turn's handler when a warm transport retains an earlier scope", async () => {
    const oldHook = vi.fn(() => ({ action: "continue" as const }));
    const previous = createMockPluginRegistry([
      { hookName: "before_agent_finalize", handler: oldHook },
    ]);
    const transportScope = withPluginRuntimeGenerationRegistryScope(previous, () =>
      AsyncLocalStorage.snapshot(),
    );
    const current = createMockPluginRegistry([
      {
        hookName: "before_agent_finalize",
        handler: () => ({ action: "revise" as const, reason: "current check" }),
      },
    ]);
    initializeGlobalHookRunner(current);
    const { context } = await createExecution();
    let decision: unknown;
    await withPluginRuntimeGenerationRegistryScope(current, () =>
      runPlugin(context, async function* (execution) {
        const relay = (execution as { runBeforeAgentFinalize?: FinalizeRelay })
          .runBeforeAgentFinalize;
        decision = await transportScope(() => relay?.({ stopHookActive: false }));
        yield SUCCESS_RESULT;
      }),
    );

    expect(decision).toMatchObject({ action: "revise", reason: "current check" });
    expect(oldHook).not.toHaveBeenCalled();
  });
});
