import { describe, expect, it } from "vitest";
import { readCodexImageGenerationResponse } from "./image-generation-codex-response.js";

function readEvents(events: unknown[]) {
  return readCodexImageGenerationResponse(
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")),
    { model: "gpt-image-2", mimeType: "image/png", extension: "png" },
  );
}

describe("Codex image response diagnostics", () => {
  it.each([
    {
      name: "completed refusal takes precedence over other provider text",
      streamed: [],
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "Discarded explanation" }],
        },
        {
          type: "message",
          content: [{ type: "refusal", refusal: "The provider declined this request." }],
        },
        { type: "image_generation_call", status: "failed" },
      ],
      reason: /refused.*The provider declined this request/,
      absent: /Discarded explanation/,
    },
    {
      name: "streamed explanation survives an empty completed snapshot",
      streamed: [
        { type: "image_generation_call", status: "failed" },
        {
          type: "message",
          content: [{ type: "output_text", text: "The requested image is unavailable." }],
        },
      ],
      output: [],
      reason: /The requested image is unavailable.*failed/,
      absent: /refused/,
    },
    {
      name: "completed explanation supersedes stale streamed refusal",
      streamed: [{ type: "message", content: [{ type: "refusal", refusal: "Stale refusal" }] }],
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "The final provider explanation." }],
        },
      ],
      reason: /The final provider explanation/,
      absent: /Stale refusal|refused/,
    },
  ])("preserves diagnostics when $name", async ({ streamed, output, reason, absent }) => {
    const result = readEvents([
      ...streamed.map((item) => ({ type: "response.output_item.done", item })),
      { type: "response.completed", response: { output } },
    ]);
    await expect(result).rejects.toThrow(reason);
    await expect(result).rejects.not.toThrow(absent);
  });

  it("bounds and sanitizes provider diagnostics without exposing safety metadata", async () => {
    const result = readEvents([
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "refusal",
              refusal: `Rejected \u0000request\u202e safety_violations=[private-details] ${"x".repeat(400)} beyond-limit`,
            },
          ],
        },
      },
    ]);
    await expect(result).rejects.toThrow(/Rejected request/);
    await expect(result).rejects.not.toThrow(/private-details|beyond-limit|x{257}/);
    await expect(result).rejects.not.toThrow("\u0000");
    await expect(result).rejects.not.toThrow("\u202e");
  });

  it("rejects malformed consumed event fields before image extraction", async () => {
    await expect(
      readEvents([
        { type: "response.completed", response: { output: { result: "not-an-array" } } },
      ]),
    ).rejects.toThrow(/malformed stream event/);
  });

  it("accepts nullable optional wire fields without losing completed image bytes", async () => {
    const image = Buffer.from("completed image");
    const result = await readEvents([
      {
        type: "response.completed",
        response: {
          error: null,
          incomplete_details: null,
          output: [
            {
              type: "image_generation_call",
              result: image.toString("base64"),
              status: null,
              revised_prompt: null,
              content: null,
            },
          ],
          usage: { total_tokens: 1 },
        },
      },
    ]);
    expect(result.images).toEqual([
      { buffer: image, mimeType: "image/png", fileName: "image-1.png" },
    ]);
    expect(result.metadata).toMatchObject({ usage: { total_tokens: 1 } });
  });
});
