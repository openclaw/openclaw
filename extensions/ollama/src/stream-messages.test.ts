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
  it("preserves valid content when an input array contains malformed parts", () => {
    expect(
      convertToOllamaMessages([
        {
          role: "user",
          content: [
            null,
            { type: "text", text: 7 },
            { type: "text", text: "hello" },
            { type: "image", data: "pixels" },
          ],
        },
        {
          role: "assistant",
          content: [
            null,
            { type: "toolCall", name: 7 },
            { type: "toolCall", name: "read", arguments: { path: "." } },
          ],
        },
      ]),
    ).toEqual([
      { role: "user", content: "hello", images: ["pixels"] },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read", arguments: { path: "." } } }],
      },
    ]);
  });

  it("keeps exact session identity behind system instructions without changing the input", () => {
    const messages = [{ role: "user", content: [{ type: "text", text: "Inspect the file." }] }];
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

  it("preserves the request prefix through a tool round and a later user turn", () => {
    const initial = [{ role: "user", content: "Inspect the file." }];
    const toolRound = [
      ...initial,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "note" } }],
      },
      { role: "toolResult", toolCallId: "read-1", toolName: "read", content: "File contents." },
    ];
    const followup = [
      ...toolRound,
      { role: "assistant", content: "The file contains a note." },
      { role: "user", content: "Summarize it." },
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
      messages: [{ role: "assistant", content: "Continue." }],
      prompt: system("alpha"),
      expected: `Project instructions.\n## Runtime\nRuntime: session=agent:main:subagent:alpha | sessionUrl=https://example.test/chat/alpha\n${permission}`,
    },
    {
      name: "ambiguous document markers",
      messages: [{ role: "user", content: "Inspect the file." }],
      prompt: `Project policy.${opening}Documented example.${closing}\n${system("alpha")}`,
      expected: `Project policy.\nDocumented example.\nProject instructions.\n## Runtime\nRuntime: session=agent:main:subagent:alpha | sessionUrl=https://example.test/chat/alpha\n${permission}`,
    },
  ])("preserves system authority with $name", ({ messages, prompt, expected }) => {
    expect(convertToOllamaMessages(messages, prompt)).toEqual([
      { role: "system", content: expected },
      ...messages,
    ]);
  });
});
