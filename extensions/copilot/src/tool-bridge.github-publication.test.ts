import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createCopilotToolBridge } from "./tool-bridge.test-support.js";

describe("Copilot GitHub publication tools", () => {
  it.each([
    { profile: "coding", expected: ["github_identity_status", "github_publish"] },
    { profile: "messaging", expected: [] },
  ] as const)(
    "filters host-prepared GitHub tools for the $profile profile",
    async ({ profile, expected }) => {
      await withTempDir("openclaw-copilot-github-tools-", async (workspaceDir) => {
        const attempt: Parameters<typeof createAgentHarnessHostCapabilitiesForTest>[0]["attempt"] =
          {
            agentId: "main",
            sessionId: "session-1",
            sessionKey: "agent:main:session-1",
            runId: "copilot-github-tools",
            workspaceDir,
            model: {
              id: "gpt-4o",
              name: "GPT-4o",
              api: "openai-completions",
              provider: "github-copilot",
              baseUrl: "https://example.com",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 4_096,
            },
            config: { tools: { profile } },
            githubPublicationAvailable: true,
          };
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt,
          pluginId: "copilot",
        });
        let bridge: Awaited<ReturnType<typeof createCopilotToolBridge>> | undefined;
        try {
          bridge = await createCopilotToolBridge({
            agentId: "main",
            workspaceDir,
            attemptParams: { ...attempt, hostCapabilities: host.capabilities },
          });
          const tools = bridge.promptToolPolicy.apply().callableToolNames;
          expect(tools.filter((name) => name.startsWith("github_"))).toEqual(expected);
        } finally {
          bridge?.cleanup?.();
          host.close();
        }
      });
    },
  );
});
