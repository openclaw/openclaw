import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createTestAcpEventLedger } from "./event-ledger.test-support.js";
import type { AcpAgentWaitResult } from "./translator.prompt-state.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

const visibleReply = (text = "final answer", status: AcpAgentWaitResult["status"] = "ok") => ({
  status,
  terminalReply: { disposition: "visible" as const, text },
});
const textChunks = (events: { update: SessionUpdate }[]) =>
  events.flatMap(({ update }) =>
    update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
      ? [update.content.text]
      : [],
  );

async function createReconnectHarness(
  result: AcpAgentWaitResult = visibleReply(),
  historyText: string | null = result.terminalReply?.disposition === "visible"
    ? result.terminalReply.text
    : "",
) {
  const sessionId = "session-1";
  const sessionKey = "agent:main:main";
  const eventLedger = createTestAcpEventLedger();
  await eventLedger.startSession({ sessionId, sessionKey, cwd: "/tmp", complete: true });
  const h = createPromptScenario({
    eventLedger,
    send: () => ({}),
    request: (method): unknown => {
      if (method === "chat.history") {
        return {
          messages:
            historyText === null
              ? []
              : [
                  {
                    role: "assistant",
                    content: historyText,
                    __openclaw: { runId: h.runIds[0] },
                  },
                ],
        };
      }
      return method === "agent.wait" ? result : {};
    },
  });
  const pending = h.start();
  const acceptedRunId = await pending.sent;

  return {
    connection: h.connection,
    eventLedger,
    promptPromise: pending.result,
    chunks: () => textChunks(h.sessionUpdate.mock.calls.map(([n]) => n)),
    replay: async () =>
      textChunks((await eventLedger.readReplay({ sessionId, sessionKey })).events),
    reconnect: () => {
      h.agent.handleGatewayDisconnect("1006: connection lost");
      h.agent.handleGatewayReconnect();
    },
    chat: (text: string, state: "delta" | "final" = "delta") =>
      h.chat(acceptedRunId, {
        seq: state === "delta" ? 1 : 2,
        state,
        message: { content: [{ type: "text", text }] },
      }),
  };
}

it("recovers an indented timeout reply beyond the terminal summary cap", async () => {
  const prefix = "    " + "A".repeat(5_000);
  const full = prefix + "B".repeat(1_000) + "\n";
  const result = visibleReply(full.slice(0, 4_096), "timeout");
  const harness = await createReconnectHarness(result, full);
  await harness.chat(prefix);
  harness.reconnect();
  await expect(harness.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  expect(harness.chunks().join("")).toBe(full);
  expect((await harness.replay()).join("")).toBe(full);
});

it("reports missing authoritative history instead of settling with the terminal summary", async () => {
  const harness = await createReconnectHarness(visibleReply("summary"), null);
  harness.reconnect();
  await expect(harness.promptPromise).rejects.toThrow("Full reply recovery unavailable");
  expect(harness.chunks()).toEqual([
    "[OpenClaw interruption] Full reply recovery unavailable (reply-not-found). Check the session history.",
  ]);
});

it("recovers visible text before rejecting a failed run", async () => {
  const harness = await createReconnectHarness({
    ...visibleReply("final answer", "error"),
    error: "boom",
  });
  harness.reconnect();
  await expect(harness.promptPromise).rejects.toThrow("boom");
  expect(harness.chunks()).toEqual(["final answer", "[OpenClaw interruption] boom"]);
});

it("claims recovery before a late final event can emit the suffix twice", async () => {
  const harness = await createReconnectHarness();
  await harness.chat("final");
  const recordBlocked = createDeferred();
  const recordUpdate = harness.eventLedger.recordUpdate.bind(harness.eventLedger);
  harness.eventLedger.recordUpdate = async (params) => {
    if (
      params.update.sessionUpdate === "agent_message_chunk" &&
      params.update.content.type === "text" &&
      params.update.content.text === " answer"
    ) {
      await recordBlocked.promise;
    }
    await recordUpdate(params);
  };

  harness.reconnect();
  await vi.waitFor(() => expect(harness.chunks()).toContain(" answer"));
  const lateFinal = harness.chat("final answer", "final");
  recordBlocked.resolve();
  await lateFinal;

  await expect(harness.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  expect(harness.chunks().filter((text) => text === " answer")).toHaveLength(1);
});

it("settles after recovered update delivery rejects", async () => {
  const harness = await createReconnectHarness();
  harness.connection.sessionUpdate = vi.fn(async () => {
    throw new Error("client gone");
  }) as typeof harness.connection.sessionUpdate;

  harness.reconnect();

  await expect(harness.promptPromise).resolves.toEqual({ stopReason: "end_turn" });
  expect(await harness.replay()).toContain("final answer");
});
