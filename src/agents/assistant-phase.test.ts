import { describe, expect, it } from "vitest";
import { resolveAssistantPhase } from "./assistant-phase.js";

describe("resolveAssistantPhase", () => {
  it("prefers the top-level phase when present", () => {
    expect(resolveAssistantPhase({ phase: "commentary" })).toBe("commentary");
  });

  it("uses the latest explicit text block phase when content mixes commentary and final text", () => {
    expect(
      resolveAssistantPhase({
        content: [
          {
            type: "text",
            text: "Thinking...",
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_commentary",
              phase: "commentary",
            }),
          },
          {
            type: "text",
            text: "Done.",
            textSignature: JSON.stringify({
              v: 1,
              id: "msg_final",
              phase: "final_answer",
            }),
          },
        ],
      }),
    ).toBe("final_answer");
  });
});
