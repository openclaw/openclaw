import { describe, expect, it, vi } from "vitest";
import { wrapCopilotAnthropicStream } from "./stream.js";

describe("wrapCopilotAnthropicStream", () => {
  it("adds Copilot headers and Anthropic cache markers for Claude payloads", async () => {
    const payloads: Array<Record<string, unknown>> = [];
    const baseStreamFn = vi.fn((model, _context, options) => {
      const payload = {
        messages: [
          { role: "system", content: "system prompt" },
          {
            role: "assistant",
            content: [{ type: "thinking", text: "draft", cache_control: { type: "ephemeral" } }],
          },
        ],
      };
      options?.onPayload?.(payload, model);
      payloads.push(payload as Record<string, unknown>);
      return {
        async *[Symbol.asyncIterator]() {},
      } as never;
    });

    const wrapped = wrapCopilotAnthropicStream(baseStreamFn);
    const context = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", image: "data:image/png;base64,abc" },
          ],
        },
      ],
    } as never;

    wrapped(
      {
        provider: "github-copilot",
        api: "anthropic-messages",
        id: "claude-sonnet-4.6",
      } as never,
      context,
      {
        headers: { "X-Test": "1" },
      },
    );

    expect(baseStreamFn).toHaveBeenCalledOnce();
    expect(baseStreamFn.mock.calls[0]?.[2]).toMatchObject({
      headers: {
        "X-Initiator": "user",
        "Openai-Intent": "conversation-edits",
        "Copilot-Vision-Request": "true",
        "X-Test": "1",
      },
    });
    expect(payloads[0]?.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [{ type: "thinking", text: "draft" }],
      },
    ]);
  });

  it("leaves non-Anthropic Copilot models untouched", () => {
    const baseStreamFn = vi.fn(() => ({ async *[Symbol.asyncIterator]() {} }) as never);
    const wrapped = wrapCopilotAnthropicStream(baseStreamFn);
    const options = { headers: { Existing: "1" } };

    wrapped(
      {
        provider: "github-copilot",
        api: "openai-responses",
        id: "gpt-4.1",
      } as never,
      { messages: [{ role: "user", content: "hi" }] } as never,
      options as never,
    );

    expect(baseStreamFn).toHaveBeenCalledWith(expect.anything(), expect.anything(), options);
  });
});
