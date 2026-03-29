import { describe, expect, it } from "vitest";
import { flattenOpenAiCompletionsTextOnlyUserContentInPayload } from "./openai-completions-plaintext-user-content.js";

describe("flattenOpenAiCompletionsTextOnlyUserContentInPayload", () => {
  it("flattens single text part to string for text-only openai-completions models", () => {
    const payload = {
      model: "m",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    };
    flattenOpenAiCompletionsTextOnlyUserContentInPayload(payload, {
      api: "openai-completions",
      input: ["text"],
      provider: "local",
      id: "qwen",
    });
    expect(payload.messages[0]).toEqual({ role: "user", content: "hello" });
  });

  it("joins multiple text parts with newlines", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
    };
    flattenOpenAiCompletionsTextOnlyUserContentInPayload(payload, {
      api: "openai-completions",
      input: ["text"],
      provider: "local",
      id: "qwen",
    });
    expect((payload.messages[0] as unknown as { content: string }).content).toBe("a\nb");
  });

  it("skips when model declares image input", () => {
    const payload = {
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    };
    flattenOpenAiCompletionsTextOnlyUserContentInPayload(payload, {
      api: "openai-completions",
      input: ["text", "image"],
      provider: "openai",
      id: "gpt-5",
    });
    expect((payload.messages[0] as { content: unknown[] }).content).toEqual([
      { type: "text", text: "x" },
    ]);
  });

  it("skips openrouter anthropic routes", () => {
    const payload = {
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    };
    flattenOpenAiCompletionsTextOnlyUserContentInPayload(payload, {
      api: "openai-completions",
      input: ["text"],
      provider: "openrouter",
      id: "anthropic/claude-3.5-sonnet",
    });
    expect((payload.messages[0] as { content: unknown[] }).content).toEqual([
      { type: "text", text: "x" },
    ]);
  });

  it("does not change non-openai-completions APIs", () => {
    const payload = {
      messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    };
    flattenOpenAiCompletionsTextOnlyUserContentInPayload(payload, {
      api: "anthropic-messages",
      input: ["text"],
      provider: "anthropic",
      id: "claude",
    });
    expect((payload.messages[0] as { content: unknown[] }).content).toEqual([
      { type: "text", text: "x" },
    ]);
  });

  it("leaves multimodal user content unchanged", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "see" },
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
          ],
        },
      ],
    };
    flattenOpenAiCompletionsTextOnlyUserContentInPayload(payload, {
      api: "openai-completions",
      input: ["text", "image"],
      provider: "openai",
      id: "gpt-5",
    });
    expect(payload.messages[0]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "see" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
  });
});
