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
    codexPluginsManagementIo: {
      readConfig: async () => ({}),
      mutate: async () => {
        throw new Error("Codex plugin configuration mutation was not supplied by this test.");
      },
    },
    ...overrides,
  };
}
