import { expect, it } from "vitest";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { toolResult } from "./session-message-fixtures.test-support.js";

it("retains a persisted real result when its assistant call ID has surrounding whitespace", async () => {
  await withSessionState("padded-replay", async ({ scope }) => {
    const writer = await SessionManager.openAsync(scope);
    await writer.appendMessageAsync(
      makeAgentAssistantMessage({
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: " call_1 ", name: "read", arguments: {} }],
      }),
    );
    await writer.appendMessageAsync(toolResult("retained file contents", " call_1 ", 1));

    const reopened = await SessionManager.openAsync(scope);
    const persisted = reopened.buildSessionContext().messages;
    expect(persisted).toHaveLength(2);
    expect(persisted[1]).toMatchObject({ toolCallId: " call_1 ", isError: false });
    const repaired = sanitizeToolUseResultPairing(persisted);
    expect(repaired).toEqual(persisted);
    expect(repaired[1]).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "retained file contents" }],
    });
  });
});
