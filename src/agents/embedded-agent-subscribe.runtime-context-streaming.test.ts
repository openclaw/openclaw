import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createOpenAiResponsesTextEvent } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import * as runtimeContext from "./internal-runtime-context.js";

// The subscriber projection chain caches its filters, so the spy has to stay installed for the
// whole module and count every scrub call the shipped handler performs.
const scrub = vi.spyOn(runtimeContext, "stripInternalRuntimeContext");

beforeEach(() => {
  scrub.mockClear();
});
afterAll(() => {
  scrub.mockRestore();
});

function characters(calls: ReadonlyArray<readonly [string, ...unknown[]]>): number {
  return calls.reduce((sum, [text]) => sum + text.length, 0);
}

const sentence =
  "The quick brown fox jumps over the lazy dog while the operator reviews one more log line. ";
const source = sentence
  .repeat(Math.ceil(32_768 / sentence.length))
  .slice(0, 32_768)
  .trimEnd();

async function streamThroughSubscriber(text: string, size: number): Promise<string> {
  const ctx = createMessageUpdateContext();
  let visible = "";
  for (let offset = 0; offset < text.length; offset += size) {
    await updateMessage(
      ctx,
      createOpenAiResponsesTextEvent({
        type: "text_delta",
        text: text.slice(0, offset + size),
        delta: text.slice(offset, offset + size),
        id: "msg-1",
        signaturePhase: "final_answer",
        partialPhase: "final_answer",
        messagePhase: "final_answer",
      }),
    );
    visible = ctx.state.assistantStream?.text ?? "";
  }
  return visible;
}

// Every new projection starts with replace(previousStream?.raw ?? ""), so an empty replacement
// must keep activation off or ordinary prose pays a whole-reply scan per provider delta.
it("keeps ordinary English off the runtime-context scrub through the subscriber handler", async () => {
  const visible = await streamThroughSubscriber(source, 4);

  expect(visible).toBe(source);
  expect(characters(scrub.mock.calls)).toBe(0);
}, 30_000);

it("still scrubs a complete runtime-context block through the subscriber handler", async () => {
  const text = [
    "Visible intro.",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    "Visible outro.",
  ].join("\n");

  const visible = await streamThroughSubscriber(text, 5);

  expect(visible).toBe("Visible intro.\n\nVisible outro.");
  expect(characters(scrub.mock.calls)).toBeGreaterThan(0);
}, 30_000);
