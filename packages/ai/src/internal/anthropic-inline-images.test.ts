import type { Context } from "@openclaw/llm-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { buildAnthropicRequest } from "../transports/anthropic-messages.js";
import { makeAnthropicTransportModel } from "../transports/anthropic-transport-stream.test-support.js";

const estimate = vi.hoisted(() => vi.fn());
vi.mock("@openclaw/media-core/base64", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/media-core/base64")>()),
  estimateBase64DecodedBytes: estimate,
}));
const image = { type: "image" as const, data: "image", mimeType: "image/jpeg" };
const message = { role: "user" as const, content: [image], timestamp: 0 };
const build = (messages: Context["messages"]) =>
  buildAnthropicRequest(
    makeAnthropicTransportModel({ input: ["text", "image"] }),
    { messages },
    undefined,
    "transport",
    false,
    false,
  );

beforeEach(() => {
  estimate.mockReset();
  configureAiTransportHost({
    normalizeAnthropicInlineContentBlocks: async (content) => [...content],
  });
});
afterEach(() => configureAiTransportHost({}));

it("bounds normalized images across all messages in each request", async () => {
  estimate.mockReturnValue(16 * 1024 * 1024);
  for (let request = 0; request < 2; request++) {
    await expect(build(Array.from({ length: 4 }, () => message))).resolves.toMatchObject({
      params: { messages: expect.any(Array) },
    });
  }
  await expect(build(Array.from({ length: 5 }, () => message))).rejects.toThrow(
    "64 MB aggregate decoded safety limit",
  );
});

it("rejects oversized output from an embedding host", async () => {
  estimate.mockImplementation((data: string) => (data === "expanded" ? 64 * 1024 * 1024 + 1 : 1));
  configureAiTransportHost({
    normalizeAnthropicInlineContentBlocks: async () => [{ ...image, data: "expanded" }],
  });
  await expect(build([message])).rejects.toThrow("64 MB aggregate decoded safety limit");
});

it("normalizes image batches incrementally and preserves text order", async () => {
  estimate.mockReturnValue(1);
  const sizes: number[] = [];
  configureAiTransportHost({
    normalizeAnthropicInlineContentBlocks: async (content) => {
      sizes.push(content.length);
      return [...content];
    },
  });
  const { params } = await build([
    {
      role: "user",
      timestamp: 0,
      content: [image, { type: "text", text: "between" }, { ...image, mimeType: "image/png" }],
    },
  ]);
  expect(sizes).toEqual([1, 1]);
  expect(params.messages[0]?.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "image" } },
    { type: "text", text: "between" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "image" },
      cache_control: { type: "ephemeral" },
    },
  ]);
});
