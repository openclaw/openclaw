import { Session, type FoldedItem, type Turn, type TurnOutcome } from "@muse-code/sdk";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { consumeTurn } from "./events.js";

function makeParams(order: string[]): AgentHarnessAttemptParamsV2 {
  const authStorage = AuthStorage.inMemory();
  return {
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
}

describe("Muse post-answer finalization", () => {
  it.each([false, true])(
    "keeps foreground tools active (tool=%s) while separating reminder work",
    async (withTool) => {
      const reachedReminder = createDeferred<void>();
      const release = createDeferred<void>();
      const completed = createDeferred<TurnOutcome>();
      const order: string[] = [];
      const params = makeParams(order);
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
      const session = new Session({ sessionId: "native", durability: { kind: "durable" } });
      const operation = consumeTurn(
        turn,
        params,
        async () => {
          order.push("persisted");
        },
        session.fold.items,
      );
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

it.each([false, true])(
  "preserves text streamed before subscription (completed before attach: %s)",
  async (completedBeforeAttach) => {
    const session = new Session({ sessionId: "stream-session", durability: { kind: "durable" } });
    const turnId = "stream-turn";
    const itemId = "stream-answer";
    const sourceRange = {
      first: { id: "event-1", sequence: 1 },
      last: { id: "event-1", sequence: 1 },
      stream: { id: session.sessionId, kind: "session" },
    };
    let cursor = 0;
    const apply = (method: string, params: Record<string, unknown>) =>
      session.apply({
        method,
        params: { sessionId: session.sessionId, turnId, viewCursor: String(++cursor), ...params },
      });
    apply("turn/started", { commandId: turnId, sourceRange });
    apply("item/started", {
      item: { itemId, turnId, kind: "agentMessage", status: "inProgress", revision: 1, text: "" },
    });
    apply("item/delta", { itemId, delta: "started:" });
    const finish = () => {
      apply("item/delta", { itemId, delta: " hello" });
      apply("item/completed", {
        item: {
          itemId,
          turnId,
          kind: "agentMessage",
          status: "completed",
          revision: 2,
          text: "started: hello",
        },
        sourceRange,
      });
      apply("turn/completed", { terminal: "completed", sourceRange });
    };
    if (completedBeforeAttach) {
      finish();
    }
    const streamed: string[] = [];
    const recorded: string[] = [];
    const params = makeParams([]);
    params.onAgentEvent = (event) => {
      if (event.stream === "assistant") {
        streamed.push(String(event.data.delta));
      }
    };
    const operation = consumeTurn(
      session.turn(turnId),
      params,
      async (_id, messages) => {
        for (const message of messages) {
          if (message.role === "assistant") {
            for (const content of message.content) {
              if (content.type === "text") {
                recorded.push(content.text);
              }
            }
          }
        }
      },
      session.fold.items,
    );
    if (!completedBeforeAttach) {
      finish();
    }
    const result = await operation;
    expect(result.visibleText).toBe("started: hello");
    expect(streamed.join("")).toBe("started: hello");
    expect(recorded).toEqual(["started: hello"]);
  },
);
