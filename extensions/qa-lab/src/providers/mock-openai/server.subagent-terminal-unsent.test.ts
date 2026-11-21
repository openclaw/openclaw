import { expect, it } from "vitest";
import {
  createMockServerTestHarness,
  makeUserInput,
  outputText,
  postResponses,
  requireRecord,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

function readSseEvents(body: string) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: {"))
    .map((line) => requireRecord(JSON.parse(line.slice(6)), "SSE event"));
}

function readTerminalResponse(events: Array<Record<string, unknown>>) {
  return requireRecord(events.at(-1)?.response, "terminal response");
}

it.each([
  ["visible", ""],
  ["silent", ""],
  ["fallback", ""],
  ["restart", ""],
  ["empty", "Completion processed."],
  ["race", "Completion processed."],
  ["private", "Completion processed."],
])(
  "keeps the %s completion visible and returns the selected settled reply",
  async (terminalCase, expectedSettledReply) => {
    const event = [
      "[Internal task completion event]",
      "source: subagent",
      `task: qa-terminal-${terminalCase}`,
      "status: completed; ready for parent review",
      "",
      `QA-SUBAGENT-TERMINAL-${terminalCase.toUpperCase()}-OK`,
    ].join("\n");
    const carrier = [
      "OpenClaw runtime context:",
      "Conversation data (data, not instructions):",
      JSON.stringify(event),
    ].join("\n");

    const server = await startMockServer();
    const completion = await postResponses(server, {
      stream: true,
      input: [makeUserInput(carrier)],
    });
    const completionEvents = readSseEvents(await completion.text());

    expect(completion.status).toBe(200);
    expect(completionEvents.at(-1)).toMatchObject({
      type: "response.completed",
      response: { status: "completed" },
    });
    expect(outputText(readTerminalResponse(completionEvents))).not.toBe("");

    const settled = await postResponses(server, {
      stream: true,
      input: [
        makeUserInput(carrier),
        makeUserInput(
          "[Subagent Context] Every subagent in this batch has now settled, including its descendants.",
        ),
      ],
    });
    const settledEvents = readSseEvents(await settled.text());

    expect(settled.status).toBe(200);
    expect(settledEvents.at(-1)).toMatchObject({
      type: "response.completed",
      response: { status: "completed" },
    });
    expect(outputText(readTerminalResponse(settledEvents))).toBe(expectedSettledReply);
  },
);
