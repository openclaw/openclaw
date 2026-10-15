import path from "node:path";
import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { loadSessionTranscriptEvents as loadTranscriptEvents } from "../../config/sessions/session-transcript-events.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { recordGatewaySessionRunFailure } from "../../sessions/session-run-error.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
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
          content: "Your request couldn't be completed: Synthetic run failure",
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
