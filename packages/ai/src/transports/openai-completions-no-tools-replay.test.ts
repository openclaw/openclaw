import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { describe, expect, it } from "vitest";
import type { Context } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  buildOpenAICompletionsParams,
  buildOpenAICompletionsRequest,
} from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

const baseModel = makeCompletionsModel({
  provider: "custom",
  id: "local-model",
  baseUrl: "http://localhost:1234/v1",
  input: ["text", "image"],
});
const model = { ...baseModel, compat: { ...baseModel.compat, supportsTools: false } };
const context: Context = {
  systemPrompt: "Keep file identities intact.",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  messages: [
    {
      role: "assistant",
      api: model.api,
      provider: model.provider,
      model: model.id,
      content: [
        { type: "thinking", thinking: "Check both files.", thinkingSignature: "reasoning_content" },
        { type: "text", text: "Reading the files." },
        { type: "toolCall", id: "call_notes", name: "read", arguments: { path: "notes.txt" } },
        { type: "toolCall", id: "call_readme", name: "read", arguments: { path: "readme.md" } },
      ],
      usage: createZeroUsage(),
      stopReason: "toolUse",
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "call_notes",
      toolName: "read",
      content: [{ type: "text", text: "  amber-17\n" }],
      isError: false,
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "call_readme",
      toolName: "read",
      content: [{ type: "text", text: "violet-29" }],
      isError: false,
      timestamp: 3,
    },
    { role: "user", content: "Continue.", timestamp: 4 },
  ],
};

describe("no-tools Chat Completions replay", () => {
  it.each([
    {},
    { strictMessageKeys: true, requiresStringContent: true },
    { requiresThinkingAsText: true, requiresAssistantAfterToolResult: true },
  ])("keeps two read identities without tool protocol (%j)", (compat) => {
    const before = structuredClone(context);
    const payload = buildOpenAICompletionsParams(
      { ...model, compat: { ...model.compat, ...compat } },
      context,
      { toolChoice: "auto" },
    );
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
    const messages = payload.messages as ChatCompletionMessageParam[];
    expect(messages.map((message) => message.role)).toEqual(["system", "assistant", "user"]);
    for (const message of messages) {
      expect(message).not.toHaveProperty("tool_calls");
      expect(message).not.toHaveProperty("tool_call_id");
      expect(message).not.toHaveProperty("function_call");
    }
    const content = messages[1]?.content;
    const text = Array.isArray(content)
      ? content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
      : content;
    expect(text).toContain("Reading the files.");
    expect(text).toContain('[tool call id=call_notes name=read] {"path":"notes.txt"}');
    expect(text).toContain('[tool call id=call_readme name=read] {"path":"readme.md"}');
    expect(text).toContain("[tool result id=call_notes name=read]   amber-17\n");
    expect(text).toContain("[tool result id=call_readme name=read] violet-29");
    if (compat.requiresThinkingAsText) {
      expect(text).toContain("Check both files.");
    }
    expect(context).toEqual(before);
  });

  it("preserves explicit tools and protocol replay for direct provider requests", () => {
    const payload = buildOpenAICompletionsRequest(
      model,
      context,
      { toolChoice: "auto" },
      {
        mode: "direct",
        compat: resolveOpenAICompletionsCompat(model),
        cacheRetention: "none",
      },
    );
    expect(payload.tools).toMatchObject([{ function: { name: "read" } }]);
    expect(payload.tool_choice).toBe("auto");
    expect(payload.messages).toMatchObject([
      { role: "system" },
      { role: "assistant", tool_calls: [{ id: "call_notes" }, { id: "call_readme" }] },
      { role: "tool", tool_call_id: "call_notes", content: "  amber-17\n" },
      { role: "tool", tool_call_id: "call_readme", content: "violet-29" },
      { role: "user" },
    ]);
  });

  it("keeps tool-result images and their ownership after text replay", () => {
    const payload = buildOpenAICompletionsParams(
      { ...model, compat: { ...model.compat, requiresAssistantAfterToolResult: true } },
      {
        ...context,
        messages: context.messages.map((message) =>
          message.role === "toolResult"
            ? Object.assign({}, message, {
                content: [
                  ...message.content,
                  { type: "image", mimeType: "image/png", data: message.toolCallId },
                ],
              })
            : message,
        ),
      },
      undefined,
    );
    expect(payload.messages).toMatchObject([
      { role: "system" },
      {
        role: "assistant",
        content: expect.stringContaining("[tool result id=call_readme name=read]"),
      },
      {
        role: "user",
        content: [
          { type: "text", text: "Image(s) from tool result #1 (read):" },
          { type: "image_url", image_url: { url: "data:image/png;base64,call_notes" } },
          { type: "text", text: "Image(s) from tool result #2 (read):" },
          { type: "image_url", image_url: { url: "data:image/png;base64,call_readme" } },
        ],
      },
      { role: "user", content: "Continue." },
    ]);
  });
});
