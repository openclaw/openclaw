import { describe, expect, it } from "vitest";
import { applyAnthropicEphemeralCacheControlMarkers } from "./anthropic-cache-control-payload.js";

describe("applyAnthropicEphemeralCacheControlMarkers", () => {
  it("marks system text content as ephemeral and strips thinking cache markers", () => {
    const payload = {
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "draft", cache_control: { type: "ephemeral" } },
            { type: "text", text: "answer" },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages).toEqual([
      {
        role: "system",
        content: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "draft" },
          { type: "text", text: "answer" },
        ],
      },
    ]);
  });

  it("marks only the last system/developer message and the trailing user turn", () => {
    const payload = {
      messages: [
        { role: "system", content: "first system" },
        { role: "developer", content: "last developer" },
        { role: "user", content: "hello" },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages).toEqual([
      { role: "system", content: "first system" },
      {
        role: "developer",
        content: [{ type: "text", text: "last developer", cache_control: { type: "ephemeral" } }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  it("walks back to the nearest cacheable block", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "instructions" },
            { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          ],
        },
        {
          role: "user",
          content: [
            { type: "text", text: "describe this" },
            { type: "document", source: { type: "base64", data: "abc" } },
          ],
        },
      ],
    } satisfies Record<string, unknown>;

    applyAnthropicEphemeralCacheControlMarkers(payload);

    expect(payload.messages).toEqual([
      {
        role: "system",
        content: [
          { type: "text", text: "instructions", cache_control: { type: "ephemeral" } },
          { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
        ],
      },
      {
        role: "user",
        content: [
          { type: "text", text: "describe this", cache_control: { type: "ephemeral" } },
          { type: "document", source: { type: "base64", data: "abc" } },
        ],
      },
    ]);
  });
});
