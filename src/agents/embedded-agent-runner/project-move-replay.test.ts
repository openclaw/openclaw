import type { ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { describePastProjectMoves } from "./project-move-replay.js";

it("keeps sibling tool results native while describing a past move and its actual receipt", () => {
  const move = {
    type: "toolCall" as const,
    id: "m",
    name: "session_project",
    arguments: { action: "move", projectId: "garden" },
  };
  const read = { type: "toolCall" as const, id: "r", name: "read", arguments: { path: "note" } };
  const assistant = makeAssistantMessageFixture({ content: [move, read], stopReason: "toolUse" });
  const result = (toolName: string, toolCallId: string, text: string): ToolResultMessage => ({
    role: "toolResult",
    toolName,
    toolCallId,
    content: [{ type: "text", text }],
    timestamp: 1,
    isError: false,
  });
  const readResult = result("read", "r", "note contents");
  const history = [assistant, readResult, result("session_project", "m", '{"status":"started"}')];
  const projected = describePastProjectMoves(history);
  expect(projected).toEqual([
    {
      ...assistant,
      content: [
        {
          type: "text",
          text: 'Earlier project move request: {"action":"move","projectId":"garden"}\nGateway receipt: {"status":"started"}',
        },
        read,
      ],
    },
    readResult,
  ]);
  expect(assistant.content[0]).toBe(move);
});
