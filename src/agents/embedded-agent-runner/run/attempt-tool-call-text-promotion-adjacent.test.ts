import { describe, expect, it } from "vitest";
import {
  assistantMessage,
  collectPromotionEvents,
  createPromotionStream,
  record as requireRecord,
} from "./attempt-tool-call-text-promotion.test-support.js";

async function promote(
  resultMessage: { role: string; content: unknown[]; stopReason: string },
  events: unknown[],
  toolName: string,
) {
  const stream = await createPromotionStream(
    {
      events: [
        ...events,
        { type: "done", reason: resultMessage.stopReason, message: resultMessage },
      ],
      resultMessage,
    },
    toolName,
  );
  return {
    events: await collectPromotionEvents(stream),
    result: requireRecord(await stream.result(), "result message"),
  };
}

function expectToolEvents(events: unknown[], thinking = false) {
  expect(events.map((event) => requireRecord(event, "event").type)).toEqual([
    "start",
    "toolcall_start",
    "toolcall_delta",
    "toolcall_end",
    ...(thinking ? ["thinking_delta"] : []),
    "done",
  ]);
}

const parameter = (name: string, value: string) =>
  `<parameter=${name}>\n${value}\n</parameter>\n</function>`;

describe("wrapStreamFnPromoteStandaloneTextToolCalls", () => {
  it("promotes serialized tool calls split across adjacent text blocks", async () => {
    const resultMessage = assistantMessage([
      { type: "text", text: "[tool:exec]\n<parameter=command>\n" },
      { type: "text", text: "pwd\n</parameter>\n</function>" },
      { type: "thinking", thinking: "Checking location." },
    ]);
    const { events, result } = await promote(
      resultMessage,
      [
        { type: "text_delta", contentIndex: 0, delta: "[tool:exec]\n<parameter=command>\n" },
        { type: "text_delta", contentIndex: 1, delta: "pwd\n</parameter>\n</function>" },
        {
          type: "thinking_delta",
          contentIndex: 2,
          delta: "Checking location.",
          partial: { content: resultMessage.content },
        },
      ],
      "exec",
    );

    expectToolEvents(events, true);
    expect(requireRecord(events[4], "thinking event").contentIndex).toBe(1);
    expect(requireRecord(events[1], "toolcall start").contentIndex).toBe(0);
    expect((result.content as Array<Record<string, unknown>>).map((block) => block.type)).toEqual([
      "toolCall",
      "thinking",
    ]);
    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      name: "exec",
      arguments: { command: "pwd" },
    });
  });

  it.each([
    ["case-insensitive prefix", "Read", "[tool:read]", "path", "src/index.ts", "[tool:rea", "stop"],
    ["alias prefix", "exec", "[tool:bash]", "command", "pwd", "[tool:ba", "stop"],
    ["case-insensitive toolUse", "Read", "<function=READ>", "path", "src/index.ts", "", "toolUse"],
    ["alias toolUse", "exec", "<function=bash>", "command", "pwd", "", "toolUse"],
  ])(
    "promotes %s consistently across stream and terminal output",
    async (_label, allowedToolName, marker, parameterName, parameterValue, prefix, stopReason) => {
      const rawToolText = `${marker}\n${parameter(parameterName, parameterValue)}`;
      const deltas = prefix ? [prefix, rawToolText.slice(prefix.length)] : [rawToolText];
      const { events, result } = await promote(
        { role: "assistant", content: [{ type: "text", text: rawToolText }], stopReason },
        deltas.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
        allowedToolName,
      );
      const expectedArguments = { [parameterName]: parameterValue };
      const expectedContent = [
        {
          type: "toolCall",
          id: expect.stringMatching(/^call_[a-f0-9]{24}$/),
          name: allowedToolName,
          arguments: expectedArguments,
        },
      ];

      expectToolEvents(events);
      expect(requireRecord(events[2], "toolcall delta").delta).toBe(
        JSON.stringify(expectedArguments),
      );
      expect(requireRecord(events[2], "toolcall delta").partial).toMatchObject({
        content: [{ partialJson: JSON.stringify(expectedArguments) }],
      });
      const doneEvent = requireRecord(events[4], "done event");
      expect(doneEvent.reason).toBe("toolUse");
      expect(requireRecord(doneEvent.message, "done message").content).toEqual(expectedContent);
      expect(result).toMatchObject({ role: "assistant", stopReason: "toolUse" });
      expect(result.content).toEqual(expectedContent);
    },
  );
});
