import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeInStages } from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import {
  testing,
  structuredSummary,
  modelSession,
  toolResultMessage,
  userMessage,
  toolCallMessage,
  createCompactionEvent,
  runCompactionScenario,
  expectCompactionResult,
} from "./compaction-safeguard.test-support.js";

const mockSummarizeInStages = vi.fn<typeof summarizeInStages>();
beforeEach(() => {
  mockSummarizeInStages.mockReset();
  testing.setSummarizeInStagesForTest(mockSummarizeInStages);
});
afterEach(() => testing.setSummarizeInStagesForTest());

describe("compaction correction reconciliation", () => {
  it.each([
    { name: "split-turn correction", split: true, previous: true },
    { name: "preserved correction", split: false, previous: true },
    { name: "split-turn correction without a previous summary", split: true, previous: false },
  ])("reconciles $name in the main summary request", async ({ split, previous }) => {
    const oldState =
      "Owner: Maya. Launch date: October 8. Verification: pending. Preparation unfinished.";
    const correction =
      "Confirmed launch date: October 15, not October 8. Maya remains owner. No date-editing task is pending.";
    const corrections = [
      userMessage(correction, 3),
      toolCallMessage("verify_1", "verify", 4),
      toolResultMessage("verify_1", "Verification FAILED: missing release approval.", {
        toolName: "verify",
        timestamp: 5,
        isError: false,
      }),
    ];
    const oldMessages = [
      userMessage(oldState, 1),
      castAgentMessage(timestampedTextAssistant("Recorded.", 2)),
    ];
    mockSummarizeInStages.mockImplementation(async (params) =>
      params.summaryPrompt?.kind === "custom"
        ? structuredSummary({
            decisions:
              "Maya owns the October 15 launch. Verification ran and failed: missing release approval. Preparation unfinished.",
          })
        : "Date finalized: October 15. Verification failed: missing release approval.",
    );
    const sessionManager = modelSession({ recentTurnsPreserve: 3, qualityGuardEnabled: false });
    const { result } = await runCompactionScenario(
      sessionManager,
      createCompactionEvent({
        preparation: {
          messagesToSummarize: split ? oldMessages : [...oldMessages, ...corrections],
          turnPrefixMessages: split ? corrections : [],
          isSplitTurn: split,
          previousSummary: previous ? oldState : undefined,
        },
      }),
    );
    const main = mockSummarizeInStages.mock.calls
      .map(([params]) => params)
      .find((params) => params.summaryPrompt?.kind === "custom");
    expect(main).toBeDefined();
    expect(main?.messages).toEqual(expect.arrayContaining([...oldMessages, ...corrections]));
    expect(JSON.stringify(main?.messages)).toContain(oldState);
    const decisions = expectCompactionResult(result).summary.split("## Open TODOs")[0];
    expect(decisions).toContain("October 15");
    expect(decisions).toContain("Verification ran and failed");
    expect(decisions).not.toContain("October 8");
    expect(decisions).not.toContain("Verification: pending");
  });
});
