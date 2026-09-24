import path from "node:path";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createAgentHarnessHostCapabilitiesForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createCopilotToolBridge } from "./tool-bridge.js";

describe("Copilot GitHub publication tools", () => {
  it.each([
    { available: undefined, profile: "coding", expected: [] },
    { available: false, profile: "coding", expected: ["github_identity_status"] },
    { available: true, profile: "coding", expected: ["github_identity_status", "github_publish"] },
    { available: true, profile: "messaging", expected: [] },
  ] as const)(
    "exposes host-prepared GitHub tools: $available / $profile",
    async ({ available, profile, expected }) => {
      await withTempDir("openclaw-copilot-github-tools-", async (workspaceDir) => {
        const authStorage = AuthStorage.inMemory();
        const attempt: Parameters<typeof createAgentHarnessHostCapabilitiesForTest>[0]["attempt"] =
          {
            agentId: "main",
            sessionId: "session-1",
            sessionKey: "agent:main:session-1",
            sessionFile: path.join(workspaceDir, "session.jsonl"),
            runId: "copilot-github-tools",
            workspaceDir,
            prompt: "Inspect the repository",
            timeoutMs: 5_000,
            provider: "github-copilot",
            modelId: "gpt-4o",
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
            thinkLevel: "off",
            authStorage,
            modelRegistry: ModelRegistry.inMemory(authStorage),
            authProfileStore: { version: 1, profiles: {} },
            config: { tools: { profile } },
            githubPublicationAvailable: available,
          };
        const host = await createAgentHarnessHostCapabilitiesForTest({
          attempt,
          pluginId: "copilot",
        });
        let bridge: Awaited<ReturnType<typeof createCopilotToolBridge>> | undefined;
        try {
          bridge = await createCopilotToolBridge({
            agentId: "main",
            sessionId: "session-1",
            modelId: "gpt-4o",
            modelProvider: "github-copilot",
            spawnWorkspaceDir: undefined,
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
