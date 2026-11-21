import { vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);
const hookRunnerGlobalStateKey = Symbol.for("openclaw.plugins.hook-runner-global-state");

type HookRunnerGlobalStateForTest = {
  hookRunner: unknown;
  registry: unknown;
};

export function setHookRunnerForTest(hookRunner: unknown): void {
  // Keep the module-level hook runner singleton aligned with the mocked getter.
  mockGetGlobalHookRunner.mockReturnValue(hookRunner as never);
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = (globalStore[hookRunnerGlobalStateKey] as
    | HookRunnerGlobalStateForTest
    | undefined) ?? {
    hookRunner: null,
    registry: null,
  };
  state.hookRunner = hookRunner;
  state.registry = null;
  globalStore[hookRunnerGlobalStateKey] = state;
}

export function createLifecycleHooks(
  hooks: string[],
  onAgentEnd: () => Promise<void> = async () => {},
) {
  const hookRunner = {
    hasHooks: vi.fn((hookName: string) => hooks.includes(hookName)),
    runLlmInput: vi.fn(async () => undefined),
    runLlmOutput: vi.fn(async () => undefined),
    runAgentEnd: vi.fn(onAgentEnd),
  };
  setHookRunnerForTest(hookRunner);
  return hookRunner;
}
