import { expect, it } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { sessionManagerReadInitialContext } from "../../sessions/session-manager-current-turn.js";
import { withSessionState } from "../../sessions/session-manager-fixtures.test-support.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { resolveEmbeddedSessionContextLimits } from "./session-context-limits.js";

async function appendScreenshotStep(source: SessionManager, id: string) {
  await source.appendMessageAsync(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id, name: "computer", arguments: { action: "screenshot" } }],
      stopReason: "toolUse",
    }),
  );
  await source.appendMessageAsync({
    role: "toolResult",
    toolCallId: id,
    toolName: "computer",
    content: [
      { type: "text", text: `screenshot ${id}` },
      { type: "image", data: "A".repeat(4_000), mimeType: "image/jpeg" },
    ],
    isError: false,
    timestamp: 1,
  });
}

it("keeps the conversation when screenshots fill an ordinary attempt's byte bound", async () => {
  await withSessionState("embedded-context-screenshot-pressure", async ({ scope }) => {
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync(makeUserMessage("original goal: install the new build", 0));
    for (const id of ["shot-0", "shot-1", "shot-2", "shot-3"]) {
      await appendScreenshotStep(source, id);
    }
    await source.appendMessageAsync(
      makeAgentAssistantMessage({ content: [{ type: "text", text: "build is running" }] }),
    );
    await source.appendMessageAsync(makeUserMessage("did you install it?", 1));

    // Ordinary attempts open the writer bounded, then read the model's initial history.
    const limits = resolveEmbeddedSessionContextLimits({ contextTokenBudget: 1_024 });
    const manager = await SessionManager.openBoundedAsync(scope, limits);
    const { messages } = await manager[sessionManagerReadInitialContext]();
    const serialized = JSON.stringify(messages);

    expect(serialized).toContain("original goal: install the new build");
    expect(serialized).toContain("build is running");
    expect(serialized).toContain("did you install it?");
    expect(serialized).toContain("body omitted");
    expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(4);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(limits.maxBytes);
  });
});
