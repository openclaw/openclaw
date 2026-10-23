import type { Message } from "openclaw/plugin-sdk/llm";
import { makeAgentAssistantMessage, makeAgentUserMessage } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { convertToOllamaMessages } from "./stream-messages.js";

const opening = "\n<!-- OPENCLAW-RELOCATABLE-BOUNDARY -->\n";
const closing = "\n<!-- /OPENCLAW-RELOCATABLE-BOUNDARY -->";
const policy = "Project instructions.\n<!-- OPENCLAW_CACHE_BOUNDARY -->\n## Runtime";
const permission = "Permission: ask before deleting files.";
const expectedSystem = `Project instructions.\n## Runtime\n${permission}`;

function runtime(session: string): string {
  return `Runtime: session=agent:main:subagent:${session} | sessionUrl=https://example.test/chat/${session}`;
}

function system(session: string): string {
  return `${policy}${opening}${runtime(session)}${closing}\n${permission}`;
}

describe("native Ollama messages", () => {
  it("keeps exact session identity behind system instructions without changing the input", () => {
    const messages = [
      makeAgentUserMessage({ content: [{ type: "text", text: "Inspect the file." }] }),
    ];
    const original = structuredClone(messages);
    const first = convertToOllamaMessages(messages, system("alpha"));
    const second = convertToOllamaMessages(messages, system("beta"));

    expect(first[0]).toEqual({ role: "system", content: expectedSystem });
    expect(second[0]).toEqual(first[0]);
    expect(first[1]).toEqual({
      role: "user",
      content:
        "Inspect the file.\n\nRuntime: session=agent:main:subagent:alpha | sessionUrl=https://example.test/chat/alpha",
    });
    expect(second[1]).toEqual({
      role: "user",
      content:
        "Inspect the file.\n\nRuntime: session=agent:main:subagent:beta | sessionUrl=https://example.test/chat/beta",
    });
    expect(messages).toEqual(original);
  });

  it.each([
    { label: "allowlist", options: { availableToolNames: new Set(["exec"]) } },
    { label: "default prefix strip", options: undefined },
  ])("normalizes functions.exec tool results with $label", ({ options }) => {
    const messages: Message[] = [
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call-1", name: "functions.exec", arguments: {} }],
      }),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "functions.exec",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0,
      },
    ];
    const converted = convertToOllamaMessages(messages, undefined, options);
    expect(converted[0]?.tool_calls?.[0]?.function.name).toBe("exec");
    expect(converted[1]?.tool_name).toBe("exec");
  });

  it("preserves the request prefix through a tool round and a later user turn", () => {
    const initial = [makeAgentUserMessage({ content: "Inspect the file." })];
    const toolRound: Message[] = [
      ...initial,
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "note" } }],
      }),
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "File contents." }],
        isError: false,
        timestamp: 0,
      },
    ];
    const followup = [
      ...toolRound,
      makeAgentAssistantMessage({ content: [{ type: "text", text: "The file contains a note." }] }),
      makeAgentUserMessage({ content: "Summarize it." }),
    ];
    const first = convertToOllamaMessages(initial, system("alpha"));
    const tools = convertToOllamaMessages(toolRound, system("alpha"));
    const next = convertToOllamaMessages(followup, system("alpha"));

    expect(tools.slice(0, first.length)).toEqual(first);
    expect(next.slice(0, tools.length)).toEqual(tools);
    expect(next.at(-1)).toEqual({ role: "user", content: "Summarize it." });
    expect(next.filter((message) => message.content.includes("session=agent:"))).toHaveLength(1);
  });

  it.each([
    {
      name: "no user carrier",
      messages: [makeAgentAssistantMessage({ content: [{ type: "text", text: "Continue." }] })],
      expectedMessages: [{ role: "assistant", content: "Continue." }],
      prompt: system("alpha"),
      expected: `Project instructions.\n## Runtime\nRuntime: session=agent:main:subagent:alpha | sessionUrl=https://example.test/chat/alpha\n${permission}`,
    },
    {
      name: "ambiguous document markers",
      messages: [makeAgentUserMessage({ content: "Inspect the file." })],
      expectedMessages: [{ role: "user", content: "Inspect the file." }],
      prompt: `Project policy.${opening}Documented example.${closing}\n${system("alpha")}`,
      expected: `Project policy.\nDocumented example.\nProject instructions.\n## Runtime\nRuntime: session=agent:main:subagent:alpha | sessionUrl=https://example.test/chat/alpha\n${permission}`,
    },
  ])(
    "preserves system authority with $name",
    ({ messages, prompt, expected, expectedMessages }) => {
      expect(convertToOllamaMessages(messages, prompt)).toEqual([
        { role: "system", content: expected },
        ...expectedMessages,
      ]);
    },
  );
});
