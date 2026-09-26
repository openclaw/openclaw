import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../../../config/config.js";
import type { OpenClawConfig } from "../../../config/types.js";
import type { AssembleResult } from "../../../context-engine/types.js";
import { installDecisionFixture } from "../../agent-hooks/compaction-safeguard-semantic.test-support.js";
import type { AgentMessage } from "../../runtime/index.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const tempPaths: string[] = [];

function sourceMessages(): AgentMessage[] {
  return [
    { role: "user", content: "Keep the pending deployment unchanged.", timestamp: 1 },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
      timestamp: 2,
    }),
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Completed historical check. ".repeat(30) }],
      isError: false,
      timestamp: 3,
    },
    castAgentMessage({
      role: "assistant",
      content: [{ type: "text", text: "The deployment remains pending." }],
      timestamp: 4,
    }),
    { role: "user", content: "Continue without deploying.", timestamp: 5 },
  ];
}

function shadowConfig(kind: "absent" | "agent-disabled"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(kind === "agent-disabled" ? { decisionModel: "semantic-fixture/default-v1" } : {}),
        turnContextCuration: { mode: "shadow", minEstimatedTokens: 1, recentMessages: 2 },
      },
      ...(kind === "agent-disabled" ? { entries: { main: { decisionModel: "" } } } : {}),
    },
  };
}

describe("admitted embedded turn-context shadow eligibility", () => {
  beforeAll(preloadRunEmbeddedAttemptForTests);
  beforeEach(resetEmbeddedAttemptHarness);
  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    { engine: "legacy" as const, eligibility: "absent" as const },
    { engine: "legacy" as const, eligibility: "agent-disabled" as const },
    { engine: "custom" as const, eligibility: "absent" as const },
    { engine: "custom" as const, eligibility: "agent-disabled" as const },
  ])(
    "preserves $engine views with $eligibility Decision eligibility",
    async ({ engine, eligibility }) => {
      const config = shadowConfig(eligibility);
      const { requests } = installDecisionFixture("preserved", undefined, config);
      const source = sourceMessages();
      const expectedMessages = structuredClone(source);
      const assembled: AssembleResult = { messages: source, estimatedTokens: 300 };
      let modelMessages: AgentMessage[] | undefined;

      const result = await createContextEngineAttemptRunner({
        contextEngine: {
          assemble: async () => assembled,
          info: { id: "custom-engine", name: "Custom fixture", version: "1.0.0" },
        },
        sessionKey: `agent:main:turn-context-shadow-${engine}-${eligibility}`,
        tempPaths,
        sessionMessages: source,
        attemptOverrides: {
          ...(engine === "legacy" ? { contextEngine: undefined } : {}),
          config,
        },
        sessionPrompt: async (session) => {
          modelMessages = structuredClone(session.messages as AgentMessage[]);
          session.messages = [
            ...session.messages,
            { role: "assistant", content: "done", timestamp: 6 },
          ];
        },
      });

      expect(requests).toHaveLength(0);
      expect(modelMessages).toEqual(expectedMessages);
      expect(source).toEqual(expectedMessages);
      expect(result.messagesSnapshot).toEqual([
        ...expectedMessages,
        { role: "assistant", content: "done", timestamp: 6 },
      ]);
    },
  );

  it.each(["mode off", "policy changed"] as const)(
    "revokes shadow observation when %s during assembly",
    async (change) => {
      const config: OpenClawConfig = {
        agents: {
          defaults: {
            experimental: { decisionAssistance: true },
            decisionModel: "semantic-fixture/default-v1",
            turnContextCuration: { mode: "shadow", minEstimatedTokens: 1, recentMessages: 2 },
          },
        },
      };
      const { requests } = installDecisionFixture("preserved", undefined, config);
      const source = sourceMessages();
      const original = structuredClone(source);
      let modelMessages: AgentMessage[] | undefined;
      await createContextEngineAttemptRunner({
        contextEngine: {
          assemble: async () => {
            setRuntimeConfigSnapshot({
              ...config,
              agents: {
                ...config.agents,
                defaults: {
                  ...config.agents?.defaults,
                  turnContextCuration:
                    change === "mode off"
                      ? { ...config.agents?.defaults?.turnContextCuration, mode: "off" }
                      : { ...config.agents?.defaults?.turnContextCuration, recentMessages: 3 },
                },
              },
            });
            return { messages: source, estimatedTokens: 300 };
          },
          info: { id: "custom-engine", name: "Custom fixture", version: "1.0.0" },
        },
        sessionKey: `agent:main:turn-context-shadow-revoked-${change}`,
        tempPaths,
        sessionMessages: source,
        attemptOverrides: { config },
        sessionPrompt: async (session) => {
          modelMessages = structuredClone(session.messages as AgentMessage[]);
        },
      });
      expect(requests).toHaveLength(0);
      expect(modelMessages).toEqual(original);
      expect(source).toEqual(original);
    },
  );
});
