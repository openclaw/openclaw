import { expect, it, vi } from "vitest";
import type { AnthropicOptions } from "../provider-options.js";
import { createAnthropicMessagesTransportStreamFn } from "../transports/anthropic-transport-stream.js";
import { makeAnthropicTransportModel } from "../transports/anthropic-transport-stream.test-support.js";
import type { Context } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

const forcedToolOptions: AnthropicOptions = {
  apiKey: "fixture",
  toolChoice: { type: "tool", name: "lookup" },
};

const adapters = [
  {
    name: "Anthropic provider",
    stream: (context: Context, onPayload: () => never) =>
      streamAnthropic(makeAnthropicTransportModel(), context, {
        ...forcedToolOptions,
        onPayload,
      }),
  },
  {
    name: "Anthropic transport",
    stream: (context: Context, onPayload: () => never) =>
      createAnthropicMessagesTransportStreamFn()(makeAnthropicTransportModel(), context, {
        ...forcedToolOptions,
        onPayload,
      }),
  },
];

it.each(
  adapters.flatMap((adapter) =>
    ["name", "parameters", "description"].map((field) => ({
      name: adapter.name,
      stream: adapter.stream,
      field,
    })),
  ),
)(
  "$name reports an unreadable tool $field instead of forcing its healthy sibling",
  async ({ stream, field }) => {
    const tool = { name: "broken", description: "Broken", parameters: {} };
    Object.defineProperty(tool, field, {
      get() {
        throw new Error(`${field} exploded`);
      },
    });
    const onPayload = vi.fn(() => {
      throw new Error("payload reached");
    });
    const events = await stream(
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [tool, { name: "lookup", description: "Lookup", parameters: {} }],
      },
      onPayload,
    );
    const result = await events.result();

    expect(result.stopReason).toBe("error");
    expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
    expect(result.errorMessage).toContain(`${field} exploded`);
    expect(onPayload).not.toHaveBeenCalled();
  },
);
