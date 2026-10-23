import { describe, expect, it, vi } from "vitest";
import * as codeRegions from "../shared/text/code-regions.js";
import {
  createMessageUpdateContext,
  updateMessage,
} from "./embedded-agent-subscribe.handlers.messages.test-helpers.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const quotedToolXml =
  '<function_calls><invoke name="exec"><parameter name="command">echo hidden</parameter></invoke></function_calls>';

describe.each(["ollama", "anthropic-messages", "openai-completions", "openai-responses"] as const)(
  "%s tool markup delivery",
  (api) => {
    function message(text: string) {
      return {
        role: "assistant" as const,
        api,
        provider: "fixture",
        model: "fixture",
        usage: createZeroUsageFixture(),
        timestamp: 0,
        stopReason: "stop" as const,
        ...(api === "openai-responses" ? { phase: "final_answer" as const } : {}),
        content: [{ type: "text" as const, text }],
      };
    }

    it("bounds Markdown parse work after quoted tool XML in token-sized deltas", async () => {
      const context = createMessageUpdateContext();
      const example = `\`\`\`xml\n${quotedToolXml}\n\`\`\`\n\n`;
      const continuation = "Explanation.\n\n- Item\n\n```python\nprint('hello')\n```\n\n".repeat(
        128,
      );
      const source = example + continuation;
      const regions = vi.spyOn(codeRegions, "findCodeRegions");
      try {
        let text = "";
        for (let offset = 0; offset < source.length; offset += 4) {
          const delta = source.slice(offset, offset + 4);
          text += delta;
          const partial = message(text);
          await updateMessage(context, {
            message: partial,
            assistantMessageEvent: { type: "text_delta", delta, partial, contentIndex: 0 },
          });
        }
        expect(context.state.assistantStream?.text).toBe(source.trimEnd());
        const parsedCharacters = regions.mock.calls.reduce(
          (total, [parsed]) => total + parsed.length,
          0,
        );
        expect(parsedCharacters).toBeLessThan(source.length * 8);
      } finally {
        regions.mockRestore();
      }
    });
  },
);
