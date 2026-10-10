import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createAgentEventTestHarness } from "../gateway/server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "../gateway/server-chat.agent-events.test-helpers.js";
import {
  createSessionAgentHarness,
  promptAgent,
} from "./translator.prompt-harness.test-support.js";

// mock-isolation: Command discovery loads unrelated plugins outside this event delivery contract.
vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

it.each([false, true])(
  "delivers generic commentary once through Gateway and ACP (batchedPreview=%s)",
  async (batchedPreview) => {
    const sent = createDeferred<string>();
    const acp = createSessionAgentHarness(
      vi.fn(async (method, params) => {
        if (method === "chat.send") {
          sent.resolve(params.idempotencyKey);
        }
        return {};
      }),
    );
    const prompt = promptAgent(acp.agent);
    const runId = await sent.promise;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const gateway = createAgentEventTestHarness();
    gateway.register(runId, acp.sessionKey, runId);
    const unsubscribe = subscribeAgentEvents((event) => {
      if (event.runId === runId) {
        return gateway.handler(event);
      }
    });
    const source = createSubscribedSessionHarness({ runId });
    const message = makeAgentAssistantMessage({ api: "anthropic-messages", content: [] });
    const deliver = async () => {
      await source.subscription.waitForPendingEvents();
      await unsubscribe.drain();
      gateway.chatRunState.flushPendingText(runId);
      for (const [event, payload] of gateway.broadcast.mock.calls) {
        await acp.agent.handleGatewayEvent({ type: "event", event, payload });
      }
      gateway.broadcast.mockClear();
    };
    try {
      source.emit({ type: "message_start", message });
      const narrations = ["Checking files.", "Reading config.", "Checking files."];
      if (batchedPreview) {
        for (const [contentIndex, text] of narrations.entries()) {
          message.content.push({ type: "text", text });
          source.emit({
            type: "message_update",
            message,
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex,
              delta: text,
              partial: message,
            },
          });
          await deliver();
        }
        for (const [index, block] of message.content.entries()) {
          if (block.type === "text") {
            block.textSignature = JSON.stringify({
              v: 1,
              id: `commentary-${index}`,
              phase: "commentary",
            });
          }
        }
      }
      for (const [index, text] of narrations.entries()) {
        if (!batchedPreview) {
          message.content.push({
            type: "text",
            text,
            textSignature: JSON.stringify({ v: 1, id: `commentary-${index}`, phase: "commentary" }),
          });
        }
        source.emit({
          type: "message_update",
          message,
          assistantMessageEvent: {
            type: "text_end",
            contentIndex: batchedPreview ? index : message.content.length - 1,
            content: text,
            partial: message,
          },
        });
        await deliver();
        message.content.push({
          type: "toolCall",
          id: `read-${index}`,
          name: "read",
          arguments: {},
        });
      }
      source.emit({ type: "message_end", message });
      await deliver();
      await acp.agent.handleGatewayEvent({
        type: "event",
        event: "chat",
        payload: {
          runId,
          sessionKey: acp.sessionKey,
          state: "final",
          message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        },
      });
      await prompt;
      expect(
        acp.sessionUpdate.mock.calls
          .flatMap(([{ update }]) =>
            update.sessionUpdate === "agent_message_chunk" ? [update.content.text] : [],
          )
          .join("")
          .replaceAll("\n", ""),
      ).toBe("Checking files.Reading config.Checking files.Done.");
    } finally {
      source.subscription.unsubscribe();
      await unsubscribe();
      await gateway.handler.dispose();
      gateway.chatRunState.clear();
      vi.useRealTimers();
    }
  },
);
