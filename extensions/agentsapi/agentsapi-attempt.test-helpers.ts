import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createModel } from "./agentsapi.test-support.js";

export function createAttemptParams({
  hostCapabilities,
  ...overrides
}: Omit<Partial<AgentHarnessAttemptParamsV2>, "hostCapabilities"> & {
  hostCapabilities?: Partial<AgentHarnessAttemptParamsV2["hostCapabilities"]>;
} = {}): AgentHarnessAttemptParamsV2 {
  const authStorage = overrides.authStorage ?? AuthStorage.inMemory();
  return {
    sessionId: "local-fixture",
    sessionKey: "agent:main:fixture",
    sessionFile: "/fixture/session.jsonl",
    agentId: "main",
    workspaceDir: "/fixture/project",
    runId: "run-fixture",
    timeoutMs: 1_000,
    prompt: "Fixture prompt",
    provider: "openai",
    modelId: "fixture-model",
    model: createModel(),
    authStorage,
    authProfileStore: { version: 1, profiles: {} },
    modelRegistry: overrides.modelRegistry ?? ModelRegistry.inMemory(authStorage),
    thinkLevel: "off",
    resolvedApiKey: "fixture-not-a-real-api-key",
    hostCapabilities: {
      kind: "agent-harness-host-capability",
      version: 1,
      assertActive: () => {},
      bindToolSurface: (tools) => tools,
      runBeforeToolCall: async ({ params }) => ({ blocked: false, params }),
      requestApproval: async () => undefined,
      waitForApproval: async () => undefined,
      ...hostCapabilities,
    },
    ...overrides,
  };
}
