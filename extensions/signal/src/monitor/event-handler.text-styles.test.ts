import { expectDefined } from "@openclaw/normalization-core";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { markdownToIR } from "openclaw/plugin-sdk/text-chunking";
import { beforeEach, expect, it, vi } from "vitest";
import { resolveSignalReplyContextWithPersistence } from "../reply-authors.js";
import { resetSignalReplyAuthorsForTests } from "../reply-authors.test-helpers.js";

let capturedCtx: MsgContext | undefined;

// mock-isolation: Keep the real inbound runner; replace only persistence and agent dispatch.
vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const { signalInboundTestModule } =
    await import("./event-handler.inbound-context.test-support.js");
  return signalInboundTestModule(
    await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>(),
    async () => {},
    async (plan) => {
      capturedCtx = plan.ctxPayload;
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    },
  );
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

beforeEach(() => {
  capturedCtx = undefined;
  resetSignalReplyAuthorsForTests();
});

it.each([
  ["BOLD", "**ship**"],
  ["ITALIC", "*ship*"],
  ["STRIKETHROUGH", "~~ship~~"],
  ["MONOSPACE", "`ship`"],
  ["SPOILER", "||ship||"],
] as const)(
  "keeps %s after a UTF-16 mention without formatting commands",
  async (style, formatted) => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({ cfg: { messages: { inbound: { debounceMs: 0 } } } }),
    );
    await handler(
      createSignalReceiveEvent({
        dataMessage: {
          message: "😀 ￼ ship it",
          mentions: [{ start: 3, length: 1, uuid: "alice" }],
          textStyles: [{ start: 5, length: 4, style }],
        },
      }),
    );
    const ctx = expectDefined(capturedCtx, "Signal MsgContext");
    expect(ctx.BodyForAgent).toBe(`😀 @alice ${formatted} it`);
    expect(ctx.RawBody).toBe("😀 @alice ship it");
    expect(ctx.CommandBody).toBe("😀 @alice ship it");
  },
);

it("moves a style that covers a mention and keeps literal backticks in monospace", async () => {
  const handler = createSignalEventHandler(
    createBaseSignalEventHandlerDeps({ cfg: { messages: { inbound: { debounceMs: 0 } } } }),
  );
  await handler(
    createSignalReceiveEvent({
      dataMessage: {
        message: "￼ `x`",
        mentions: [{ start: 0, length: 1, uuid: "alice" }],
        textStyles: [
          { start: 0, length: 1, style: "BOLD" },
          { start: 2, length: 3, style: "MONOSPACE" },
        ],
      },
    }),
  );
  const ctx = expectDefined(capturedCtx, "Signal MsgContext");
  expect(ctx.BodyForAgent).toBe("**@alice** `` `x` ``");
  expect(ctx.RawBody).toBe("@alice `x`");
});

it.each([
  {
    name: "combined bold and monospace",
    message: "ship",
    textStyles: [
      { start: 0, length: 4, style: "BOLD" },
      { start: 0, length: 4, style: "MONOSPACE" },
    ],
    styles: [
      { start: 0, end: 4, style: "bold" },
      { start: 0, end: 4, style: "code" },
    ],
  },
  {
    name: "emphasis inside monospace",
    message: "one two",
    textStyles: [
      { start: 0, length: 7, style: "MONOSPACE" },
      { start: 4, length: 3, style: "BOLD" },
    ],
    styles: [
      { start: 0, end: 7, style: "code" },
      { start: 4, end: 7, style: "bold" },
    ],
  },
  {
    name: "whitespace-inclusive emphasis inside monospace",
    message: "one two",
    textStyles: [
      { start: 0, length: 7, style: "MONOSPACE" },
      { start: 0, length: 4, style: "BOLD" },
    ],
    styles: [
      { start: 0, end: 7, style: "code" },
      { start: 0, end: 3, style: "bold" },
    ],
  },
  {
    name: "italics without word separators",
    message: "请重点检查",
    textStyles: [{ start: 1, length: 2, style: "ITALIC" }],
    styles: [{ start: 1, end: 3, style: "italic" }],
  },
  ...["a\nb", "a\n\nb"].map((message) => ({
    name: `multiline monospace ${JSON.stringify(message)}`,
    message,
    textStyles: [{ start: 0, length: message.length, style: "MONOSPACE" }],
    styles: [
      { start: 0, end: 1, style: "code" },
      { start: message.length - 1, end: message.length, style: "code" },
    ],
  })),
  ...[3, 4].map((length) => ({
    name: `touching or overlapping monospace ${length}`,
    message: "foobar",
    textStyles: [
      { start: 0, length, style: "MONOSPACE" },
      { start: 3, length: 3, style: "MONOSPACE" },
    ],
    styles: [{ start: 0, end: 6, style: "code" }],
  })),
  {
    name: "emphasis across paragraphs",
    message: "first\n\nsecond",
    textStyles: [{ start: 0, length: 13, style: "BOLD" }],
    styles: [
      { start: 0, end: 5, style: "bold" },
      { start: 7, end: 13, style: "bold" },
    ],
  },
  {
    name: "punctuation-inclusive emphasis before adjacent text",
    message: "注意!继续",
    textStyles: [{ start: 0, length: 3, style: "BOLD" }],
    styles: [{ start: 0, end: 3, style: "bold" }],
  },
  {
    name: "crossing emphasis at whitespace",
    message: "one two three",
    textStyles: [
      { start: 0, length: 7, style: "BOLD" },
      { start: 4, length: 9, style: "ITALIC" },
    ],
    styles: [
      { start: 0, end: 7, style: "bold" },
      { start: 4, end: 7, style: "italic" },
      { start: 8, end: 13, style: "italic" },
    ],
  },
])("preserves valid Markdown for $name", async ({ message, textStyles, styles }) => {
  const handler = createSignalEventHandler(
    createBaseSignalEventHandlerDeps({ cfg: { messages: { inbound: { debounceMs: 0 } } } }),
  );
  await handler(createSignalReceiveEvent({ dataMessage: { message, textStyles } }));
  const ctx = expectDefined(capturedCtx, "Signal MsgContext");
  const parsed = markdownToIR(expectDefined(ctx.BodyForAgent, "agent body"));
  expect(parsed.text).toBe(message);
  // Adjacent parsed spans may merge; compare formatting at each UTF-16 offset.
  for (let offset = 0; offset < message.length; offset++) {
    const activeStyles = (spans: typeof styles) =>
      spans
        .filter((span) => span.start <= offset && offset < span.end)
        .map((span) => span.style)
        .toSorted();
    expect(activeStyles(parsed.styles), `styles at ${offset}`).toEqual(activeStyles(styles));
  }
  expect(ctx.RawBody).toBe(message);
  expect(ctx.CommandBody).toBe(message);
  const quote = await resolveSignalReplyContextWithPersistence({
    accountId: "default",
    to: "signal:+15550001111",
    replyToId: "1700000000000",
  });
  expect(quote?.body).toBe(message);
});
