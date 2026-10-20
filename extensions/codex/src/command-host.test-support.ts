import { testCodexAppServerBindingStore } from "./app-server/session-binding.test-helpers.js";
import type { CodexCommandDeps } from "./command-handler-deps.js";

export function createCodexCommandHost(
  overrides: Partial<CodexCommandDeps> = {},
): CodexCommandDeps {
  return {
    bindingStore: testCodexAppServerBindingStore,
    listCodexCliSessionsOnNode: async () => {
      throw new Error("Codex CLI node sessions require Gateway node runtime.");
    },
    resolveCodexCliSessionForBindingOnNode: async () => {
      throw new Error("Codex CLI node sessions require Gateway node runtime.");
    },
    ...overrides,
  };
}
