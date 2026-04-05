import type { Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { runExtraParamsCase } from "./extra-params.test-support.js";

type StreamPayload = {
  messages: Array<{
    role: string;
    content: unknown;
  }>;
};

function runOpenRouterPayload(payload: StreamPayload, modelId: string) {
  runExtraParamsCase({
    cfg: {
      plugins: {
        entries: {
          openrouter: {
            enabled: true,
          },
        },
      },
    },
    model: {
      api: "openai-completions",
      provider: "openrouter",
      id: modelId,
    } as Model<"openai-completions">,
    payload,
  });
}

describe("extra-params: OpenRouter Anthropic cache_control", () => {
  it("injects cache_control into the last system/developer message and trailing user turn", () => {
    const payload = {
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello" },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "You are a helpful assistant.", cache_control: { type: "ephemeral" } },
    ]);
    expect(payload.messages[1].content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("adds cache_control to last content block when system message is already array", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "text", text: "Part 2" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    const content = payload.messages[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Part 1" });
    expect(content[1]).toEqual({
      type: "text",
      text: "Part 2",
      cache_control: { type: "ephemeral" },
    });
  });

  it("does not inject cache_control for OpenRouter non-Anthropic models", () => {
    const payload = {
      messages: [{ role: "system", content: "You are a helpful assistant." }],
    };

    runOpenRouterPayload(payload, "google/gemini-3-pro");

    expect(payload.messages[0].content).toBe("You are a helpful assistant.");
  });

  it("leaves payload unchanged when no system message exists", () => {
    const payload = {
      messages: [{ role: "user", content: "Hello" }],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("walks back to the nearest cacheable system block when trailing thinking exists", () => {
    const payload = {
      messages: [
        {
          role: "system",
          content: [
            { type: "text", text: "Part 1" },
            { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "text", text: "Part 1", cache_control: { type: "ephemeral" } },
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
    ]);
  });

  it("removes pre-existing cache_control from assistant thinking blocks", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "internal",
              thinkingSignature: "sig_1",
              cache_control: { type: "ephemeral" },
            },
            { type: "text", text: "visible" },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toEqual([
      { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" },
      { type: "text", text: "visible" },
    ]);
  });

  it("only marks the last system/developer message when multiple exist", () => {
    const payload = {
      messages: [
        { role: "system", content: "First system instruction." },
        { role: "developer", content: "Second developer instruction." },
        { role: "user", content: "Hello" },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[0].content).toBe("First system instruction.");
    expect(payload.messages[1].content).toEqual([
      {
        type: "text",
        text: "Second developer instruction.",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(payload.messages[2].content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);
  });

  it("walks back to the nearest cacheable user block when the last block is not cacheable", () => {
    const payload = {
      messages: [
        { role: "system", content: "System prompt." },
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this document" },
            { type: "document", source: { type: "base64", data: "abc" } },
          ],
        },
      ],
    };

    runOpenRouterPayload(payload, "anthropic/claude-opus-4-6");

    expect(payload.messages[1].content).toEqual([
      {
        type: "text",
        text: "Describe this document",
        cache_control: { type: "ephemeral" },
      },
      { type: "document", source: { type: "base64", data: "abc" } },
    ]);
  });
});
