import { describe, expect, it } from "vitest";
import { resolveMockSubagentTurn } from "./mock-openai-input.js";

const kickoff = { role: "user", content: "Subagent terminal reply QA check: fallback." };
const settled =
  "[Subagent Context] Every subagent in this batch has now settled, including its descendants.";

describe("terminal requester input", () => {
  it("keeps reasoning recovery attached to the original subagent task", () => {
    expect(
      resolveMockSubagentTurn([
        kickoff,
        {
          role: "user",
          content:
            "Your turn ended without a final reply. Continue from the current conversation and answer the user's request now. Do not repeat completed actions or restart the task. Do not restate your reasoning.",
        },
      ]),
    ).toMatchObject({ kind: "kickoff", caseName: "fallback" });
  });

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
