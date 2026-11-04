import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "openclaw/plugin-sdk/llm";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { getImageMetadata, resizeToJpeg } from "openclaw/plugin-sdk/media-runtime";
import {
  buildAssistantMessage,
  createEmptyTransportUsage,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { beforeEach, expect, it, vi } from "vitest";
import { XAI_BASE_URL } from "./model-definitions.js";
import { wrapXaiProviderStream } from "./stream.js";
import { xaiModel } from "./test-helpers.js";

const requests = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock("openai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openai")>()),
  default: class {
    responses = {
      create: (body: Record<string, unknown>) => {
        requests.push(structuredClone(body));
        return {
          withResponse: async () => {
            throw new Error("synthetic SDK boundary stop");
          },
        };
      },
    };
  },
}));

// Two frames, both within the normal image limits.
const gif =
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAAh+QQBAAAAACwAAAAAAQABAAACAUQAOw==";
const image = { type: "image", mimeType: "image/gif", data: gif } as const;
const context = (): Context => ({
  messages: [
    { role: "user", content: "Inspect this image", timestamp: 0 },
    buildAssistantMessage({
      model: xaiModel(),
      content: [
        {
          type: "toolCall",
          id: "call_image",
          name: "view_image",
          arguments: { path: "synthetic.gif" },
        },
      ],
      stopReason: "toolUse",
      usage: createEmptyTransportUsage(),
      timestamp: 0,
    }),
    {
      role: "toolResult",
      toolCallId: "call_image",
      toolName: "view_image",
      content: [image],
      isError: false,
      timestamp: 1,
    },
  ],
});

async function request(
  input: Context,
  baseUrl = XAI_BASE_URL,
  provider = "xai",
  options: Parameters<typeof streamSimple>[2] = {},
) {
  const model = xaiModel({ baseUrl, provider });
  const stream = wrapXaiProviderStream({
    provider,
    modelId: model.id,
    streamFn: streamSimple,
    extraParams: { tool_stream: false },
  });
  if (!stream) {
    throw new Error("missing wrapper");
  }
  await (
    await stream(model, input, { apiKey: "synthetic-test-key", cacheRetention: "none", ...options })
  ).result();
  expect(requests).toHaveLength(1);
  const captured = requests.pop();
  if (!captured) {
    throw new Error("request was not dispatched to the synthetic SDK");
  }
  return captured;
}

beforeEach(() => {
  requests.length = 0;
});

it.each([XAI_BASE_URL, "https://cli-chat-proxy.grok.com/v1"])(
  "converts fresh and persisted replay GIFs at the %s request boundary without editing history",
  async (baseUrl) =>
    withTempDir("xai-gif-replay-", async (dir) => {
      const fresh = context();
      const stored = JSON.stringify(fresh);
      const first = await request(fresh, baseUrl);
      const file = join(dir, "synthetic-history.json");
      await writeFile(file, stored);
      const replay: Context = JSON.parse(await readFile(file, "utf8"));
      replay.messages.push({ role: "user", content: "What did you see?", timestamp: 2 });
      const later = await request(replay, baseUrl);
      for (const payload of [first, later]) {
        const wire = JSON.stringify(payload);
        expect(wire).not.toContain("image/gif");
        const encoded = wire.match(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/)?.[1];
        expect(encoded).toBeDefined();
        if (!encoded) {
          throw new Error("missing converted JPEG");
        }
        const bytes = Buffer.from(encoded, "base64");
        expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
        const decoded = await resizeToJpeg({ buffer: bytes, maxSide: 1, quality: 85 });
        expect(await getImageMetadata(decoded)).toMatchObject({ width: 1, height: 1 });
      }
      expect(later.input).toEqual([
        ...(Array.isArray(first.input) ? first.input : []),
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "What did you see?" }],
        },
      ]);
      expect(JSON.stringify(fresh)).toBe(stored);
      expect(JSON.stringify(replay.messages.slice(0, fresh.messages.length))).toBe(
        JSON.stringify(fresh.messages),
      );
      expect(JSON.stringify(later)).toContain("What did you see?");
      expect(await readFile(file, "utf8")).toBe(stored);
    }),
);

it("omits an undecodable GIF visibly and can build the later text turn", async () => {
  const input = context();
  input.messages = [
    {
      role: "user",
      timestamp: 0,
      content: [{ ...image, data: Buffer.from("GIF89a broken").toString("base64") }],
    },
  ];
  const stored = JSON.stringify(input);
  for (let turn = 0; turn < 2; turn++) {
    const payload = JSON.stringify(await request(input));
    expect(payload).not.toContain("image/gif");
    expect(payload).toContain("GIF image omitted");
    if (turn === 0) {
      expect(JSON.stringify(input)).toBe(stored);
    }
    input.messages.push({ role: "user", content: "continue", timestamp: 1 });
  }
});

it("preserves GIFs for a non-xAI provider", async () => {
  const payload = await request(context(), "https://api.openai.com/v1", "openai");
  expect(JSON.stringify(payload)).toContain(`data:image/gif;base64,${gif}`);
});

it.each([
  [
    "image/png",
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
  ],
  ["image/jpeg", "/9j/2Q=="],
  ["image/webp", "UklGRgAAAABXRUJQ"],
])("preserves already-supported %s bytes", async (mimeType, data) => {
  const input: Context = {
    messages: [{ role: "user", timestamp: 0, content: [{ type: "image", mimeType, data }] }],
  };
  expect(JSON.stringify(await request(input))).toContain(`data:${mimeType};base64,${data}`);
});

it("normalizes an async caller replacement while preserving frozen input parts", async () => {
  const part = Object.freeze({
    type: "input_image",
    source: Object.freeze({ type: "base64", media_type: "image/png", data: gif }),
  });
  const input = Object.freeze([
    Object.freeze({ type: "message", role: "user", content: Object.freeze([part]) }),
  ]);
  const original = JSON.stringify(input);
  const payload = await request(context(), XAI_BASE_URL, "x-ai", {
    onPayload: async () => ({ input, model: "grok-4-fast", stream: true }),
  });
  expect(JSON.stringify(payload)).toContain("image/jpeg");
  expect(JSON.stringify(payload)).not.toContain(gif);
  expect(JSON.stringify(input)).toBe(original);
});
