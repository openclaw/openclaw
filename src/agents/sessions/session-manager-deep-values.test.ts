import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { assistantText, withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

it("preserves deep tool details and append parents across reopening", () =>
  withSessionState("deep-details", async ({ scope, state }) => {
    const manager = guardSessionManager(
      await SessionManager.openAsync(scope, state.workspaceDir),
      {},
    );
    await manager.appendMessageAsync(makeUserMessage("run it", 1));
    await manager.appendMessageAsync({
      ...assistantText(""),
      content: [{ type: "toolCall", id: "call-1", name: "probe", arguments: {} }],
      stopReason: "toolUse",
    });
    // Valid canonical JSON can exceed SQLite JSON1's 1,000-level nesting limit.
    const details: unknown = JSON.parse(`${"[".repeat(1100)}1${"]".repeat(1100)}`);
    const toolId = await manager.appendMessageAsync({
      ...makeTextToolResult("call-1", "probe", "done", false, 3),
      details,
    });
    const nextId = await manager.appendMessageAsync(makeUserMessage("next turn", 4));
    assert(toolId && nextId);
    expect(manager.getEntry(nextId)?.parentId).toBe(toolId);
    const context = await SessionManager.openModelContextAsync(scope, {
      limits: { maxBytes: 2048, maxEvents: 8 },
    });
    expect(context.buildSessionContext().messages).toHaveLength(4);

    await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
    const reopened = await SessionManager.openAsync(scope, state.workspaceDir);
    const afterRestart = await reopened.appendMessageAsync(makeUserMessage("after reopen", 5));
    assert(afterRestart);
    expect(reopened.getEntry(afterRestart)?.parentId).toBe(nextId);
    const stored = reopened.getEntry(toolId);
    assert(stored?.type === "message" && stored.message.role === "toolResult");
    expect(JSON.stringify(stored.message.details)).toBe(JSON.stringify(details));
  }));
