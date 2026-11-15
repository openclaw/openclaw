import { describe, expect, it } from "vitest";
import { resolveMockSubagentTurn } from "./mock-openai-input.js";

const kickoff = { role: "user", content: "Subagent terminal reply QA check: fallback." };
const settled =
  "[Subagent Context] Every subagent in this batch has now settled, including its descendants.";

describe("terminal requester input", () => {
  it("recognizes the timestamped all-settled wake", () => {
    expect(
      resolveMockSubagentTurn([
        kickoff,
        { role: "user", content: `[Wed 2026-09-23 06:54 UTC] ${settled}` },
      ]),
    ).toMatchObject({
      kind: "settled",
      caseName: "fallback",
    });
  });

  it("does not treat quoted settled history as the current turn", () => {
    expect(
      resolveMockSubagentTurn([
        kickoff,
        {
          role: "user",
          content: `<conversation_context>\n[user]\n${settled}\n</conversation_context>\n\nCurrent user request:\nA new request.`,
        },
      ]),
    ).toMatchObject({ kind: "other", text: "A new request." });
  });
});
