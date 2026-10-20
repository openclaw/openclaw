import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { expect, it } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import type { Context } from "../types.js";
import { resolveOpenAICompletionsCompat } from "./openai-completions-compat.js";
import {
  buildOpenAICompletionsParams,
  buildOpenAICompletionsRequest,
} from "./openai-completions-params.js";
import { createAssistantOutput, makeCompletionsModel } from "./openai-completions.test-support.js";

const model = makeCompletionsModel({
  provider: "custom",
  id: "local-model",
  baseUrl: "http://localhost:1234/v1",
  input: ["text", "image"],
  compat: { supportsTools: false },
});
const context: Context = {
  systemPrompt: "Keep file identities intact.",
  tools: [{ name: "read", description: "Read a file", parameters: { type: "object" } }],
  messages: [
    {
      ...createAssistantOutput(model),
      content: [
        {
          type: "thinking",
          thinking: "Check both files.",
          thinkingSignature: "reasoning_content",
        },
        { type: "text", text: "Reading the files." },
        { type: "toolCall", id: "call_notes", name: "read", arguments: { path: "notes.txt" } },
        { type: "toolCall", id: "call_readme", name: "read", arguments: { path: "readme.md" } },
      ],
      stopReason: "toolUse",
      timestamp: 1,
    },
    makeTextToolResult("call_notes", "read", "  amber-17\n", false, 2),
    makeTextToolResult("call_readme", "read", "violet-29", false, 3),
    { role: "user", content: "Continue.", timestamp: 4 },
  ],
};

function replay(compat: Partial<NonNullable<typeof model.compat>>, requestContext = context) {
  return buildOpenAICompletionsParams(
    { ...model, compat: { ...model.compat, ...compat } },
    requestContext,
    requestContext === context ? { toolChoice: "auto" } : undefined,
  );
}
it.each<[Partial<NonNullable<typeof model.compat>>, boolean]>([
  [{}, false],
  [{ strictMessageKeys: true, requiresStringContent: true }, false],
  [{ requiresThinkingAsText: true, requiresAssistantAfterToolResult: true }, false],
  [{ requiresAssistantAfterToolResult: true }, true],
])("replays two read identities (%j, images=%s)", (compat, images) => {
  const input = images ? structuredClone(context) : context;
  if (images) {
    for (const message of input.messages) {
      if (message.role === "toolResult") {
        message.content.push({ type: "image", mimeType: "image/png", data: message.toolCallId });
      }
    }
  }
  const before = structuredClone(input);
  const payload = replay(compat, input);
  expect(payload).not.toHaveProperty("tools");
  expect(payload).not.toHaveProperty("tool_choice");
  const messages = payload.messages as ChatCompletionMessageParam[];
  expect(messages.map((message) => message.role)).toEqual(
    images ? ["system", "assistant", "user", "user"] : ["system", "assistant", "user"],
  );
  expect(messages.at(-1)).toMatchObject({ role: "user", content: "Continue." });
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
  if (images) {
    expect(messages[2]).toMatchObject({
      role: "user",
      content: [
        { type: "text", text: "Image(s) from tool result #1 (read):" },
        { type: "image_url", image_url: { url: "data:image/png;base64,call_notes" } },
        { type: "text", text: "Image(s) from tool result #2 (read):" },
        { type: "image_url", image_url: { url: "data:image/png;base64,call_readme" } },
      ],
    });
  }
  expect(input).toEqual(before);
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
  expect(payload).toMatchObject({
    tools: [{ function: { name: "read" } }],
    tool_choice: "auto",
    messages: [
      { role: "system" },
      { role: "assistant", tool_calls: [{ id: "call_notes" }, { id: "call_readme" }] },
      { role: "tool", tool_call_id: "call_notes", content: "  amber-17\n" },
      { role: "tool", tool_call_id: "call_readme", content: "violet-29" },
      { role: "user" },
    ],
  });
});
