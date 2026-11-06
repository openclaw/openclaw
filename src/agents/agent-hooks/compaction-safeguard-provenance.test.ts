import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as compactionModule from "../compaction.js";
import { buildAgentRunBlockedUserMessage } from "../harness/before-agent-run.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import {
  testing,
  structuredSummary,
  createQualityGuardSessionManager as qualitySession,
  createCompactionEvent as compactionEvent,
  runCompactionScenario as runCompaction,
  expectCompactionResult,
  userMessage,
} from "./compaction-safeguard.test-support.js";

const summarizeHistory = vi.fn(compactionModule.summarizeCompactionHistory);

beforeEach(() => {
  summarizeHistory.mockReset();
  testing.setSummarizeCompactionHistoryForTest(summarizeHistory);
});

afterEach(() => {
  testing.setSummarizeCompactionHistoryForTest();
});

it("keeps internal input attributed while recovering the human ask in the registered hook", async () => {
  const request = "Review the patch; do not deploy it.";
  const messages = [
    Object.assign(userMessage(request, 1), { __openclaw: { senderId: "alice" } }),
    castAgentMessage(timestampedTextAssistant("Review started.", 2)),
    Object.assign(userMessage("Worker result: tests passed.", 3), {
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    }),
    Object.assign(userMessage("Scheduler status: ready.", 4), {
      provenance: { kind: "internal_system" },
      __openclaw: { senderId: "scheduler" },
    }),
    buildAgentRunBlockedUserMessage("blocked-run", {
      blockedBy: "review-gate",
      message: "The run was blocked pending review.",
    }),
  ];
  const original = structuredClone(messages);
  summarizeHistory.mockResolvedValue(structuredSummary());
  const { result } = await runCompaction(
    qualitySession({ recentTurnsPreserve: 4, qualityGuardMaxRetries: 0 }),
    compactionEvent({
      preparation: {
        requestSelection: { state: "unresolved", request },
        latestUnresolvedUserRequest: request,
        messagesToSummarize: messages,
        isSplitTurn: true,
        turnPrefixMessages: [
          Object.assign(userMessage("Future-origin status: ready.", 5), {
            provenance: { kind: "future_origin" },
          }),
        ],
      },
    }),
  );
  const { summary } = expectCompactionResult(result);
  const pendingAsks = summary.split("## Pending user asks\n")[1]?.split("\n## ")[0];
  expect(pendingAsks).toContain(request);
  expect(pendingAsks).not.toContain("Future-origin status");
  expect(summary).toContain(`- User sender={"id":"alice"}: ${request}`);
  expect(summary).toContain("- Inter-session input: Worker result: tests passed.");
  expect(summary).toContain(
    '- Internal system input sender={"id":"scheduler"}: Scheduler status: ready.',
  );
  expect(summary).toContain("- Internal system input: The run was blocked pending review.");
  expect(messages).toEqual(original);
});

it("does not revive a completed ask when the run owner selects none", async () => {
  const staleAsk = "Completed task: publish the old announcement.";
  summarizeHistory.mockResolvedValue(structuredSummary({ asks: staleAsk }));
  const { result } = await runCompaction(
    qualitySession({ recentTurnsPreserve: 0, qualityGuardMaxRetries: 0 }),
    compactionEvent({
      preparation: {
        requestSelection: { state: "none" },
        messagesToSummarize: [
          userMessage(staleAsk, 1),
          castAgentMessage(timestampedTextAssistant("The task is finished.", 2)),
          Object.assign(userMessage("Independent internal task.", 3), {
            provenance: { kind: "internal_system" },
          }),
        ],
      },
    }),
  );

  const pendingAsks = expectCompactionResult(result)
    .summary.split("## Pending user asks\n")[1]
    ?.split("\n## ")[0];
  expect(pendingAsks).not.toContain(staleAsk);
});
