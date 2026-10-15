import type { FoldedItem, Turn, TurnOutcome } from "@muse-code/sdk";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { consumeTurn } from "./events.js";

describe("Muse post-answer finalization", () => {
  it.each([false, true])(
    "keeps foreground tools active (tool=%s) while separating reminder work",
    async (withTool) => {
      const reachedReminder = createDeferred<void>();
      const release = createDeferred<void>();
      const completed = createDeferred<TurnOutcome>();
      const order: string[] = [];
      const authStorage = AuthStorage.inMemory();
      const params: AgentHarnessAttemptParamsV2 = {
        runId: "run-finalization",
        sessionId: "session-finalization",
        sessionKey: "agent:main:finalization",
        workspaceDir: "/tmp/muse-events-test",
        agentDir: "/tmp/muse-events-test",
        provider: "meta",
        modelId: "muse-spark-1.3",
        model: {
          id: "muse-spark-1.3",
          name: "Muse Spark",
          provider: "meta",
          api: "openai-responses",
          baseUrl: "https://api.meta.ai/v1",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 8192,
        },
        authStorage,
        modelRegistry: ModelRegistry.inMemory(authStorage),
        thinkLevel: "off",
        sessionFile: "/tmp/muse-events-test/session.jsonl",
        timeoutMs: 10_000,
        prompt: "hello",
        authProfileStore: { version: 1, profiles: {} },
        onAgentEvent: (event) => {
          if (event.stream === "lifecycle") {
            order.push(String(event.data.phase));
          }
        },
        hostCapabilities: {
          kind: "agent-harness-host-capability",
          version: 1,
          assertActive: () => undefined,
          bindToolSurface: (tools) => tools,
          runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
          requestApproval: async () => ({ decision: "allow-once" }),
          waitForApproval: async () => undefined,
        },
      };
      const answer: FoldedItem = {
        itemId: "answer",
        turnId: "turn",
        kind: "agentMessage",
        status: "completed",
        revision: 1,
        text: "Done.",
      };
      const reminder: FoldedItem = {
        itemId: "reminder",
        turnId: "turn",
        kind: "reminderChild",
        status: "inProgress",
        revision: 1,
      };
      const turn: Turn = {
        turnId: "turn",
        observedStart: true,
        completed: completed.promise,
        async *deltas() {},
        async *items() {
          yield answer;
          if (withTool) {
            yield {
              itemId: "tool",
              turnId: "turn",
              kind: "toolCall",
              status: "inProgress",
              revision: 1,
              tool: "read_file",
            };
          }
          yield reminder;
          reachedReminder.resolve();
          await release.promise;
          completed.resolve({
            kind: "completed",
            observedStart: true,
            params: {
              sessionId: "native",
              turnId: "turn",
              terminal: "completed",
              sourceRange: {
                first: { id: "event-1", sequence: 1 },
                last: { id: "event-1", sequence: 1 },
                stream: { id: "native", kind: "session" },
              },
              viewCursor: "1",
            },
          });
          order.push("turn/completed");
        },
      };
      const operation = consumeTurn(turn, params, async () => {
        order.push("persisted");
      });
      try {
        await awaitGateBeforeSettlement(
          reachedReminder.promise,
          operation,
          "turn settled before reminder work",
        );
        expect(order).toEqual(withTool ? ["persisted"] : ["persisted", "finishing"]);
      } finally {
        release.resolve();
        await operation;
      }
      expect(order.at(-1)).toBe("turn/completed");
    },
  );
});
