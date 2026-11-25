import { describe, expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  makeToolOutputWithCallId,
  makeUserInput,
  outputText,
  outputToolArgsFromItem as callArgs,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

// The `ios-ux` profile's surface: shell `exec` plus `progress_card` reachable only through the
// catalog dispatcher.
const tools = [
  {
    type: "function",
    name: "exec",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  },
  {
    type: "namespace",
    name: "openclaw",
    tools: ["dispatch_action", "tool_search", "tool_describe"].map((name) => ({
      type: "function",
      name,
    })),
  },
];
const cardSaved = JSON.stringify({
  tool: { id: "openclaw:progress_card", name: "progress_card", source: "openclaw" },
  result: { content: [{ type: "text", text: '{"ok":true}' }], details: { ok: true } },
});

async function startTurn() {
  const server = await startMockServer();
  const input: unknown[] = [makeUserInput("UXAGENT steps=2 chunks=4 interval=0 label=REPLY")];
  const request = () => expectNonStreamingResponsesJson(server, { tools, input });
  const complete = (call: Record<string, unknown>, output: string) => {
    input.push(call, makeToolOutputWithCallId(String(call.call_id), output));
    return request();
  };
  return { request, complete };
}

describe("UXAGENT fixture", () => {
  it("routes progress card steps through the catalog, closes the card, then replies", async () => {
    const turn = await startTurn();
    const opened = outputToolCall(await turn.request(), "dispatch_action");
    expect(callArgs(opened)).toMatchObject({ id: "progress_card" });
    const closing = outputToolCall(await turn.complete(opened, cardSaved), "dispatch_action");
    expect(callArgs(closing)).toMatchObject({
      id: "progress_card",
      args: {
        plan: [
          { step: expect.stringMatching(/^REPLY /), status: "completed" },
          { step: expect.stringMatching(/^REPLY /), status: "completed" },
        ],
      },
    });
    expect(outputText(await turn.complete(closing, cardSaved))).toContain("UX-STREAM-END");
  });

  it("ends the turn instead of replying when a tool step fails", async () => {
    const turn = await startTurn();
    const opened = outputToolCall(await turn.request(), "dispatch_action");
    const failed = await turn.complete(opened, "Tool progress_card not found");
    expect(outputText(failed)).toBe("UX-AGENT-TOOL-FAILED");
  });
});
