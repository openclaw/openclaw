import { expect, it } from "vitest";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../../embedded-agent-utils.js";
import {
  assistantMessage,
  collectPromotionEvents,
  messageContent,
  record,
  commandText,
  createPromotionStream,
  wrapPromotionStream,
} from "./attempt-tool-call-text-promotion.test-support.js";

it("reuses promoted ids across cloned result and done messages", async () => {
  const rawToolText = "<function=exec></function>";
  const createMessage = () => assistantMessage([{ type: "text", text: rawToolText }]);
  const stream = await createPromotionStream({
    events: [
      { type: "text_delta", contentIndex: 0, delta: rawToolText },
      { type: "done", reason: "stop", message: createMessage() },
    ],
    resultMessage: createMessage(),
  });

  const result = record(await stream.result(), "result message");
  const events = await collectPromotionEvents(stream);
  const resultToolCall = record(messageContent(result)[0], "result tool call");
  const lifecycle = events.filter((event) => String(event.type).startsWith("toolcall_"));
  const doneToolCall = record(messageContent(events.at(-1)?.message)[0], "done tool call");
  expect(doneToolCall.id).toBe(resultToolCall.id);
  expect(lifecycle).toHaveLength(3);
  for (const event of lifecycle) {
    expect(record(messageContent(event.partial)[0], "partial tool call").id).toBe(
      resultToolCall.id,
    );
  }
});

it("preserves intervening thinking when promoting multiple text blocks", async () => {
  const firstRawToolText = commandText("pwd");
  const secondRawToolText = commandText("whoami");
  const resultMessage = assistantMessage([
    { type: "text", text: firstRawToolText },
    { type: "thinking", thinking: "Need one more check." },
    { type: "text", text: secondRawToolText },
  ]);
  const stream = await createPromotionStream({
    events: [
      { type: "text_delta", contentIndex: 0, delta: firstRawToolText },
      {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "Need one more check.",
        partial: { content: structuredClone(resultMessage.content) },
      },
      { type: "text_delta", contentIndex: 2, delta: secondRawToolText },
      { type: "done", reason: "stop", message: resultMessage },
    ],
    resultMessage,
  });

  const events = await collectPromotionEvents(stream);
  const result = record(await stream.result(), "result message");

  expect(events.map((event) => event.type)).toEqual([
    "start",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "thinking_delta",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    "done",
  ]);
  expect(
    [events[1], events[4], events[5]].map((event) => record(event, "indexed event").contentIndex),
  ).toEqual([0, 1, 2]);
  expect(result.content).toEqual([
    expect.objectContaining({ type: "toolCall", name: "exec", arguments: { command: "pwd" } }),
    expect.objectContaining({ type: "thinking" }),
    expect.objectContaining({ type: "toolCall", name: "exec", arguments: { command: "whoami" } }),
  ]);
});

const deferredCall =
  "<tool_call>\n<function=skills_read>\n<parameter=name>\nbriefing\n</parameter>\n</function>\n</tool_call>";

it.each([
  ["deferred envelope", deferredCall],
  ["offered fenced example", '```json\n[read]\n{"path":"example.txt"}\n[/read]\n```'],
  ["missing closer", deferredCall.replace("\n</tool_call>", "")],
  ["invalid closer", deferredCall.replace("</tool_call>", "</wrong>\nAnswer")],
  ["partial opener", "<tool_"],
  ["ordinary prefix prose", "Use <tool_ as a prefix in prose."],
  ["ordinary tag prose", "The <tool_call> example remains visible."],
  ["fenced example", `\`\`\`xml\n${deferredCall}\n\`\`\``],
  ["tilde-fenced example", `~~~xml\n${deferredCall}\n~~~`],
  ["inline example", `Example \`${deferredCall}\` remains visible.`],
  ["indented example", `    ${deferredCall}`],
  ["indented partial marker", "    <tool_"],
  ["surrounding prose", `Before\n\n${deferredCall}\n\nAfter`],
  ["CRLF envelope", deferredCall.replaceAll("\n", "\r\n")],
] as const)(
  "preserves the full streaming chain without executing a deferred name: %s",
  async (_name, source) => {
    const expected = Array.from({ length: source.length + 1 }, (_, end) =>
      sanitizeAssistantVisibleStreamText(source.slice(0, end), "final_answer"),
    );
    const schedules = [
      ...Array.from({ length: source.length + 1 }, (_, split) => [
        source.slice(0, split),
        source.slice(split),
      ]),
      source.split(""),
      Array.from({ length: Math.ceil(source.length / 4) }, (_, index) =>
        source.slice(index * 4, index * 4 + 4),
      ),
    ];
    for (const chunks of schedules) {
      const projection = createAssistantVisibleStreamText("final_answer");
      const message = (text: string) => assistantMessage([{ type: "text", text }]);
      const stream = await wrapPromotionStream(
        () => ({
          result: async () => message(source),
          async *[Symbol.asyncIterator]() {
            let prefix = "";
            yield { type: "start", partial: message("") };
            for (const delta of chunks) {
              prefix += delta;
              yield { type: "text_delta", contentIndex: 0, delta, partial: message(prefix) };
              // The consumer has processed every event produced for this source prefix.
              expect(projection.text).toBe(expected[prefix.length]);
            }
            yield { type: "text_end", contentIndex: 0, content: source, partial: message(source) };
            yield { type: "done", reason: "stop", message: message(source) };
          },
        }),
        "read",
      );
      let emitted = "";
      for await (const value of stream) {
        const event = record(value, "event");
        if (event.type === "text_delta" && typeof event.delta === "string") {
          emitted += event.delta;
          projection.append(event.delta);
        } else if (event.type === "text_end" && typeof event.content === "string") {
          projection.replace(event.content);
        }
        expect(String(event.type).startsWith("toolcall_")).toBe(false);
        if (event.type === "done") {
          expect(record(event.message, "done message").content).toEqual(message(source).content);
        }
      }
      expect(emitted).toBe(source);
      expect(projection.text).toBe(expected.at(-1));
      expect(record(await stream.result(), "result message").content).toEqual(
        message(source).content,
      );
    }
  },
);
