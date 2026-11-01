import { sanitizeResponsesImagePayload } from "@openclaw/ai/transports";
import "../llm/ai-transport-host.js";
import type { Context, Model } from "@openclaw/llm-core";
// Verifies Responses image payloads are canonicalized or replaced before send.
import { describe, expect, it, vi } from "vitest";
import { createResponsesV2CompactionCollector } from "../../packages/ai/src/transports/openai-responses-compaction-v2.js";
import { RESPONSES_RETAINED_USER } from "../../packages/ai/src/transports/openai-responses-contracts.js";
import { convertResponsesMessages } from "../../packages/ai/src/transports/openai-responses-replay-messages-internal.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";

const PNG_1X1 =
  // Valid JPEG-labeled data is sniffed as PNG and normalized to the real MIME type.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=";
const HEIC_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0x00, 0x00, 0x00, 0x00,
]).toString("base64");

describe("Responses image payload sanitizer", () => {
  it("preserves immutable text history through sanitation while detaching mutable and image inputs", () => {
    const text = freezeJsonSnapshot({
      type: "message" as const,
      role: "user" as const,
      content: [{ type: "input_text" as const, text: "retained question" }],
      [RESPONSES_RETAINED_USER]: true,
    });
    const mutable = {
      ...text,
      content: [{ type: "input_text" as const, text: "current question" }],
    };
    const image = freezeJsonSnapshot({
      ...text,
      content: [
        {
          type: "input_image" as const,
          detail: "auto" as const,
          image_url: "data:image/png;base64,invalid!",
        },
      ],
    });
    const request = {
      model: "fixture-model",
      stream: true as const,
      input: [text, mutable, image],
    };
    const collector = createResponsesV2CompactionCollector();
    const first = collector.sanitizeImages(request);
    const second = collector.sanitizeImages(request);
    expect(first.input).not.toBe(request.input);
    expect(first.input?.[0]).toBe(text);
    expect(second.input?.[0]).toBe(text);
    expect(first.input?.[1]).not.toBe(mutable);
    expect(first.input?.[2]).not.toBe(image);
    expect(second.input?.[2]).not.toBe(first.input?.[2]);
    expect(first.input?.[2]).toMatchObject({ [RESPONSES_RETAINED_USER]: true });
    expect(JSON.stringify(first.input?.[2])).toBe(
      '{"type":"message","role":"user","content":[{"type":"input_text","text":"[omitted image payload: invalid inline image data]"}]}',
    );
    mutable.content[0]!.text = "edited question";
    expect(JSON.stringify(first.input?.[1])).toContain("current question");
    expect(JSON.stringify(collector.sanitizeImages(request).input?.[1])).toContain(
      "edited question",
    );
  });

  it("replaces malformed input_image data URLs before sending Responses payloads", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "function_call_output",
          call_id: "call_1",
          output: [{ type: "input_image", image_url: "data:image/jpeg;base64,not base64!" }],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          {
            type: "input_text",
            text: "[omitted image payload: invalid inline image data]",
          },
        ],
      },
    ]);
  });

  it("canonicalizes valid inline image payloads and keeps URL image references", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_image", image_url: `data:image/jpeg;base64,\n${PNG_1X1}` },
            { type: "input_image", image_url: "https://example.test/image.png" },
          ],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_image", image_url: `data:image/png;base64,${PNG_1X1}` },
          { type: "input_image", image_url: "https://example.test/image.png" },
        ],
      },
    ]);
  });

  it("replaces HEIC inline image data URLs before Responses transport", () => {
    const sanitized = sanitizeResponsesImagePayload({
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: `data:image/heic;base64,${HEIC_HEADER}` }],
        },
      ],
    });

    expect(sanitized.input).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: "[omitted image payload: invalid inline image data]",
          },
        ],
      },
    ]);
  });
});

it.each([
  { name: "canonical", mimeType: "image/png", data: PNG_1X1 },
  { name: "MIME normalization", mimeType: "image/jpeg", data: PNG_1X1 },
  { name: "whitespace normalization", mimeType: "image/png", data: `\n${PNG_1X1}\n` },
  { name: "padding normalization", mimeType: "image/png", data: PNG_1X1.replace(/=+$/, "") },
])("reuses $name image work without sharing mutable request items", ({ mimeType, data }) => {
  const image = { type: "image" as const, mimeType, data };
  const model: Model = {
    id: "fixture-model",
    name: "Synthetic",
    provider: "openai",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 200000,
    maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const context: Context = { messages: [{ role: "user", content: [image], timestamp: 0 }] };
  const build = () => ({ input: convertResponsesMessages(model, context, new Set(["openai"])) });
  const decode = vi.spyOn(Buffer, "from");
  try {
    const initial = build();
    const first = sanitizeResponsesImagePayload(initial);
    const expected =
      '[{"type":"message","role":"user","content":[{"type":"input_image","detail":"auto","image_url":"data:image/png;base64,' +
      PNG_1X1 +
      '"}]}]';
    expect(JSON.stringify(first.input)).toBe(expected);
    // Another conversation must not evict the first image's prepared work.
    sanitizeResponsesImagePayload({
      input: convertResponsesMessages(
        model,
        {
          messages: [{ role: "user", content: [{ ...image }], timestamp: 1 }],
        },
        new Set(["openai"]),
      ),
    });
    decode.mockClear();
    const next = build();
    expect(next.input[0]).not.toBe(initial.input[0]);
    expect(JSON.stringify(sanitizeResponsesImagePayload(next).input)).toBe(expected);
    expect(decode).not.toHaveBeenCalled();

    // A hook may rewrite an existing item; the unchanged source cannot bless that URL.
    const item = next.input[0];
    if (item?.type !== "message" || !Array.isArray(item.content)) {
      throw new Error("missing image");
    }
    const part = item.content[0];
    if (part?.type !== "input_image") {
      throw new Error("missing image");
    }
    part.image_url = "data:image/png;base64,invalid!";
    expect(JSON.stringify(sanitizeResponsesImagePayload(next))).toContain("omitted image payload");
    expect(JSON.stringify(sanitizeResponsesImagePayload(build()).input)).toBe(expected);

    // In-place transcript edits and replacements must be observed on the next request.
    image.data = HEIC_HEADER;
    expect(JSON.stringify(sanitizeResponsesImagePayload(build()))).toContain(
      "omitted image payload",
    );
    decode.mockClear();
    expect(JSON.stringify(sanitizeResponsesImagePayload(build()))).toContain(
      "omitted image payload",
    );
    expect(decode).not.toHaveBeenCalled();
    image.data = PNG_1X1;
    image.mimeType = "text/plain";
    expect(JSON.stringify(sanitizeResponsesImagePayload(build()))).toContain(
      "omitted image payload",
    );
    context.messages = [
      { role: "user", content: [{ ...image, mimeType: "image/png" }], timestamp: 0 },
    ];
    expect(JSON.stringify(sanitizeResponsesImagePayload(build()).input)).toBe(expected);
    // Frozen image history keeps preparation reusable and hook input editable.
    context.messages.forEach(freezeJsonSnapshot);
    const hookInput = () => ({
      input: convertResponsesMessages(model, context, new Set(["openai"]), { mutableInput: true }),
    });
    sanitizeResponsesImagePayload(hookInput());
    decode.mockClear();
    const detached = hookInput();
    expect(JSON.stringify(sanitizeResponsesImagePayload(detached).input)).toBe(expected);
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});
