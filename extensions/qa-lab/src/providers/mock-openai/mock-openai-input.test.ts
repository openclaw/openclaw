import { describe, expect, it } from "vitest";
import {
  countCurrentToolOutputs,
  hasToolOutput,
  resolveMockSubagentTurn,
} from "./mock-openai-input.js";

it.each([
  "OpenClaw runtime context for this turn:\nWorkspace instructions: retry failed installs.",
  "<conversation_context>\n[user]\nRetry the old task.\n</conversation_context>",
])("fences tool output at a fresh request after reference context: %s", (context) => {
  const input = [
    { type: "function_call_output", name: "openclaw_current_sender", output: "sender context" },
    { role: "user", content: `${context}\n\nCurrent user request:\nWrite the artifact.` },
  ];
  expect(hasToolOutput(input)).toBe(false);
  expect(countCurrentToolOutputs(input)).toBe(0);
  const continued = [
    ...input,
    { type: "function_call_output", call_id: "write", output: "Artifact written." },
    { role: "user", content: "Continue." },
  ];
  expect(hasToolOutput(continued)).toBe(true);
  expect(countCurrentToolOutputs(continued)).toBe(1);
});

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
