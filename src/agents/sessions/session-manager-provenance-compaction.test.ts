import path from "node:path";
import { expect, it } from "vitest";
import {
  compact,
  prepareCompaction,
} from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import type { SessionTreeEntry } from "../../../packages/agent-core/src/harness/types.js";
import type { Model } from "../../../packages/agent-core/src/llm.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

const summaryModel: Model = {
  id: "summary-model",
  name: "Summary Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 8_000,
};

it("persists a generated provenance compaction across reload and branch navigation", async () => {
  await withOpenClawTestState({ label: "model-context-provenance-compaction" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "provenance-compaction",
      sessionKey: "agent:main:provenance-compaction",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = SessionManager.open(scope);
    source.appendMessage({
      role: "user",
      content: "Approve the rollout.",
      timestamp: 1,
      __openclaw: { senderId: "alex-id", senderName: "Alex" },
    } as Parameters<SessionManager["appendMessage"]>[0]);
    source.appendMessage({
      role: "user",
      content: "Do not deploy until I review it.",
      timestamp: 2,
      __openclaw: { senderId: "bea-id", senderName: "Bea" },
    } as Parameters<SessionManager["appendMessage"]>[0]);
    source.appendMessage({
      role: "user",
      content: "A legacy note with no known speaker.",
      timestamp: 3,
    });
    source.appendMessage({ role: "user", content: "What remains?", timestamp: 4 });
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
            content: [
              {
                type: "text",
                text: "Alex approved rollout. Bea requires review. Legacy note remains unattributed.",
              },
            ],
            api: summaryModel.api,
            provider: summaryModel.provider,
            model: summaryModel.id,
            timestamp: 5,
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
    const branchSummaryId = source.branchWithSummary(
      source.getLeafId(),
      "Branch navigation keeps the provenance summary.",
    );
    source.branch(branchSummaryId);
    source.appendMessage({ role: "user", content: "Branch follow-up.", timestamp: 6 });
    await waitForSessionTranscriptProjection(scope);

    const persisted = SessionManager.open(scope);
    expect(persisted.getBranch()).toContainEqual(
      expect.objectContaining({ type: "compaction", summary: result.value.summary }),
    );
    expect(persisted.getBranch()).toContainEqual(
      expect.objectContaining({
        type: "branch_summary",
        id: branchSummaryId,
        summary: "Branch navigation keeps the provenance summary.",
      }),
    );
    const context = SessionManager.openModelContext(scope).buildSessionContext();
    expect(context.messages).toContainEqual(
      expect.objectContaining({ role: "compactionSummary", summary: result.value.summary }),
    );
    expect(context.messages.at(-1)).toMatchObject({ role: "user", content: "Branch follow-up." });
  });
});
