import { describe, expect, it } from "vitest";
import { streamFixture } from "./openai-completions-suite.test-support.js";
import {
  expectedRecoveredTool,
  makeCompletionsChunk,
  makeCompletionsModel,
  makeCompletionsToolDelta,
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
    { label: "trailing", suffix: "" },
    { label: "mid-stream", suffix: "\n" },
  ])("recovers a $label call before stop", async ({ suffix }) => {
    const { output, events, text } = streamFixture(model);
    await text([call, suffix]);
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      expectedRecoveredTool("process", { action: "poll", sessionId: "example" }),
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
    const { output, text } = streamFixture(model);
    await text(content);
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
      const { output, events, text } = streamFixture(model);
      await text([call], reason);
      expect(output.stopReason).toBe(reason === "content_filter" ? "error" : (reason ?? "stop"));
      expect(output.content).toEqual([]);
      expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
    },
  );

  it.each([
    `\`\`\`\n${call}\n\`\`\``,
    `${call} is an example.`,
    call.replace("<tool_call|>", ""),
    call.replace('poll<|"|>', "poll"),
    call.replace("sessionId:", "sessionId"),
  ])("preserves non-call or incomplete text: %s", async (content) => {
    const { output, text } = streamFixture(model);
    await text([content]);
    expect(output.stopReason).toBe("stop");
    expect(output.content).toEqual([{ type: "text", text: content }]);
  });

  it("leaves other model families unchanged", async () => {
    const other = makeCompletionsModel({ id: "other-model" });
    const { output, text } = streamFixture(other);
    await text([call]);
    expect(output.content).toEqual([{ type: "text", text: call }]);
  });

  it("does not flush a cancelled call into executable events", async () => {
    const controller = new AbortController();
    const { output, events, runStream } = streamFixture(model);
    async function* chunks() {
      yield makeCompletionsChunk({ content: call });
      controller.abort();
    }
    await expect(runStream(chunks(), { signal: controller.signal })).rejects.toThrow();
    expect(output.content).toEqual([]);
    expect(events.some((event) => event.type === "toolcall_end")).toBe(false);
  });

  it.each([true, false])(
    "declines recovery with mixed native calls (raw first: %s)",
    async (rawFirst) => {
      const { output, events, run } = streamFixture(model);
      const raw = makeCompletionsChunk({ content: call });
      const native = makeCompletionsChunk(
        makeCompletionsToolDelta("native-call", "read", '{"path":"probe.txt"}'),
      );
      await run([
        ...(rawFirst ? [raw, native] : [native, raw]),
        makeCompletionsChunk({}, "tool_calls"),
      ]);
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
    const { run } = streamFixture(model);
    await expect(
      run([makeCompletionsChunk({ content: "<|tool_call>" + "x".repeat(256_001) })]),
    ).rejects.toThrow("Exceeded Gemma tool-call recovery buffer limit");
  });
});
