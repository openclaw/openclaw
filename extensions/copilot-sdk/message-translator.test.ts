import { describe, expect, it } from "vitest";
import {
  buildChatCompletionResponse,
  buildChatCompletionStreamChunks,
  openAiMessagesToPrompt,
  requestDeclaresTools,
  ToolsNotSupportedError,
} from "./message-translator.js";
import type { OpenAiChatRequest } from "./shared-types.js";

describe("openAiMessagesToPrompt", () => {
  it("joins system, user, assistant turns with role tags", () => {
    const prompt = openAiMessagesToPrompt([
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Tell me a fact." },
    ]);
    expect(prompt).toContain("[system]\nYou are helpful.");
    expect(prompt).toContain("[user]\nHi");
    expect(prompt).toContain("[assistant]\nHello!");
    expect(prompt.endsWith("[user]\nTell me a fact.")).toBe(true);
  });

  it("flattens content parts and preserves text ordering", () => {
    const prompt = openAiMessagesToPrompt([
      {
        role: "user",
        content: [
          { type: "text", text: "part one" },
          { type: "image_url", image_url: { url: "https://example.test/x.png" } },
          { type: "text", text: "part two" },
        ],
      },
    ]);
    expect(prompt).toContain("part one");
    expect(prompt).toContain("part two");
    expect(prompt).toContain("[image attachment elided by copilot-sdk shim]");
  });

  it("skips empty messages and null content", () => {
    const prompt = openAiMessagesToPrompt([
      { role: "user", content: null },
      { role: "user", content: "" },
      { role: "user", content: "only one" },
    ]);
    expect(prompt).toBe("[user]\nonly one");
  });

  it("labels tool messages with tool_call_id when no name is present", () => {
    const prompt = openAiMessagesToPrompt([
      { role: "tool", content: "42", tool_call_id: "call_xyz" },
    ]);
    expect(prompt).toBe("[tool:call_xyz]\n42");
  });

  it("preserves unknown role names verbatim", () => {
    const prompt = openAiMessagesToPrompt([{ role: "developer", content: "hey" }]);
    expect(prompt).toBe("[developer]\nhey");
  });
});

describe("requestDeclaresTools", () => {
  it("is false for an empty/missing tools array", () => {
    expect(requestDeclaresTools({ model: "m", messages: [] })).toBe(false);
    expect(requestDeclaresTools({ model: "m", messages: [], tools: [] })).toBe(false);
  });

  it("is true when tools are present", () => {
    const req: OpenAiChatRequest = {
      model: "m",
      messages: [],
      tools: [{ type: "function", function: { name: "x", parameters: {} } }],
    };
    expect(requestDeclaresTools(req)).toBe(true);
  });

  it("is true when tool_choice is set to a non-none value", () => {
    expect(requestDeclaresTools({ model: "m", messages: [], tool_choice: "auto" })).toBe(true);
    expect(requestDeclaresTools({ model: "m", messages: [], tool_choice: "none" })).toBe(false);
    expect(requestDeclaresTools({ model: "m", messages: [], tool_choice: null })).toBe(false);
  });
});

describe("ToolsNotSupportedError", () => {
  it("carries a stable error code", () => {
    const err = new ToolsNotSupportedError();
    expect(err.code).toBe("tools_not_supported");
    expect(err.message).toMatch(/cannot forward `tools`/);
  });
});

describe("buildChatCompletionResponse", () => {
  it("produces an OpenAI-shaped chat.completion body", () => {
    const body = buildChatCompletionResponse({ model: "gpt-5", content: "hi", created: 100 });
    expect(body).toMatchObject({
      object: "chat.completion",
      created: 100,
      model: "gpt-5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi" },
          finish_reason: "stop",
        },
      ],
    });
    expect((body as { id: string }).id).toMatch(/^chatcmpl-copilot-sdk-/);
  });
});

describe("buildChatCompletionStreamChunks", () => {
  it("emits a delta chunk, a stop chunk, and a [DONE] sentinel", () => {
    const chunks = buildChatCompletionStreamChunks({
      model: "gpt-5",
      content: "hello",
      created: 42,
    });
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatch(/^data: /);
    expect(chunks[2]).toBe("data: [DONE]\n\n");
    const firstPayload = JSON.parse(chunks[0].replace(/^data: /, "").trim());
    expect(firstPayload.choices[0].delta).toEqual({ role: "assistant", content: "hello" });
    const secondPayload = JSON.parse(chunks[1].replace(/^data: /, "").trim());
    expect(secondPayload.choices[0].finish_reason).toBe("stop");
  });
});
