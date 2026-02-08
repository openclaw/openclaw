import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import transcriptSanitizeExtension from "./transcript-sanitize.js";

describe("transcript-sanitize extension", () => {
  it("filters foreign tool-use messages before repair", () => {
    let handler:
      | ((
          event: { messages: AgentMessage[] },
          ctx: ExtensionContext,
        ) => { messages: AgentMessage[] } | undefined)
      | null = null;

    const api = {
      on(event, cb) {
        if (event === "context") {
          handler = cb;
        }
      },
    } as unknown as ExtensionAPI;

    transcriptSanitizeExtension(api);

    if (!handler) {
      throw new Error("missing context handler");
    }

    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      {
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }],
      },
    ];

    const result = handler({ messages }, {
      model: {
        provider: "anthropic",
        api: "anthropic-messages",
        id: "claude-3-7",
      },
    } as ExtensionContext);

    expect(result).toEqual({ messages: [{ role: "user", content: "hello" }] });
  });
});
