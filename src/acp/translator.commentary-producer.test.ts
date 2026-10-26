import { expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createAgentEventTestHarness } from "../gateway/server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "../gateway/server-chat.agent-events.test-helpers.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

it.each([
  [false, "", "Checking files.\nReading config.\nChecking files.Done."],
  [true, "", "Checking files.Reading config.Checking files.Done."],
  [true, "\n", "Checking files.\nReading config.\nChecking files.Done."],
] as const)(
  "delivers explicit commentary once through Gateway and ACP (preview: %s, separator: %j)",
  async (batchedPreview, separator, expected) => {
    const acp = createPromptScenario({ send: () => ({}) });
    const pending = acp.start();
    const runId = await pending.sent;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const gateway = createAgentEventTestHarness();
    gateway.register(runId, acp.sessionKey, runId);
    const unsubscribe = subscribeAgentEvents((event) =>
      event.runId === runId ? gateway.handler(event) : undefined,
    );
    const source = createSubscribedSessionHarness({ runId });
    const message = makeAgentAssistantMessage({ api: "openai-completions", content: [] });
    const narrations = [
      "Checking files.",
      `${separator}Reading config.`,
      `${separator}Checking files.`,
    ];
    const blocks = narrations.map((text, index) => ({
      type: "text" as const,
      text,
      textSignature: JSON.stringify({ v: 1, id: `commentary-${index}`, phase: "commentary" }),
    }));
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
      if (batchedPreview) {
        for (const [contentIndex, text] of narrations.entries()) {
          message.content.push({ type: "text", text });
          emitText(contentIndex, text);
          await deliver();
        }
        message.content.splice(0, blocks.length, ...blocks);
      }
      for (const [index, block] of blocks.entries()) {
        if (!batchedPreview) {
          message.content.push(block);
        }
        emitText(batchedPreview ? index : message.content.length - 1, block.text, true);
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
      await acp.finish(pending, {
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
      });
      expect(
        acp.sessionUpdate.mock.calls
          .flatMap(([{ update }]) => {
            if (update.sessionUpdate !== "agent_message_chunk") {
              return [];
            }
            expect(update.content.type).toBe("text");
            return update.content.type === "text" ? [update.content.text] : [];
          })
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
