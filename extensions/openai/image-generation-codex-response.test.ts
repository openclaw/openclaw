import { expect, it } from "vitest";
import { readCodexImageGenerationResponse } from "./image-generation-codex-response.js";

const format = { model: "gpt-image-2", mimeType: "image/png", extension: "png" };
function readOutput(output: unknown, streamed: unknown[] = [], fields = {}) {
  const events = [
    ...streamed.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { output, ...fields } },
  ];
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return readCodexImageGenerationResponse(new Response(body), format);
}
function message(type: "output_text" | "refusal", text: string) {
  return { type: "message", content: [{ type, [type === "refusal" ? "refusal" : "text"]: text }] };
}

it.each([
  {
    name: "completed refusal takes precedence over other provider text",
    streamed: [],
    output: [
      message("output_text", "Discarded explanation"),
      message("refusal", "The provider declined this request."),
      { type: "image_generation_call", status: "failed" },
    ],
    reason: /refused.*The provider declined this request/,
    absent: /Discarded explanation/,
  },
  {
    name: "streamed explanation survives an empty completed snapshot",
    streamed: [
      { type: "image_generation_call", status: "failed" },
      message("output_text", "The requested image is unavailable."),
    ],
    output: [],
    reason: /The requested image is unavailable.*failed/,
    absent: /refused/,
  },
  {
    name: "completed explanation supersedes stale streamed refusal",
    streamed: [message("refusal", "Stale refusal")],
    output: [message("output_text", "The final provider explanation.")],
    reason: /The final provider explanation/,
    absent: /Stale refusal|refused/,
  },
])("preserves diagnostics when $name", async ({ streamed, output, reason, absent }) => {
  const result = readOutput(output, streamed);
  await expect(result).rejects.toThrow(reason);
  await expect(result).rejects.not.toThrow(absent);
});

it("bounds and sanitizes provider diagnostics without exposing safety metadata", async () => {
  const result = readOutput([
    {
      type: "refusal",
      refusal: `Rejected \u0000request\u202e safety_violations=[private-details] ${"x".repeat(400)} beyond-limit`,
    },
  ]);
  await expect(result).rejects.toThrow(/Rejected request/);
  await expect(result).rejects.not.toThrow(/private-details|beyond-limit|x{257}/);
  for (const control of ["\u0000", "\u202e"]) {
    await expect(result).rejects.not.toThrow(control);
  }
});

it("rejects malformed consumed event fields before image extraction", async () => {
  await expect(readOutput({ result: "not-an-array" })).rejects.toThrow(/malformed stream event/);
});

it("accepts nullable optional wire fields without losing completed image bytes", async () => {
  const image = Buffer.from("completed image");
  const output = {
    type: "image_generation_call",
    result: image.toString("base64"),
    status: null,
    revised_prompt: null,
    content: null,
  };
  const result = await readOutput([output], [], {
    error: null,
    incomplete_details: null,
    usage: { total_tokens: 1 },
  });
  expect(result.images).toEqual([
    { buffer: image, mimeType: "image/png", fileName: "image-1.png" },
  ]);
  expect(result.metadata).toMatchObject({ usage: { total_tokens: 1 } });
});

it.each(["completed", "streamed"])(
  "preserves returned image settings from %s output",
  async (source) => {
    const buffer = Buffer.from("89504e470d0a1a0a", "hex");
    const item = {
      type: "image_generation_call",
      result: buffer.toString("base64"),
      quality: "low",
    };
    const events = [
      { type: "response.output_item.done", item: { ...item, quality: "medium" } },
      { type: "response.completed", response: { output: source === "completed" ? [item] : [] } },
    ];
    const result = await readCodexImageGenerationResponse(
      new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
      { model: "gpt-image-2", mimeType: "image/jpeg" },
    );
    expect(result.images).toEqual([
      {
        buffer,
        mimeType: "image/png",
        fileName: "image-1.png",
        metadata: { quality: source === "completed" ? "low" : "medium" },
      },
    ]);
  },
);
