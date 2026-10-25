import { describe, expect, it } from "vitest";
import {
  collectStream,
  replyContext,
  startSse,
  streamFixture,
  withServer,
  writeSse,
} from "./openai-completions-suite.test-support.js";
import { createOpenAICompletionsTransportStreamFn } from "./openai-completions-transport.js";
import {
  createDeepSeekCompletionsModel,
  expectedRecoveredTool,
  makeCompletionsChunk,
  makeCompletionsModel,
  openRouterAnthropicModel,
  openRouterModel,
} from "./openai-completions.test-support.js";

describe("openai completions DSML", () => {
  it("rejects a nested DSML wrapper before the original outer close", async () => {
    const { output, events, run } = streamFixture(createDeepSeekCompletionsModel());

    await expect(
      run([
        makeCompletionsChunk({ content: "<|DSML|tool_calls><|DSML|tool_" }),
        makeCompletionsChunk({
          content:
            'calls><|DSML|invoke name="read">{"path":"/tmp/nested.md"}</|DSML|invoke></|DSML|tool_calls>',
        }),
        makeCompletionsChunk({ content: "</|DSML|tool_calls>" }, "stop"),
      ]),
    ).rejects.toThrow("Nested DeepSeek DSML recovery wrappers are not supported");
    expect(events.filter((event) => event.type.startsWith("toolcall_"))).toEqual([]);
    expect(output.content.some((part) => part.type === "toolCall")).toBe(false);
  });

  it("does not accept a different DSML wrapper kind as the outer close", async () => {
    const { output, run } = streamFixture(createDeepSeekCompletionsModel());

    await run([
      makeCompletionsChunk({
        content:
          '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/mismatch.md"}</|DSML|invoke></|DSML|function_calls>',
      }),
      makeCompletionsChunk({}, "stop"),
    ]);

    expect(output.stopReason).toBe("stop");
    expect(output.content.some((part) => part.type === "toolCall")).toBe(false);
  });

  it("ignores an incomplete invoke-like prefix before a valid invoke", async () => {
    const { output, text } = streamFixture(createDeepSeekCompletionsModel());
    const content =
      "<|DSML|tool_calls>literal <|DSML|invoke marker " +
      '<|DSML|invoke name="read">{"path":"/tmp/valid.md"}</|DSML|invoke>' +
      "</|DSML|tool_calls>";

    await text(content);

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([expectedRecoveredTool("read", { path: "/tmp/valid.md" })]);
  });

  it("does not recover a nested call hidden inside a nameless invoke", async () => {
    const { output, events, run } = streamFixture(createDeepSeekCompletionsModel());
    const content =
      "<|DSML|tool_calls><|DSML|invoke><|DSML|tool_calls>" +
      '<|DSML|invoke name="read">{"path":"/tmp/bypass"}</|DSML|invoke>' +
      "</|DSML|tool_calls>";

    await run([makeCompletionsChunk({ content }), makeCompletionsChunk({}, "stop")]);

    expect(output.stopReason).toBe("stop");
    expect(events.filter((event) => event.type.startsWith("toolcall_"))).toEqual([]);
    expect(output.content.some((part) => part.type === "toolCall")).toBe(false);
  });

  it("does not authorize recovered DeepSeek DSML calls when the stream omits a terminal", async () => {
    const { output, run } = streamFixture(createDeepSeekCompletionsModel());

    await run([
      makeCompletionsChunk({
        content:
          '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/partial.md"}</|DSML|invoke></|DSML|tool_calls>',
      }),
    ]);

    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([]);
  });

  it.each([
    { finishReason: "content_filter", allowed: false, code: 'return "ready";' },
    { finishReason: "stop", allowed: true, code: "" },
    { finishReason: "length", allowed: false, code: "" },
  ])("gates HTTP DSML $finishReason '$code'", async ({ finishReason, allowed, code }) => {
    await withServer(
      (_req, res) => {
        startSse(res, true);
        const content = `<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="exec"><｜｜DSML｜｜parameter name="code" string="true">${code}</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜tool_calls>`;
        for (const char of content) {
          writeSse(res, makeCompletionsChunk({ content: char }));
        }
        writeSse(res, makeCompletionsChunk({}, finishReason));
        res.end("data: [DONE]\n\n");
      },
      async (baseUrl) => {
        const { events, terminal } = await collectStream(
          createOpenAICompletionsTransportStreamFn()(
            { ...createDeepSeekCompletionsModel(), baseUrl },
            replyContext("Read the file"),
            { apiKey: "test-key" },
          ),
        );
        const failed = finishReason === "content_filter";
        const reason = failed ? "error" : allowed ? "toolUse" : "length";
        expect(terminal).toMatchObject({
          type: failed ? "error" : "done",
          reason,
          [failed ? "error" : "message"]: {
            stopReason: reason,
            content: allowed ? [{ type: "toolCall", name: "exec", arguments: { code } }] : [],
            ...(failed ? { errorMessage: "Provider finish_reason: content_filter" } : {}),
          },
        });
        expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(
          allowed ? 1 : 0,
        );
        expect(events.filter((event) => event.type === "text_delta")).toEqual([]);
      },
    );
  });

  it("parses repeated DeepSeek DSML calls with response-unique ids", async () => {
    // Guards the cached attribute matchers: repeated parses must stay identical
    // apart from invocation identity (no stale RegExp lastIndex).
    const model = createDeepSeekCompletionsModel();
    const content =
      '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="session_status">\n<｜DSML｜parameter name="sessionKey" string="true">current</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>';

    const runOnce = async () => {
      const { output, run } = streamFixture(model);
      await run([makeCompletionsChunk({ content }, "stop")]);
      return output.content;
    };

    const first = await runOnce();
    const second = await runOnce();
    for (const resultContent of [first, second]) {
      expect(resultContent).toEqual([
        expectedRecoveredTool("session_status", { sessionKey: "current" }),
      ]);
    }
    expect((second[0] as { id?: string }).id).not.toBe((first[0] as { id?: string }).id);
  });

  it.each([
    {
      name: "empty parameter without a string attribute",
      body: '<|DSML|invoke name="read"><|DSML|parameter name="path"></|DSML|parameter></|DSML|invoke>',
    },
    {
      name: "foreign invoke close",
      body: '<|DSML|invoke name="read">{"path":"/tmp/unexecuted"}</｜DSML｜invoke>',
    },
    {
      name: "foreign parameter close",
      body: '<|DSML|invoke name="read"><|DSML|parameter name="path">/tmp/unexecuted</｜DSML｜parameter></|DSML|invoke>',
    },
  ])("does not authorize DSML with $name", async ({ body }) => {
    const { output, events, text } = streamFixture(createDeepSeekCompletionsModel());
    const content = `<|DSML|tool_calls>${body}</|DSML|tool_calls>`;
    await text(content);
    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([]);
    expect(events.filter((event) => event.type?.startsWith("toolcall_"))).toEqual([]);
  });

  it.each([
    openRouterModel,
    makeCompletionsModel({
      id: "deepseek-ai/DeepSeek-V4",
      provider: "aggregator",
      baseUrl: "https://llm.example/v1",
    }),
  ])("recovers DeepSeek DSML through $provider without leaking markup", async (model) => {
    const { output, events, text } = streamFixture(model);
    const content =
      '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/routed.md"}</|DSML|invoke></|DSML|tool_calls>';
    await text(content);
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([expectedRecoveredTool("read", { path: "/tmp/routed.md" })]);
    expect(events.filter((event) => event.type === "text_delta")).toEqual([]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it("hides truncated OpenRouter DSML without authorizing a tool call", async () => {
    const { output, events, run } = streamFixture(openRouterModel);
    await run([
      makeCompletionsChunk(
        { content: '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/trunc' },
        "length",
      ),
    ]);
    expect(output.stopReason).toBe("length");
    expect(output.content).toEqual([]);
    expect(
      events.filter((event) => event.type === "text_delta" || event.type === "toolcall_end"),
    ).toEqual([]);
  });

  it.each([
    { model: openRouterAnthropicModel, contentVisible: true },
    { model: openRouterModel, contentVisible: false },
  ])("keeps direct $model.id DSML non-executing", async ({ model, contentVisible }) => {
    const { output, events, run } = streamFixture(model);
    const content =
      '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/direct.md"}</|DSML|invoke></|DSML|tool_calls>';
    await run([makeCompletionsChunk({ content }, "stop")], {
      mode: "direct",
      beforeContentBlock() {},
    });
    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual(contentVisible ? [{ type: "text", text: content }] : []);
    expect(events.filter((event) => event.type?.startsWith("toolcall_"))).toEqual([]);
  });

  it("leaves non-DeepSeek OpenRouter markup as text", async () => {
    const { output, run } = streamFixture(openRouterAnthropicModel);
    const content =
      '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/not-deepseek.md"}</|DSML|invoke></|DSML|tool_calls>';
    await run([makeCompletionsChunk({ content }, "stop")]);
    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([{ type: "text", text: content }]);
  });

  it.each(["before", "same chunk", "after", "inside"])(
    "confirms only the native call when it arrives %s DSML",
    async (arrival) => {
      const { output, events, run } = streamFixture(openRouterModel);
      const content =
        '<|DSML|tool_calls><|DSML|invoke name="read">{"path":"/tmp/duplicate.md"}</|DSML|invoke></|DSML|tool_calls>';
      const native = {
        tool_calls: [
          {
            index: 0,
            id: "call_native",
            type: "function",
            function: { name: "read", arguments: '{"path":"/tmp/native.md"}' },
          },
        ],
      };
      const deltas =
        arrival === "same chunk"
          ? [{ content, ...native }]
          : arrival === "before"
            ? [native, { content }]
            : arrival === "after"
              ? [{ content }, native]
              : [{ content: content.slice(0, 60) }, native, { content: content.slice(60) }];
      await run([
        ...deltas.map((delta) => makeCompletionsChunk(delta)),
        makeCompletionsChunk({}, "tool_calls"),
      ]);
      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toEqual([
        {
          type: "toolCall",
          id: "call_native",
          name: "read",
          arguments: { path: "/tmp/native.md" },
        },
      ]);
      expect(events.filter((event) => event.type === "text_delta")).toEqual([]);
      expect(events.filter((event) => event.type === "toolcall_end")).toMatchObject([
        { toolCall: { id: "call_native" } },
      ]);
    },
  );
});
