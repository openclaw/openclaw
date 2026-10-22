// Coverage for promoting standalone text tool calls into structured events.

import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  collectStreamEvents,
  createFakeStream,
  type FakeWrappedStream,
} from "./attempt-stream.test-helpers.js";
import { wrapStreamFnPromoteStandaloneTextToolCalls } from "./attempt-tool-call-text-promotion.js";

const requireRecord = createRequireRecord("object", "expected-label");

async function promote(
  resultMessage: { role: string; content: unknown[]; stopReason: string },
  events: unknown[],
  toolName: string,
) {
  const baseFn = vi.fn(() =>
    createFakeStream({
      events: [
        ...events,
        { type: "done", reason: resultMessage.stopReason, message: resultMessage },
      ],
      resultMessage,
    }),
  );
  const wrapped = wrapStreamFnPromoteStandaloneTextToolCalls(baseFn as never, new Set([toolName]));
  const stream = (await wrapped({} as never, {} as never, {} as never)) as FakeWrappedStream;
  return {
    events: await collectStreamEvents(stream),
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

function promoteText(text: string, toolName: string, prefix = text, stopReason = "stop") {
  const deltas = prefix === text ? [text] : [prefix, text.slice(prefix.length)];
  return promote(
    { role: "assistant", content: [{ type: "text", text }], stopReason },
    deltas.map((delta) => ({ type: "text_delta", contentIndex: 0, delta })),
    toolName,
  );
}

describe("wrapStreamFnPromoteStandaloneTextToolCalls", () => {
  it("promotes serialized tool calls split across adjacent text blocks", async () => {
    const resultMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "[tool:exec]\n<parameter=command>\n" },
        { type: "text", text: "pwd\n</parameter>\n</function>" },
        { type: "thinking", thinking: "Checking location." },
      ],
      stopReason: "stop",
    };
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

  it("buffers case-insensitive tool-name prefixes until final promotion", async () => {
    const rawToolText = `[tool:read]\n${parameter("path", "src/index.ts")}`;
    const { events, result } = await promoteText(rawToolText, "Read", "[tool:rea");

    expectToolEvents(events);
    expect(result.stopReason).toBe("toolUse");
    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "Read",
      arguments: { path: "src/index.ts" },
    });
  });

  it("buffers normalized alias tool-name prefixes until final promotion", async () => {
    const rawToolText = `[tool:bash]\n${parameter("command", "pwd")}`;
    const { events, result } = await promoteText(rawToolText, "exec", "[tool:ba");

    expectToolEvents(events);
    expect(requireRecord((result.content as unknown[])[0], "tool call")).toMatchObject({
      type: "toolCall",
      name: "exec",
      arguments: { command: "pwd" },
    });
  });

  it.each([
    {
      label: "case-insensitive name",
      allowedToolName: "Read",
      emittedToolName: "READ",
      expectedToolName: "Read",
      parameterName: "path",
      parameterValue: "src/index.ts",
    },
    {
      label: "normalized alias",
      allowedToolName: "exec",
      emittedToolName: "bash",
      expectedToolName: "exec",
      parameterName: "command",
      parameterValue: "pwd",
    },
  ])(
    "promotes $label XML consistently when the terminal reason is toolUse",
    async ({
      allowedToolName,
      emittedToolName,
      expectedToolName,
      parameterName,
      parameterValue,
    }) => {
      const rawToolText = `<function=${emittedToolName}>\n${parameter(parameterName, parameterValue)}`;
      const { events, result } = await promoteText(
        rawToolText,
        allowedToolName,
        rawToolText,
        "toolUse",
      );
      const expectedArguments = { [parameterName]: parameterValue };
      const expectedContent = [
        {
          type: "toolCall",
          id: expect.stringMatching(/^call_[a-f0-9]{24}$/),
          name: expectedToolName,
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
