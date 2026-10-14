import {
  assertCodeModeResponsesToolSurface,
  enforceCodeModeResponsesToolSurface,
} from "@openclaw/ai/transports";
import { describe, expect, it } from "vitest";

describe("OpenAI Code Mode direct tools", () => {
  it("keeps policy-required direct tools model-visible", () => {
    const visibleToolNames = new Set(["exec", "wait", "computer", "view_image", "message"]);
    const payload = {
      tools: ["exec", "wait", "computer", "view_image", "message", "web_fetch"].map((name) => ({
        type: "function",
        name,
      })),
    };

    enforceCodeModeResponsesToolSurface(payload, visibleToolNames);

    expect(payload.tools.map((tool) => tool.name)).toEqual([
      "exec",
      "wait",
      "computer",
      "view_image",
      "message",
    ]);
    expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).not.toThrow();
  });

  it("preserves a request-visible direct-only tool and rejects undeclared tools", () => {
    const directToolName = "sessions_yield";
    const visibleToolNames = new Set(["exec", "wait", directToolName]);
    const payload = {
      tools: ["exec", directToolName, "computer", "view_image", "message", "web_fetch", "wait"].map(
        (name) => ({ type: "function", name }),
      ),
    };

    expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).toThrow(
      /tool surface violation/,
    );

    enforceCodeModeResponsesToolSurface(payload, visibleToolNames);

    expect(payload.tools.map((tool) => tool.name)).toEqual(["exec", directToolName, "wait"]);
    expect(() => assertCodeModeResponsesToolSurface(payload, visibleToolNames)).not.toThrow();
  });
});
