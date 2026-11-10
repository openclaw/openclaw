import { assert, expect, it, onTestFinished, vi } from "vitest";
import { createSubscribedSessionHarness } from "../agents/embedded-agent-subscribe.e2e-harness.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { createAgentEventTestHarness } from "../gateway/server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "../gateway/server-chat.agent-events.test-helpers.js";
import { createPromptScenario } from "./translator.scenario.test-support.js";

it.each([
  [false, "", "Read.\nCheck.\nRead.Done."],
  [true, "", "Read.Check.Read.Done."],
  [true, "\n", "Read.\nCheck.\nRead.Done."],
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
    onTestFinished(async () => {
      source.subscription.unsubscribe();
      await unsubscribe();
      await gateway.handler.dispose();
      gateway.chatRunState.clear();
      vi.useRealTimers();
    });
    const blocks = ["Read.", `${separator}Check.`, `${separator}Read.`].map((text, index) => ({
      type: "text" as const,
      text,
      textSignature: JSON.stringify({ v: 1, id: `commentary-${index}`, phase: "commentary" }),
    }));
    const emit = async (frame: Parameters<typeof source.emit>[0]) => {
      source.emit(frame);
      await source.subscription.waitForPendingEvents();
      await unsubscribe.drain();
      gateway.chatRunState.flushPendingText(runId);
      for (const [event, payload] of gateway.broadcast.mock.calls) {
        await acp.agent.handleGatewayEvent({ type: "event", event, payload });
      }
      gateway.broadcast.mockClear();
    };
    const emitText = (contentIndex: number, text: string, final = false) =>
      emit({
        type: "message_update",
        message,
        assistantMessageEvent: {
          contentIndex,
          partial: message,
          ...(final ? { type: "text_end", content: text } : { type: "text_delta", delta: text }),
        },
      });
    source.emit({ type: "message_start", message });
    if (batchedPreview) {
      for (const [contentIndex, { text }] of blocks.entries()) {
        message.content.push({ type: "text", text });
        await emitText(contentIndex, text);
      }
      message.content.splice(0, blocks.length, ...blocks);
    }
    for (const [index, block] of blocks.entries()) {
      if (!batchedPreview) {
        message.content.push(block);
      }
      await emitText(batchedPreview ? index : message.content.length - 1, block.text, true);
      message.content.push({ type: "toolCall", id: `read-${index}`, name: "read", arguments: {} });
    }
    await emit({ type: "message_end", message });
    await acp.finish(pending, {
      message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
    });
    const chunks = acp.sessionUpdate.mock.calls.flatMap(([{ update }]) => {
      if (update.sessionUpdate !== "agent_message_chunk") {
        return [];
      }
      assert(update.content.type === "text");
      return [update.content.text];
    });
    expect(chunks.join("")).toBe(expected);
  },
);
