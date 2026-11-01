import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";

export type IsolatedParams = Parameters<NonNullable<AgentHarnessV2["runIsolatedCompletionV2"]>>[0];

export function isolatedParams(
  authProfileStore: AuthProfileStore,
  forwardedAuthProfileId: string,
  agentDir = "/tmp/agent",
  workspaceDir = "/tmp/workspace",
): IsolatedParams {
  return {
    authorization: {
      owner: "harness",
      plan: {
        providerForAuth: "openai",
        authProfileProviderForAuth: "openai",
        forwardedAuthProfileId,
        modelRoute: {
          provider: "openai",
          modelId: "gpt-5.4",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
        },
      },
      authProfileStore,
    },
    config: {},
    provider: "openai",
    modelId: "gpt-5.4",
    agentId: "main",
    agentDir,
    workspaceDir,
    systemPrompt: "Name the conversation.",
    prompt: "Help me plan a garden.",
    timeoutMs: 5_000,
  };
}
