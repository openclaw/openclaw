import { expect, it } from "vitest";
import {
  compact,
  prepareCompaction,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { SessionTreeEntry } from "../../../packages/agent-core/src/harness/types.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { withSessionState } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";
import { text } from "./session-message-fixtures.test-support.js";

const summaryModel = makeProviderModelFixture({
  id: "summary-model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  contextWindow: 100_000,
  maxTokens: 8_000,
});

it("persists a generated provenance compaction across reload and branch navigation", async () => {
  await withSessionState("provenance-compaction", async ({ scope }) => {
    const source = SessionManager.open(scope);
    const attributedUser = (content: string, timestamp: number, senderName: string) =>
      Object.assign(makeUserMessage(content, timestamp), {
        __openclaw: { senderId: `${senderName.toLowerCase()}-id`, senderName },
      });
    source.appendMessage(attributedUser("Approve the rollout.", 1, "Alex"));
    source.appendMessage(attributedUser("Do not deploy until I review it.", 2, "Bea"));
    source.appendMessage(makeUserMessage("A legacy note with no known speaker.", 3));
    source.appendMessage(makeUserMessage("What remains?", 4));
    const preparation = prepareCompaction(source.getBranch() as SessionTreeEntry[], {
      enabled: true,
      reserveTokens: 1_000,
      keepRecentTokens: 1,
    });
    if (!preparation.ok || !preparation.value) {
      throw new Error("expected persisted transcript to be compactable");
    }
    const result = await compact(
      preparation.value,
      summaryModel,
      undefined,
      undefined,
      "Ignore speaker attribution.",
      undefined,
      undefined,
      undefined,
      {
        completeSimple: async () =>
          makeAgentAssistantMessage({
            content: text(
              "Alex approved rollout. Bea requires review. Legacy note remains unattributed.",
            ),
          }),
      },
    );
    if (!result.ok) {
      throw result.error;
    }
    source.appendCompaction(
      result.value.summary,
      result.value.firstKeptEntryId,
      result.value.tokensBefore,
      result.value.details,
    );
    const branchSummary = "Branch navigation keeps the provenance summary.";
    const branchSummaryId = source.branchWithSummary(source.getLeafId(), branchSummary);
    source.branch(branchSummaryId);
    source.appendMessage(makeUserMessage("Branch follow-up.", 6));
    await waitForSessionTranscriptProjection(scope);

    expect(SessionManager.open(scope).getBranch()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "compaction", summary: result.value.summary }),
        expect.objectContaining({
          type: "branch_summary",
          id: branchSummaryId,
          summary: branchSummary,
        }),
      ]),
    );
    const context = SessionManager.openModelContext(scope).buildSessionContext();
    expect(context.messages).toContainEqual(
      expect.objectContaining({ role: "compactionSummary", summary: result.value.summary }),
    );
    expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "Branch follow-up." });
  });
});
