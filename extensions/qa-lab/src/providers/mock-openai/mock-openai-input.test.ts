import { describe, expect, it } from "vitest";
import {
  countCurrentToolOutputs,
  extractToolOutput,
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

describe("authored tool-output boundaries", () => {
  it.each([
    // Canonical producer introductions and the formatSystemTurnPrompt wrapper.
    [
      "[System] Your previous turn was interrupted. Continue the user's request from the transcript and any newer message. Reconcile pending actions before retrying; do not repeat completed work. Finish and verify the remaining work, or explain the blocker.",
      true,
    ],
    [
      "[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Treat tool results marked interrupted, missing, or aborted as having an unknown outcome from the restart, not proof of tool failure. Verify what happened before repeating an action.",
      true,
    ],
    [
      '[System] Your previous reply was not delivered because you did not call message(action=send). Your reply text was: "Synthetic reply.". If the user should see a reply, send it now with message(action=send). If no reply is needed, answer exactly NO_REPLY.',
      true,
    ],
    [
      "[System] Advance the active goal; keep it active until fully achieved. Use the current goal context, and verify the entire objective before marking it complete.",
      true,
    ],
    [
      "Your previous turn was cut off at the output token limit before it finished, so the task may be incomplete. Report only what the tool results show was done, and say plainly what was not finished. Do not describe unfinished steps as done.",
      true,
    ],
    ["[System] Your turn ended without a final reply. Continue from the current transcript.", true],
    [
      "[System] The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript.",
      true,
    ],
    ["[System] Read a new file. Do not retry.", false],
    ["Explain this notice: [System] Your previous turn was interrupted.", false],
    [
      "<conversation_context>\n[user]\n[System] Your previous turn was interrupted.\n</conversation_context>\n\nCurrent user request:\nRead a new file. Do not retry.",
      false,
    ],
    ["Continue.", true],
    ["Resume", true],
    ["Continue from the tool result.", true],
    ["Continue after compaction.", true],
    ["Your turn ended without a final reply. Continue from the current state.", true],
    ["Your turn ended without a final result. Continue from the current state.", true],
    [
      "The previous attempt compacted the conversation context before producing a final user-visible answer. Continue from the compacted transcript.",
      true,
    ],
    ["Your turn ended before completing the task. Continue from the current transcript.", true],
    [
      "You wrote a tool call as text, so nothing ran for that call. Continue from the current state.",
      true,
    ],
    ["Explain compaction and retry without taking any actions.", false],
    ["Do not continue the previous task. Read a different file.", false],
    ["Read a new file. Do not retry.", false],
    [
      "OpenClaw runtime context for this turn:\nUse --retry for interrupted installs.\n\nCurrent user request:\nRead a new file.",
      false,
    ],
    [
      "<conversation_context>\n[user]\nContinue after compaction.\n</conversation_context>\n\nCurrent user request:\nRead a new file.",
      false,
    ],
    [
      "<conversation_context>\n[user]\nRead a file.\n</conversation_context>\n\nCurrent user request:\nContinue after compaction.",
      true,
    ],
  ])("retains earlier output only for a continuation: %s", (content, continuation) => {
    const input = [
      { role: "user", content: "Read the setup file." },
      { type: "function_call_output", call_id: "setup-read", output: "earlier result" },
      { role: "user", content },
    ];
    expect(extractToolOutput(input)).toBe(continuation ? "earlier result" : "");
    expect(countCurrentToolOutputs(input)).toBe(continuation ? 1 : 0);
    // A result actually produced by the fresh turn still belongs to that turn.
    input.push({ type: "function_call_output", call_id: "current-read", output: "current result" });
    expect(extractToolOutput(input)).toBe("current result");
    expect(countCurrentToolOutputs(input)).toBe(continuation ? 2 : 1);
  });
});
