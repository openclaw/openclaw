import type { AssistantMessageEvent } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { createBodyPreview } from "./body-preview.js";
import { processCompletionsStream } from "./openai-completions-stream.js";
import {
  createAssistantOutput,
  makeCompletionsChunk,
  makeCompletionsModel,
} from "./openai-completions.test-support.js";

const model = makeCompletionsModel({
  id: "deepseek-v4-flash",
  provider: "deepseek-official",
  baseUrl: "https://api.deepseek.com",
});
type Preview = Extract<AssistantMessageEvent, { type: "text_preview" }>;

async function replay(
  deltas: Record<string, unknown>[],
  enabled: boolean | null = true,
  fail = false,
  selected = model,
  direct = false,
  signal?: AbortSignal,
) {
  const output = createAssistantOutput(selected);
  const events: AssistantMessageEvent[] = [];
  let beforeTerminal: Preview[] = [];
  async function* chunks() {
    for (const delta of deltas) {
      yield makeCompletionsChunk(delta);
    }
    beforeTerminal = events
      .filter((e): e is Preview => e.type === "text_preview")
      .map((e) => structuredClone(e));
    if (fail) {
      throw new Error("synthetic broken stream");
    }
    yield makeCompletionsChunk({}, "stop");
  }
  let error: unknown;
  try {
    await processCompletionsStream(
      chunks(),
      output,
      selected,
      {
        push: (e) => events.push(structuredClone(e)),
      },
      {
        ...(enabled === null ? {} : { bodyPreview: enabled }),
        signal,
        ...(direct
          ? {
              mode: "direct" as const,
              beforeContentBlock() {},
              provisionalCommentaryTags: new Map(),
            }
          : {}),
      },
    );
  } catch (e) {
    error = e;
  }
  return {
    output,
    events,
    beforeTerminal,
    error,
    previews: events.filter((e): e is Preview => e.type === "text_preview"),
  };
}

