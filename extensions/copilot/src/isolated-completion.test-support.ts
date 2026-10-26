import type { AgentHarness } from "openclaw/plugin-sdk/agent-harness-runtime";

type IsolatedCompletionParams = Parameters<NonNullable<AgentHarness["runIsolatedCompletionV2"]>>[0];

export function createCopilotIsolatedCompletionParams(
  options: Partial<Pick<IsolatedCompletionParams, "timeoutMs" | "thinkLevel">> = {},
) {
  return {
    provider: "github-copilot",
    modelId: "gpt-4.1",
    authorization: {
      owner: "host",
      model: {
        id: "gpt-4.1",
        name: "GPT-4.1",
        api: "openai-responses",
        provider: "github-copilot",
        baseUrl: "https://api.githubcopilot.com",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      },
      auth: {
        apiKey: "prepared-github-token",
        profileId: "github:work",
        source: "profile",
        mode: "oauth",
      },
      sourceAuthFingerprint: "prepared-owner-fingerprint",
    },
    config: {},
    agentId: "test",
    agentDir: "/tmp/agent",
    workspaceDir: "/workspace",
    systemPrompt: "Answer only from the supplied prompt.",
    prompt: "What is two plus two?",
    timeoutMs: 30_000,
    ...options,
  } satisfies IsolatedCompletionParams;
}
