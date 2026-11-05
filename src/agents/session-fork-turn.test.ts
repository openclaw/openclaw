import assert from "node:assert/strict";
import { afterEach, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { readSessionForkTurn } from "./session-fork-run.js";
import { withSessionState } from "./sessions/session-manager-fixtures.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { toolResult } from "./sessions/session-message-fixtures.test-support.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
});

it("finds a turn input behind a long tool loop without an unlimited context read", async () => {
  await withSessionState("fork-turn-long-tool-loop", async ({ scope }) => {
    const manager = SessionManager.open(scope);
    manager.appendMessage(makeUserMessage("review the repository", 1));
    // More tool events than the second search pass holds, with result bodies it can omit.
    for (let index = 0; index < 2_100; index += 1) {
      const id = `call-${index}`;
      manager.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
          stopReason: "toolUse",
        }),
      );
      manager.appendMessage(toolResult("x".repeat(2_048), id, 1));
    }
    const terminal = await manager.appendMessageWithTranscriptAnchorAsync(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "done" }],
        provider: "openai",
        model: "gpt-test",
      }),
    );
    assert(terminal.anchor, "Missing completed-turn anchor");
    const reads = vi.spyOn(SessionManager, "openModelContextAsync");

    await expect(readSessionForkTurn(terminal.anchor)).resolves.toEqual({
      model: { provider: "openai", model: "gpt-test" },
    });
    expect(reads.mock.calls.map(([, options]) => options?.limits)).toEqual([
      { maxBytes: 65_536, maxEvents: 64, toolResultOverflow: "omit" },
      { maxBytes: 4_194_304, maxEvents: 4_096, toolResultOverflow: "omit" },
      { maxBytes: 16_777_216, maxEvents: 32_768, toolResultOverflow: "omit" },
    ]);
  });
});
