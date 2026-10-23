import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareCompaction } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
import { createMessageEntry } from "../../../packages/agent-core/src/harness/compaction/compaction.test-support.js";
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
        requestState: "unresolved",
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

it.each(["unresolved", "none"] as const)(
  "does not revive a completed human ask in a %s run-scoped hook",
  async (requestState) => {
    const staleAsk = "Completed task: publish the old announcement.";
    const newlyCompletedAsk = "Review the new patch without publishing it.";
    const prepared = prepareCompaction(
      [
        createMessageEntry(userMessage(staleAsk, 1), 0),
        createMessageEntry(
          castAgentMessage(timestampedTextAssistant("The task is finished.", 2)),
          1,
        ),
        createMessageEntry(
          requestState === "none"
            ? userMessage(newlyCompletedAsk, 3)
            : Object.assign(userMessage("Independent internal task.", 3), {
                provenance: { kind: "internal_system" },
              }),
          2,
        ),
        createMessageEntry(
          castAgentMessage(timestampedTextAssistant("Internal work continues.", 4)),
          3,
        ),
      ],
      { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 },
      requestState === "unresolved" ? "unresolved" : undefined,
    );
    if (!prepared.ok || !prepared.value) {
      throw new Error("expected a compactable history");
    }
    summarizeHistory.mockResolvedValue(structuredSummary());
    const { result } = await runCompaction(
      qualitySession({ recentTurnsPreserve: 0, qualityGuardMaxRetries: 0 }),
      compactionEvent({
        preparation: { ...prepared.value, requestState },
      }),
    );
    const { summary } = expectCompactionResult(result);
    const pendingAsks = summary.split("## Pending user asks\n")[1]?.split("\n## ")[0];
    expect(pendingAsks).not.toContain(staleAsk);
    if (requestState === "none") {
      expect(pendingAsks).not.toContain(newlyCompletedAsk);
    }
  },
);

it.each([false, true])(
  "stops legacy ask selection at an internal input (split=%s)",
  async (isSplitTurn) => {
    const staleAsk = "Completed human task.";
    const internal = Object.assign(userMessage("Independent worker task.", 3), {
      provenance: { kind: "inter_session" },
    });
    summarizeHistory.mockResolvedValue(structuredSummary());
    const { result } = await runCompaction(
      qualitySession({ recentTurnsPreserve: 0, qualityGuardMaxRetries: 0 }),
      compactionEvent({
        preparation: {
          messagesToSummarize: [
            userMessage(staleAsk, 1),
            castAgentMessage(timestampedTextAssistant("Completed.", 2)),
            ...(isSplitTurn ? [] : [internal]),
          ],
          turnPrefixMessages: isSplitTurn ? [internal] : [],
          isSplitTurn,
        },
      }),
    );
    const pendingAsks = expectCompactionResult(result)
      .summary.split("## Pending user asks\n")[1]
      ?.split("\n## ")[0];
    expect(pendingAsks).not.toContain(staleAsk);
  },
);
