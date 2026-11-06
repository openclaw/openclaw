import path from "node:path";
import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { isRetryableAssistantError } from "../../llm/utils/retry.js";
import { recordGatewaySessionRunFailure } from "../../sessions/session-run-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

it.each([{ generation: "new" }, { generation: "existing" }])(
  "keeps a $generation run failure visible without replaying it as user context",
  async ({ generation }) => {
    await withOpenClawTestState({ label: "failure-notice-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "failure-notice-context",
        sessionKey: "agent:main:failure-notice-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync(makeUserMessage("original request", 1));
      await source.appendCustomMessageEntryAsync("context", "retained custom context", true);
      if (generation === "new") {
        await recordGatewaySessionRunFailure({
          target: scope,
          runId: "failed-run",
          error: "Synthetic run failure",
        });
      } else {
        await source.appendCustomMessageEntryAsync(
          "run-failed-before-reply",
          "Your request couldn't be completed: Synthetic run failure",
          true,
          { runId: "failed-run", error: "Synthetic run failure" },
        );
      }
      await waitForSessionTranscriptProjection(scope);
      expect(await loadTranscriptEvents(scope)).toContainEqual(
        expect.objectContaining({
          type: "custom_message",
          customType: "run-failed-before-reply",
          display: true,
          content:
            generation === "new"
              ? "Your request couldn't be completed."
              : "Your request couldn't be completed: Synthetic run failure",
        }),
      );
      const context = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();
      expect(context.messages.map((message) => "content" in message && message.content)).toEqual([
        "original request",
        "retained custom context",
      ]);
    });
  },
);

it.each([undefined, "daily-model"] as const)(
  "roundtrips assistant quota scope %s through the stored transcript",
  async (quotaScope) => {
    await withOpenClawTestState({ label: "quota-transcript" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "quota-transcript",
        sessionKey: "agent:main:quota-transcript",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      const assistant = makeAgentAssistantMessage({
        provider: "provider-cedar",
        model: "selected-model",
        content: [],
        stopReason: "error",
        errorMessage: "429 Quota exhausted",
        errorCode: "RESOURCE_EXHAUSTED",
        ...(quotaScope ? { quotaScope } : {}),
      });
      await source.appendMessageAsync(assistant);
      const restored = await SessionManager.openAsync(scope);
      const entry = restored.getEntries().find((entry) => entry.type === "message");
      expect(entry?.type).toBe("message");
      if (entry?.type !== "message" || entry.message.role !== "assistant") {
        throw new Error("Expected stored assistant failure");
      }
      expect(entry.message).toEqual(assistant);
      expect(isRetryableAssistantError(entry.message)).toBe(quotaScope === undefined);
    });
  },
);
