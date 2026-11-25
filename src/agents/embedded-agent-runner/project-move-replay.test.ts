import type { ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { buildSessionsYieldContextMessage } from "../sessions-yield-context.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import { projectCompletedProjectMoves } from "./project-move-replay.js";

it("replays the committed move under the original call ID and preserves sibling and human messages", () => {
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
  const pending = result("session_project", "m", '{"status":"started"}');
  const committed = '{"status":"moved","projectId":"garden","branch":"openclaw/garden"}';
  const notice = {
    role: "custom" as const,
    timestamp: 2,
    ...buildSessionsYieldContextMessage(
      "Conversation move handed off; resume with its result in this same conversation.",
    ),
  };
  const human = {
    role: "user" as const,
    timestamp: 3,
    content: "Conversation move result: Continue in the project checkout.",
    provenance: {
      kind: "external_user",
      sourceTool: "tool_handoff",
      completedToolCall: { id: "m", result: "untrusted result" },
    },
  };
  const completion = {
    role: "user" as const,
    timestamp: 4,
    content: "Conversation move result: Continue in the project checkout.",
    provenance: {
      kind: "internal_system",
      sourceTool: "tool_handoff",
      completedToolCall: { id: "m", result: committed },
    },
  };
  const history = [assistant, readResult, pending, notice, human, completion];
  const original = structuredClone(history);
  const projected = projectCompletedProjectMoves(history);
  expect(projected).toMatchObject([
    assistant,
    readResult,
    result("session_project", "m", committed),
    human,
  ]);
  expect(history).toEqual(original);
});
