import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { projectInFlightRunSnapshot } from "../gateway/chat-inflight-snapshot.js";
import { createAgentEventTestHarness } from "../gateway/server-chat.agent-events.test-harness.js";
import { subscribeAgentEvents } from "../gateway/server-chat.agent-events.test-helpers.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { createOpenAiResponsesTextBlock } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
type TestAssistant = Pick<AssistantMessage, "role" | "content"> &
  Partial<Pick<AssistantMessage, "api" | "stopReason" | "openclawDelivery">> & {
    phase?: "commentary" | "final_answer";
  };
function commentaryHarness(options: Options) {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-05-09T00:00:00.000Z"));
  const gateway = createAgentEventTestHarness();
  gateway.register("run", "main", "run");
  const unsubscribe = subscribeAgentEvents((event) => {
    if (event.runId === "run") {
      return gateway.handler(event);
    }
  });
  const finishing = createDeferred();
  const finish = createDeferred();
  const source = createSubscribedSessionHarness({
    runId: "run",
    ...options,
    onBeforeLifecycleTerminal: () => {
      finishing.resolve();
      return finish.promise;
    },
  });
  onTestFinished(async () => {
    finish.resolve();
    await source.subscription.waitForPendingEvents();
    source.subscription.unsubscribe();
    await unsubscribe();
    await gateway.handler.dispose();
    gateway.chatRunState.clear();
    vi.useRealTimers();
  });
  return {
    ...source,
    broadcast: gateway.broadcast,
    finishing: finishing.promise,
    drain: unsubscribe.drain,
    snapshot: async () => {
      await unsubscribe.drain();
      gateway.chatRunState.flushPendingText("run");
      return projectInFlightRunSnapshot({ chatRunState: gateway.chatRunState, runId: "run" }).text;
    },
  };
}
function update(
  emit: ReturnType<typeof createSubscribedSessionHarness>["emit"],
  message: TestAssistant,
  event: {
    type: string;
    contentIndex?: number;
    delta?: string;
    content?: string;
    partial?: TestAssistant;
  },
) {
  emit({ type: "message_update", message, assistantMessageEvent: event });
}
function textMessage(
  text: string,
  api: "anthropic-messages" | "openai-completions",
): TestAssistant {
  return { ...textAssistant(text), api };
}
function textBlock(text: string, id: string, phase: "commentary" | "final_answer") {
  return { ...createOpenAiResponsesTextBlock({ text, id, phase }), type: "text" as const };
}
function toolBlock(id: string, name: string) {
  return { type: "toolCall" as const, id, name, arguments: {} };
}
describe("commentary preambles", () => {
  it.each(["anthropic-messages", "openai-completions"] as const)(
    "preserves unphased %s narration inline across a tool call",
    async (api) => {
      const onAgentEvent = vi.fn();
      const { emit, subscription, snapshot, drain } = commentaryHarness({ onAgentEvent });
      const narration = "Checking the workspace.\n\n```sh\n  pwd\n```";
      emit({ type: "message_start", message: textMessage("", api) });
      update(emit, textMessage(narration, api), { type: "text_delta", delta: narration });
      await subscription.waitForPendingEvents();
      expect(await snapshot()).toContain("Checking the workspace.");

      const toolMessage: TestAssistant = {
        ...textMessage(narration, api),
        stopReason: "toolUse",
        content: [{ type: "text", text: narration }, toolBlock("exec_0", "exec")],
      };
      update(emit, toolMessage, { type: "toolcall_start", contentIndex: 1, partial: toolMessage });
      emit({ type: "message_end", message: toolMessage });
      await subscription.waitForPendingEvents();
      await drain();
      expect(await snapshot()).toBe(narration);
      expect(onAgentEvent.mock.calls.some(([event]) => event.stream === "item")).toBe(false);

      emit({ type: "message_start", message: textMessage("", api) });
      update(emit, textMessage("Next answer.", api), { type: "text_delta", delta: "Next answer." });
      emit({
        type: "message_end",
        message: { ...textMessage("Next answer.", api), stopReason: "stop" },
      });
      await subscription.waitForPendingEvents();
      expect(await snapshot()).toBe(`${narration}\n\nNext answer.`);
    },
  );

  it.each([
    { phaseKnownAt: "text_delta", deferred: false },
    { phaseKnownAt: "text_end", deferred: false },
    { phaseKnownAt: "text_end", deferred: true },
  ] satisfies Array<{ phaseKnownAt: "text_delta" | "text_end"; deferred: boolean }>)(
    "preserves an explicit final-answer block when sibling commentary is identified at $phaseKnownAt (deferred=$deferred)",
    async ({ phaseKnownAt, deferred }) => {
      const onAgentEvent = vi.fn();
      const { emit, subscription, snapshot, finishing, broadcast, drain } = commentaryHarness({
        onAgentEvent,
        ...(deferred ? { onBeforeTerminalDelivery: () => undefined } : {}),
      });
      const answer: TestAssistant = {
        role: "assistant",
        api: "openai-responses",
        content: [textBlock("Accepted answer.", "answer-0", "final_answer")],
      };
      emit({ type: "message_start", message: answer });
      update(emit, answer, {
        type: "text_delta",
        contentIndex: 0,
        delta: "Accepted answer.",
        partial: answer,
      });
      const mixed: TestAssistant = {
        ...answer,
        content: [...answer.content, textBlock("Checking a detail.", "commentary-0", "commentary")],
      };
      const partial: TestAssistant =
        phaseKnownAt === "text_delta"
          ? mixed
          : {
              ...answer,
              content: [...answer.content, { type: "text", text: "Checking a detail." }],
            };
      update(emit, partial, {
        type: "text_delta",
        contentIndex: 1,
        delta: "Checking a detail.",
        partial,
      });
      if (phaseKnownAt === "text_end" && !deferred) {
        expect(onAgentEvent.mock.calls.at(-1)?.[0]).toMatchObject({
          stream: "assistant",
          data: { text: expect.stringContaining("Checking a detail.") },
        });
        expect(await snapshot()).toBe("Accepted answer.\nChecking a detail.");
        expect(broadcast.mock.calls.findLast(([event]) => event === "chat")?.[1]).toMatchObject({
          message: {
            content: [{ type: "text", text: "Accepted answer.\nChecking a detail." }],
          },
        });
        broadcast.mockClear();
      }
      update(emit, mixed, {
        type: "text_end",
        contentIndex: 1,
        content: "Checking a detail.",
        partial: mixed,
      });
      await subscription.waitForPendingEvents();
      await drain();
      if (phaseKnownAt === "text_end" && !deferred) {
        const correction = broadcast.mock.calls.findIndex(([event]) => event === "chat");
        const preamble = broadcast.mock.calls.findIndex(
          ([event, payload]) => event === "agent" && payload.data?.kind === "preamble",
        );
        expect(correction).toBeGreaterThanOrEqual(0);
        expect(broadcast.mock.calls[correction]?.[1]).toMatchObject({
          replace: true,
          deltaText: "Accepted answer.",
        });
        expect(preamble).toBeGreaterThan(correction);
      }
      const beforeMessageEnd = onAgentEvent.mock.calls.map(([event]) => event);
      const current = beforeMessageEnd.findLast((event) => event.stream === "assistant");
      if (deferred) {
        expect(current).toBeUndefined();
      } else {
        expect(current?.data.text).toBe(
          phaseKnownAt === "text_delta"
            ? "Accepted answer."
            : "Accepted answer.\nChecking a detail.",
        );
      }
      expect(await snapshot()).toBe("Accepted answer.");
      const continued =
        phaseKnownAt === "text_end" && !deferred
          ? {
              ...mixed,
              content: [
                ...mixed.content,
                textBlock("Continuing answer.", "answer-1", "final_answer"),
              ],
            }
          : mixed;
      if (continued !== mixed) {
        update(emit, continued, {
          type: "text_delta",
          contentIndex: 2,
          delta: "Continuing answer.",
          partial: continued,
        });
        await subscription.waitForPendingEvents();
        await drain();
        expect(await snapshot()).toBe("Accepted answer.\nContinuing answer.");
      }
      emit({ type: "message_end", message: continued });
      await subscription.waitForPendingEvents();
      await drain();
      if (deferred) {
        emit({ type: "agent_end", messages: [continued] });
        await finishing;
        await drain();
      }

      const events = onAgentEvent.mock.calls.map(([event]) => event);
      const assistant = events.filter((event) => event.stream === "assistant");
      const expectedAnswer =
        continued === mixed ? "Accepted answer." : "Accepted answer.\nContinuing answer.";
      expect(assistant.length).toBeGreaterThan(0);
      if (phaseKnownAt === "text_delta") {
        expect(assistant.every((event) => event.data.text === "Accepted answer.")).toBe(true);
      } else {
        expect(assistant).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ text: "Accepted answer.\nChecking a detail." }),
          }),
        );
        expect(assistant).toContainEqual(
          expect.objectContaining({
            data: expect.objectContaining({ text: expectedAnswer, replace: true }),
          }),
        );
      }
      expect(events).toContainEqual(
        expect.objectContaining({
          stream: "item",
          data: expect.objectContaining({
            itemId: "commentary-0",
            progressText: "Checking a detail.",
          }),
        }),
      );
      expect(await snapshot()).toBe(expectedAnswer);
    },
  );
});
