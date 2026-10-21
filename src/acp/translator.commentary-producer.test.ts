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

it.each([
  [false, "", "Checking files.\nReading config.\nChecking files.Done."],
  [true, "", "Checking files.Reading config.Checking files.Done."],
  [true, "\n", "Checking files.\nReading config.\nChecking files.Done."],
] as const)(
  "delivers explicit commentary once through Gateway and ACP (preview: %s, separator: %j)",
  async (batchedPreview, separator, expected) => {
    const sent = createDeferred<string>();
    const request = vi.fn().mockImplementation(async (method, params) => {
      if (method === "chat.send") {
        sent.resolve(params.idempotencyKey);
      }
      return {};
    });
    const acp = createSessionAgentHarness(request);
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
    const message = makeAgentAssistantMessage({ api: "openai-completions", content: [] });
    const signature = (index: number) =>
      JSON.stringify({ v: 1, id: `commentary-${index}`, phase: "commentary" });
    const emitText = (contentIndex: number, text: string, final = false) => {
      const partial = { contentIndex, partial: message };
      source.emit({
        type: "message_update",
        message,
        assistantMessageEvent: final
          ? { type: "text_end", content: text, ...partial }
          : { type: "text_delta", delta: text, ...partial },
      });
    };
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
      const narrations = [
        "Checking files.",
        `${separator}Reading config.`,
        `${separator}Checking files.`,
      ];
      if (batchedPreview) {
        for (const [contentIndex, text] of narrations.entries()) {
          message.content.push({ type: "text", text });
          emitText(contentIndex, text);
          await deliver();
        }
        for (const [index, block] of message.content.entries()) {
          if (block.type === "text") {
            block.textSignature = signature(index);
          }
        }
      }
      for (const [index, text] of narrations.entries()) {
        if (!batchedPreview) {
          message.content.push({
            type: "text",
            text,
            textSignature: signature(index),
          });
        }
        emitText(batchedPreview ? index : message.content.length - 1, text, true);
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
          .join(""),
      ).toBe(expected);
    } finally {
      source.subscription.unsubscribe();
      await unsubscribe();
      await gateway.handler.dispose();
      gateway.chatRunState.clear();
      vi.useRealTimers();
    }
  },
);
