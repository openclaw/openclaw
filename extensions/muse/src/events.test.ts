import type { FoldedItem, Turn, TurnOutcome } from "@muse-code/sdk";
import type { AgentHarnessAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { consumeTurn } from "./events.js";

function item(
  kind: "agentMessage" | "toolCall" | "reminderChild",
  extra: Partial<FoldedItem> = {},
): FoldedItem {
  return { itemId: kind, turnId: "turn", kind, status: "inProgress", revision: 1, ...extra };
}

it.each([false, true])("finalizes only background reminder work (tool=%s)", async (withTool) => {
  const reachedReminder = createDeferred<void>();
  const release = createDeferred<void>();
  const completed = createDeferred<TurnOutcome>();
  const order: string[] = [];
  const authStorage = AuthStorage.inMemory();
  const params: AgentHarnessAttemptParamsV2 = {
    runId: "run-finalization",
    sessionId: "session-finalization",
    workspaceDir: "/tmp/muse-events-test",
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
    onAgentEvent: ({ stream, data }) =>
      void (stream === "lifecycle" && order.push(String(data.phase))),
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
  const turn: Turn = {
    turnId: "turn",
    observedStart: true,
    completed: completed.promise,
    async *deltas() {},
    async *items() {
      yield item("agentMessage", { status: "completed", text: "Done." });
      if (withTool) {
        yield item("toolCall", { tool: "read_file" });
      }
      yield item("reminderChild");
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
  const operation = consumeTurn(turn, params, async () => void order.push("persisted"));
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
});
