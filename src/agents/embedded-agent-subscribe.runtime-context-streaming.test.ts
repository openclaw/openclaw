import { afterAll, beforeEach, expect, it, vi } from "vitest";
import * as replyDirectives from "../auto-reply/reply/reply-directives.js";
import * as updates from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createOpenAiResponsesTextEvent } from "./embedded-agent-subscribe.openai-responses.test-helpers.js";
import * as runtimeContext from "./internal-runtime-context.js";

// Projections cache their filters, so keep both spies installed across deltas.
const scrub = vi.spyOn(runtimeContext, "stripInternalRuntimeContext");
const parse = vi.spyOn(replyDirectives, "parseReplyDirectives");
beforeEach(vi.clearAllMocks);
afterAll(vi.restoreAllMocks);
const source = "Ordinary prose for the operator. ".repeat(1100).slice(0, 32_768).trimEnd();
const characters = (calls: ReadonlyArray<readonly [string, ...unknown[]]>) =>
  calls.reduce((sum, [text]) => sum + text.length, 0);
async function stream(text: string, size: number, inspect?: (visible: string) => void) {
  const ctx = updates.createMessageUpdateContext();
  for (let offset = 0; offset < text.length; offset += size) {
    await updates.updateMessage(
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
    inspect?.(ctx.state.assistantStream?.text ?? "");
  }
  return ctx.state.assistantStream?.text ?? "";
}
it.each(["", "MEDIA: ./chart.png\n"])(
  "bounds stream work: %j",
  async (prefix) => {
    const text = prefix + source;
    expect(await stream(text, 3, (part) => expect(part).not.toContain("MEDIA:"))).toBe(
      replyDirectives.parseReplyDirectives(text).text,
    );
    expect(characters(parse.mock.calls)).toBeLessThan(1_000_000);
    expect(characters(scrub.mock.calls)).toBe(0);
  },
  30_000,
);
it("still scrubs a complete runtime-context block", async () => {
  const text = [
    "Visible intro.",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    "Visible outro.",
  ].join("\n");
  expect(await stream(text, 5)).toBe("Visible intro.\n\nVisible outro.");
  expect(characters(scrub.mock.calls)).toBeGreaterThan(0);
});
it.each([1, 3, 7, 13])("preserves directives at %i-character deltas", async (size) => {
  for (const text of [
    "Intro.\n\nMEDIA: ./a.png\n\nOutro",
    "Intro.\n\nMEDIA: /tmp/x.pdf\n\nMiddle.\n\nMEDIA: ./b.png\n\nOutro",
    "Intro [[audio_as_voice]]\n\nMEDIA: ./voice.ogg\n\nOutro",
    "[[reply_to_current]]Intro.\n\nMEDIA: ./a.png\n\nOutro",
    "Intro.\n\n```text\nMEDIA: ./literal.png\n```\n\nOutro",
    "Intro.\n\n    MEDIA: ./indented.png\n\nOutro",
    "Intro with [tool calls omitted] inside.\n\nMEDIA: ./a.png\n\nOutro",
  ]) {
    expect(await stream(text, size)).toBe(replyDirectives.parseReplyDirectives(text).text);
  }
});
