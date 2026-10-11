import { describe, expect, it } from "vitest";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  type CapturedStreamEvent,
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
  streamChunks,
} from "./openai-completions.test-support.js";

const model = makeCompletionsModel({
  id: "google/gemma-4-e4b",
  provider: "lmstudio",
  baseUrl: "http://127.0.0.1:1234/v1",
});
const call =
  '<|tool_call>call:process{action:<|"|>poll<|"|>,sessionId:<|"|>example<|"|>}<tool_call|>';

describe("Gemma tool-call text recovery", () => {
  it.each([
    { label: "trailing", suffix: "", split: false },
    { label: "mid-stream", suffix: "\n", split: false },
    { label: "fragmented trailing", suffix: "", split: true },
  ])("recovers a $label call before stop", async ({ suffix, split }) => {
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    const content = call + suffix;
    await processCompletionsStream(
      streamChunks([
        ...(split ? Array.from(content) : [call, suffix]).map((text) =>
          makeCompletionsChunk({ content: text }),
        ),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      { push: (event) => events.push(event) },
    );
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: expect.stringMatching(/^call_[0-9a-f]{24}$/),
        name: "process",
        arguments: { action: "poll", sessionId: "example" },
      },
      ...(suffix ? [{ type: "text", text: suffix }] : []),
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .map((event) => event.delta)
        .join(""),
    ).toBe(suffix);
  });

  it("preserves raw strings, nested values and distinct identities in a call batch", async () => {
    const raw = 'quotes " and \\slashes\n<tool_call|> <think>literal</think> {a:b}';
    const args = `{path:<|"|>${raw}<|"|>,options:{enabled:true,limit:2,items:[null,false,<|"|><|"|>]},<|"|>quoted key<|"|>:<|"|>value<|"|>}`;
    const content = `<|tool_call>call:read${args}<tool_call|>\n<|tool_call>call:status{}<tool_call|>`;
    const output = createAssistantOutput(model);
    await processCompletionsStream(
      streamChunks([
        ...Array.from(content, (text) => makeCompletionsChunk({ content: text })),
        makeCompletionsChunk({}, "stop"),
      ]),
      output,
      model,
      { push() {} },
    );
    expect(output.stopReason).toBe("toolUse");
    const calls = output.content.filter((block) => block.type === "toolCall");
    expect(calls).toMatchObject([
      {
        name: "read",
        arguments: {
          path: raw,
          options: { enabled: true, limit: 2, items: [null, false, ""] },
          "quoted key": "value",
        },
      },
      { name: "status", arguments: {} },
    ]);
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
  });

  it.each(["length", "content_filter", null])(
    "does not authorize a call on %s termination",
    async (reason) => {
      const output = createAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      await processCompletionsStream(
        streamChunks([
          makeCompletionsChunk({ content: call }),
          ...(reason ? [makeCompletionsChunk({}, reason)] : []),
        ]),
        output,
        model,
        { push: (event) => events.push(event) },
      );
      expect(output.stopReason).toBe(reason === "content_filter" ? "error" : (reason ?? "stop"));
      expect(output.content).toEqual([]);
      expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
    },
  );

  it.each([
    `Example: ${call}`,
    `\`\`\`\n${call}\n\`\`\``,
    `${call} is an example.`,
    call.replace("<tool_call|>", ""),
    call.replace('poll<|"|>', "poll"),
    call.replace("sessionId:", "sessionId"),
    "<|tool_",
    "<|tool_call>call:read{limit:1 2}<tool_call|>",
    "<|tool_call>call:process{,:1}<tool_call|>",
    "<|tool_call>call:process{[:1}<tool_call|>",
    "<|tool_call>call:process{::1}<tool_call|>",
  ])("preserves non-call or incomplete text: %s", async (content) => {
    const output = createAssistantOutput(model);
    await processCompletionsStream(
      streamChunks([makeCompletionsChunk({ content }), makeCompletionsChunk({}, "stop")]),
      output,
      model,
      { push() {} },
    );
    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([{ type: "text", text: content }]);
  });

  it("leaves other model families unchanged", async () => {
    const other = makeCompletionsModel({ id: "other-model" });
    const output = createAssistantOutput(other);
    await processCompletionsStream(
      streamChunks([makeCompletionsChunk({ content: call }, "stop")]),
      output,
      other,
      { push() {} },
    );
    expect(output.content).toEqual([{ type: "text", text: call }]);
  });

  it("does not flush a cancelled call into executable events", async () => {
    const controller = new AbortController();
    const output = createAssistantOutput(model);
    const events: CapturedStreamEvent[] = [];
    async function* chunks() {
      yield makeCompletionsChunk({ content: call });
      controller.abort();
    }
    await expect(
      processCompletionsStream(
        chunks(),
        output,
        model,
        {
          push: (event) => events.push(event),
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(output.content).toEqual([]);
    expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
  });

  it.each([true, false])(
    "declines recovery with mixed native calls (raw first: %s)",
    async (rawFirst) => {
      const output = createAssistantOutput(model);
      const events: CapturedStreamEvent[] = [];
      const raw = makeCompletionsChunk({ content: call });
      const native = makeCompletionsChunk({
        tool_calls: [
          {
            index: 0,
            id: "native-call",
            type: "function",
            function: { name: "read", arguments: '{"path":"probe.txt"}' },
          },
        ],
      });
      await processCompletionsStream(
        streamChunks([
          ...(rawFirst ? [raw, native] : [native, raw]),
          makeCompletionsChunk({}, "tool_calls"),
        ]),
        output,
        model,
        { push: (event) => events.push(event) },
      );
      const text = { type: "text", text: call };
      const tool = {
        type: "toolCall",
        id: "native-call",
        name: "read",
        arguments: { path: "probe.txt" },
      };
      expect(output.stopReason).toBe("toolUse");
      expect(output.content).toMatchObject(rawFirst ? [text, tool] : [tool, text]);
      expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
    },
  );

  it("bounds buffered candidates", async () => {
    const output = createAssistantOutput(model);
    await expect(
      processCompletionsStream(
        streamChunks([makeCompletionsChunk({ content: "<|tool_call>" + "x".repeat(256_001) })]),
        output,
        model,
        { push() {} },
      ),
    ).rejects.toThrow("Exceeded Gemma tool-call recovery buffer limit");
  });
});
