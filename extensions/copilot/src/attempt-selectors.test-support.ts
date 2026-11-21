import { vi } from "vitest";

type AttemptSelectorOverrides = {
  createToolBridge?: typeof import("./tool-bridge.js").createCopilotToolBridge;
  resolveSandboxContext?: typeof import("openclaw/plugin-sdk/agent-harness-runtime").resolveSandboxContext;
  isHostScopedAgentToolActive?: typeof import("openclaw/plugin-sdk/agent-harness-runtime").isHostScopedAgentToolActive;
};

const overrides = vi.hoisted((): AttemptSelectorOverrides => ({}));

export const copilotAttemptOverrides = overrides;

vi.mock("./tool-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tool-bridge.js")>();
  return {
    ...actual,
    createCopilotToolBridge: (...args: Parameters<typeof actual.createCopilotToolBridge>) =>
      (overrides.createToolBridge ?? actual.createCopilotToolBridge)(...args),
  };
});

export function resetCopilotAttemptOverrides() {
  copilotAttemptOverrides.createToolBridge = undefined;
  copilotAttemptOverrides.resolveSandboxContext = undefined;
  copilotAttemptOverrides.isHostScopedAgentToolActive = undefined;
}
