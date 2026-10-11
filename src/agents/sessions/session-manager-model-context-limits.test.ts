import path from "node:path";
import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

async function withHistory(
  label: string,
  run: (fixture: {
    scope: SessionTranscriptRuntimeTarget;
    source: SessionManager;
    verifyRead: (read: () => void | Promise<void>) => Promise<void>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: label,
      sessionKey: `agent:main:${label}`,
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    const snapshot = () =>
      database.db
        .prepare(`SELECT seq, event_json, event_zstd, event_utf8_bytes, navigation_json, created_at
          FROM transcript_events WHERE session_id = ? ORDER BY seq`)
        .all(scope.sessionId);
    await run({
      scope,
      source,
      verifyRead: async (read) => {
        const before = snapshot();
        try {
          await read();
        } finally {
          expect(snapshot()).toEqual(before);
        }
      },
    });
  });
}

function appendCall(source: SessionManager, id: string) {
  return source.appendMessage(
    makeAgentAssistantMessage({
      content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
      stopReason: "toolUse",
    }),
  );
}

function appendResult(source: SessionManager, id: string, text = `result ${id}`) {
  return source.appendMessage({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
  });
}

it("retires prior-series operators through bounded and detached transcript reads", async () => {
  await withHistory("context-system-prompt-series", async ({ scope, source, verifyRead }) => {
    source.appendMessage(makeUserMessage("Keep this question", 1));
    const appendOperator = (content: string, kind: "prompt-update" | "runtime-context") =>
      source.appendCustomMessageEntry("openclaw.system-update", content, false, {
        kind,
        turnScoped: kind === "runtime-context",
      });
    appendOperator("Retired instructions", "prompt-update");
    appendOperator("Retained turn facts", "runtime-context");
    const series = {
      prefix: "Pinned stable instructions. ".repeat(100),
      hash: "retained-prefix-hash",
      renderedPrefix: "Effective stable instructions. ".repeat(100),
      routeKey: "synthetic-provider/model/api-key",
      historyId: null,
    };
    source.appendCustomEntry("openclaw.system-prompt", { ...series, restart: true });
    appendOperator("Current instructions", "prompt-update");
    appendOperator("Current facts", "runtime-context");
    const checkpoint = { ...series, restart: false };
    source.appendCustomEntry("openclaw.system-prompt", checkpoint);
    const expected = source.buildSessionContext();
    expect(expected.messages).toMatchObject([
      { role: "user", content: "Keep this question" },
      { role: "custom", content: "Retained turn facts" },
      { role: "custom", content: "Current instructions" },
      { role: "custom", content: "Current facts" },
    ]);
    await verifyRead(async () => {
      const limits = { maxBytes: 16_384, maxEvents: 16 };
      for (const restored of [
        SessionManager.openBounded(scope, limits),
        await SessionManager.openBoundedAsync(scope, limits),
      ]) {
        expect(restored.buildSessionContext()).toEqual(expected);
        expect(
          restored
            .getBranch()
            .findLast(
              (entry) => entry.type === "custom" && entry.customType === "openclaw.system-prompt",
            ),
        ).toMatchObject({ data: checkpoint });
      }
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(expected);
      expect(
        (await SessionManager.openModelContextAsync(scope, { limits })).buildSessionContext(),
      ).toEqual(expected);
    });
  });
});

it("rejects a cut that would give an ambiguous result a new unique owner", async () => {
  await withHistory("context-ambiguous-owner", async ({ scope, source, verifyRead }) => {
    appendCall(source, "repeat");
    appendCall(source, "other");
    appendCall(source, "repeat");
    appendCall(source, "last");
    appendResult(source, "repeat");
    source.appendMessage(makeUserMessage("latest", 2));
    const full = source.buildSessionContext();
    await verifyRead(async () => {
      const options = { limits: { maxBytes: 16_384, maxEvents: 4 } };
      expect(() => SessionManager.openModelContext(scope, options)).toThrow(/ownership/u);
      await expect(SessionManager.openModelContextAsync(scope, options)).rejects.toThrow(
        /ownership/u,
      );
      expect(() =>
        SessionManager.openModelContext(scope, {
          limits: { ...options.limits, toolResultOverflow: "omit" },
        }),
      ).toThrow(/ownership/u);
      expect(SessionManager.openModelContext(scope).buildSessionContext()).toEqual(full);
    });
  });
});
