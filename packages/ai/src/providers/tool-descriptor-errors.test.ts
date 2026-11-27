import { afterEach, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import type { AnthropicOptions } from "../provider-options.js";
import { createAnthropicMessagesTransportStreamFn } from "../transports/anthropic-transport-stream.js";
import { makeAnthropicTransportModel } from "../transports/anthropic-transport-stream.test-support.js";
import type { Context } from "../types.js";
import { streamAnthropic } from "./anthropic.js";

const adapters = [
  {
    name: "Anthropic provider",
    stream: (context: Context, options: AnthropicOptions) =>
      streamAnthropic(makeAnthropicTransportModel(), context, {
        apiKey: "fixture",
        ...options,
      }),
  },
  {
    name: "Anthropic transport",
    stream: (context: Context, options: AnthropicOptions) =>
      createAnthropicMessagesTransportStreamFn()(makeAnthropicTransportModel(), context, {
        apiKey: "fixture",
        ...options,
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
  "$name rejects a forced unreadable tool $field before request handoff",
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
      { onPayload, toolChoice: { type: "tool", name: "broken" } },
    );
    const result = await events.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Anthropic tool_choice requested unavailable tool "broken"',
    );
    expect(onPayload).not.toHaveBeenCalled();
  },
);

const transportHost = getAiTransportHost();
afterEach(() => configureAiTransportHost(transportHost));

it.each(adapters)(
  "$name sends a healthy forced tool beside an unreadable descriptor",
  async ({ stream }) => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const payload: unknown = await new Request(input, init).json();
      expect(payload).toMatchObject({
        tool_choice: { type: "tool", name: "healthy_probe" },
        tools: [
          {
            name: "healthy_probe",
            input_schema: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      });
      expect(payload).toHaveProperty("tools.length", 1);
      const events = [
        {
          type: "message_start",
          message: { id: "msg_probe", usage: { input_tokens: 1, output_tokens: 0 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool_probe", name: "healthy_probe", input: {} },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"value":"OK"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(
        events
          .map((event) => "event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    configureAiTransportHost({ ...transportHost, buildModelFetch: () => fetch });
    const events = await stream(
      {
        messages: [{ role: "user", content: "Call healthy_probe with value OK.", timestamp: 0 }],
        tools: [
          {
            name: "unreadable_probe",
            description: "Unreadable",
            get parameters(): never {
              throw new Error("unreadable parameters");
            },
          },
          {
            name: "healthy_probe",
            description: "Return value",
            parameters: {
              type: "object",
              properties: { value: { type: "string" } },
              required: ["value"],
            },
          },
        ],
      },
      { toolChoice: { type: "tool", name: "healthy_probe" } },
    );
    const result = await events.result();
    expect(result.stopReason, result.errorMessage).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "toolCall", id: "tool_probe", name: "healthy_probe", arguments: { value: "OK" } },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);