describe("opt-in public body previews", () => {
  it("bounds cumulative snapshot work for finely chunked long responses", () => {
    let copiedCharacters = 0;
    let snapshots = 0;
    let latest = "";
    const preview = createBodyPreview(false, (event) => {
      if (event.type === "text_preview" && !event.reset) {
        copiedCharacters += event.text.length;
        snapshots++;
        latest = event.text;
      }
    });
    const characters = 100_000;
    for (let index = 0; index < characters; index++) {
      preview.content("a");
    }
    expect(snapshots).toBeGreaterThan(1);
    expect(copiedCharacters).toBeLessThan(characters * 40);
    expect(latest.length).toBeGreaterThan(characters * 0.96);
    preview.stop();
  });

  it("grows before terminal while canonical reasoning and final output match the default", async () => {
    const input = [
      { reasoning_content: "PRIVATE_NATIVE" },
      { content: "First paragraph.\n\n" },
      { content: "Second paragraph.\n\n" },
      { content: "Third paragraph.\n\n" },
    ];
    const off = await replay(input, false);
    const on = await replay(input);
    expect(off.previews).toEqual([]);
    expect(on.beforeTerminal.map((p) => p.text)).toEqual([
      "First paragraph.\n\n",
      "First paragraph.\n\nSecond paragraph.\n\n",
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n",
    ]);
    expect(on.output.content).toEqual(off.output.content);
    expect(on.output.openclawDelivery).toEqual(off.output.openclawDelivery);
    expect(on.output.openclawDelivery?.textPhaseRequiresTerminal).toBe(true);
    expect(on.beforeTerminal.every((p) => !p.text.includes("PRIVATE_NATIVE"))).toBe(true);
  });

  it.each([
    ["split reasoning", ["Visible ", "<thi", "nk>PRIVATE_TAG", "</think>", " answer.\n\n"]],
    ["unclosed reasoning", ["Visible ", "<think>PRIVATE_TAG"]],
    [
      "nested reasoning",
      ["Visible <think>PRIVATE_TAG<think>PRIVATE_NESTED</think></think> answer.\n\n"],
    ],
    [
      "DSML",
      [
        'Visible <|DSML|tool_calls><|DSML|invoke name="exec">PRIVATE_TOOL',
        "</|DSML|tool_calls> answer.\n\n",
      ],
    ],
  ])("filters %s without exposing it in any snapshot", async (_name, chunks) => {
    const r = await replay([
      { reasoning_content: "PRIVATE_NATIVE" },
      ...(chunks as string[]).map((content) => ({ content })),
    ]);
    expect(r.error).toBeUndefined();
    expect(r.beforeTerminal.length).toBeGreaterThan(0);
    expect(r.previews.every((e) => !/PRIVATE|DSML/.test(e.text))).toBe(true);
  });

  it("preserves literal tag examples in code and never previews reasoning details", async () => {
    const r = await replay([
      { reasoning_content: "PRIVATE_NATIVE" },
      { content: "Example: `<think>literal</think>`\n\n" },
      { reasoning_details: [{ type: "reasoning.text", text: "PRIVATE_DETAILS" }] },
    ]);
    expect(r.previews.some((p) => p.text.includes("`<think>literal</think>`"))).toBe(true);
    expect(r.previews.every((p) => !p.text.includes("PRIVATE"))).toBe(true);
  });

  it("replaces interim text after resumed native reasoning", async () => {
    const r = await replay([
      { reasoning_content: "PRIVATE" },
      { content: "Interim.\n\n" },
      { reasoning_content: "PRIVATE_AGAIN" },
      { content: "Final.\n\n" },
    ]);
    expect(r.beforeTerminal.map((p) => [p.text, p.reset])).toEqual([
      ["Interim.\n\n", false],
      ["", true],
      ["Final.\n\n", false],
    ]);
    expect(new Set(r.previews.map((p) => p.previewId)).size).toBe(1);
    expect(r.previews.map((p) => p.revision)).toEqual([1, 2, 3]);
  });

  it("clears on a tool boundary and does not expose arguments or following text", async () => {
    const r = await replay([
      { content: "Before tool.\n\n" },
      {
        tool_calls: [
          {
            index: 0,
            id: "call_test",
            type: "function",
            function: { name: "test", arguments: '{"private":"PRIVATE_TOOL"}' },
          },
        ],
      },
      { content: "PRIVATE_POST_TOOL" },
    ]);
    expect(r.previews.map((p) => [p.text, p.reset])).toEqual([
      ["Before tool.\n\n", false],
      ["", true],
    ]);
  });

  it("clears failed streams without promoting their preview", async () => {
    const r = await replay(
      [{ reasoning_content: "PRIVATE" }, { content: "Unfinished.\n\n" }],
      true,
      true,
    );
    expect(r.error).toBeInstanceOf(Error);
    expect(r.previews.at(-1)).toMatchObject({ text: "", reset: true });
  });

  it("supports configured providers and models without an allowlist", async () => {
    for (const selected of [
      { ...model, provider: "other" },
      { ...model, id: "other" },
    ]) {
      expect(
        (await replay([{ content: "Hello.\n\n" }], true, false, selected)).previews,
      ).toMatchObject([{ text: "Hello.\n\n", reset: false }]);
    }
  });
  it("supports the direct completions adapter without changing its terminal result", async () => {
    const deltas = [{ reasoning_content: "PRIVATE" }, { content: "Public answer.\n\n" }];
    const on = await replay(deltas, true, false, model, true);
    const off = await replay(deltas, false, false, model, true);
    expect(on.error).toBeUndefined();
    expect(on.beforeTerminal).toMatchObject([{ text: "Public answer.\n\n" }]);
    expect(on.output.content).toEqual(off.output.content);
  });

  it("bounds previews without failing the canonical stream", async () => {
    const r = await replay([{ content: "Visible.\n\n" }, { content: "x".repeat(256_001) }]);
    expect(r.error).toBeUndefined();
    expect(r.previews.at(-1)).toMatchObject({ text: "", reset: true });
    expect(r.output.content.some((c) => c.type === "text" && c.text.length > 256_000)).toBe(true);
  });

  it("retains open reasoning-tag ownership across native reasoning", async () => {
    const r = await replay([
      { content: "Visible <thi" },
      { reasoning_content: "PRIVATE_NATIVE" },
      { content: "nk>PRIVATE_TAG</think> Public.\n\n" },
    ]);
    expect(r.previews.every((p) => !p.text.includes("PRIVATE"))).toBe(true);
  });

  it("filters native reasoning mirrored in content and previews refusals", async () => {
    const r = await replay([
      {
        reasoning_content: [{ type: "reasoning", text: "PRIVATE_MIRROR" }],
        content: [{ type: "reasoning", text: "PRIVATE_MIRROR" }],
      },
      { refusal: "I cannot do that.\n\n" },
    ]);
    expect(r.previews.every((p) => !p.text.includes("PRIVATE"))).toBe(true);
    expect(r.previews.some((p) => p.text.includes("I cannot do that."))).toBe(true);
  });

  it("emits no previews when the option is omitted", async () => {
    expect((await replay([{ content: "Public.\n\n" }], null)).previews).toEqual([]);
  });

  it("clears a preview when cancellation occurs during the stream", async () => {
    const controller = new AbortController();
    const events: AssistantMessageEvent[] = [];
    async function* chunks() {
      yield makeCompletionsChunk({ content: "Unfinished.\n\n" });
      controller.abort();
      yield makeCompletionsChunk({}, "stop");
    }
    await expect(
      processCompletionsStream(
        chunks(),
        createAssistantOutput(model),
        model,
        { push: (event) => events.push(structuredClone(event)) },
        { bodyPreview: true, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(events.findLast((event) => event.type === "text_preview")).toMatchObject({
      text: "",
      reset: true,
    });
  });
});
