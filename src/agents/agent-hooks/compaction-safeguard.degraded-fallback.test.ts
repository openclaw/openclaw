import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { summarizeCompactionHistory } from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { consumeCompactionSafeguardCancellation } from "./compaction-safeguard-runtime.js";
import {
  testing,
  structuredSummary,
  userMessage,
  createQualityGuardSessionManager,
  createCompactionEvent,
  runCompactionScenario,
  expectCompactionResult,
} from "./compaction-safeguard.test-support.js";

const { compactionLogger } = vi.hoisted(() => {
  const logger = {
    subsystem: "compaction-safeguard",
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { compactionLogger: logger };
});

vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return { ...actual, createSubsystemLogger: () => compactionLogger };
});

const { MAX_COMPACTION_SUMMARY_CHARS, CONTEXT_TRUNCATED_MARKER } = testing;
const mockSummarizeCompactionHistory = vi.fn<typeof summarizeCompactionHistory>();

beforeEach(() => {
  mockSummarizeCompactionHistory.mockReset();
  testing.setSummarizeCompactionHistoryForTest(mockSummarizeCompactionHistory);
  compactionLogger.warn.mockClear();
});
afterEach(() => testing.setSummarizeCompactionHistoryForTest());

// qualityGuardMaxRetries: 0 makes the first failed audit final, so the terminal path runs.
const terminalAttemptSession = (recentTurnsPreserve = 0) =>
  createQualityGuardSessionManager({ recentTurnsPreserve, qualityGuardMaxRetries: 0 });

describe("compaction-safeguard degraded fallback", () => {
  it.each([
    { name: "source ask", runOwnedRequest: false },
    { name: "run-owned request", runOwnedRequest: true },
  ])(
    "degrades with the $name when an identifier cannot fit the artifact cap",
    async ({ runOwnedRequest }) => {
      const latestAsk = "preserve the pending deployment status";
      const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
      const fittingIdentifier = "/var/log/deploy-status.log";
      mockSummarizeCompactionHistory.mockResolvedValue(
        structuredSummary({ asks: latestAsk, identifiers: identifier }),
      );

      const sessionManager = terminalAttemptSession();
      const { result } = await runCompactionScenario(
        sessionManager,
        createCompactionEvent({
          preparation: {
            messagesToSummarize: [
              userMessage(`the status log is ${fittingIdentifier}`, 1),
              userMessage(`${latestAsk} ${identifier}`, 2),
            ],
            // The session owner bounds a run-owned request to 800 chars before it gets here.
            ...(runOwnedRequest ? { latestUnresolvedUserRequest: latestAsk } : {}),
          },
        }),
      );

      // Cancelling here left the session permanently uncompactable: the required facts
      // never shrink, so every later attempt hits the same wall. Both terminal quality
      // paths now commit the same bounded artifact and mark it as degraded.
      expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
      // Identifiers are best-effort on this path and the request context is bounded, so an
      // identifier that cannot fit must not take the request down with it.
      const summary = expectCompactionResult(result).summary;
      expect(summary).toContain("Latest user request context:");
      expect(summary).toContain(latestAsk);
      expect(summary).toContain(fittingIdentifier);
      expect(summary).not.toContain(identifier);
      expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
      expect(compactionLogger.warn).toHaveBeenCalledWith(
        expect.stringMatching(/loss=.*identifier-retention/),
      );
      expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(1);
      expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
    },
  );

  it("carries the pending ask and identifiers into the degraded fallback and logs its reasonCode", async () => {
    const latestAsk = "confirm the staging rollback finished";
    const identifier = "/tmp/degraded-retention.log";
    // A summary the audit rejects (no required headings), with facts small enough to fit.
    mockSummarizeCompactionHistory.mockResolvedValue("Core summary without headings");

    const sessionManager = terminalAttemptSession();
    const { result } = await runCompactionScenario(
      sessionManager,
      createCompactionEvent({ messageText: `${latestAsk} ${identifier}` }),
    );

    // The degrade is lossy on purpose, but the pending request and exact identifiers are
    // the facts worth carrying across a compaction. Finalizing without the retention plan
    // dropped both and stored only the empty fallback template.
    expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain("Core summary without headings");
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(identifier);
    // Operators and dashboards branch on this marker; pin it so a refactor of the helper's
    // log contract cannot drop it silently.
    expect(compactionLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("reasonCode=quality_guard_degraded_fallback"),
    );
    expect(consumeCompactionSafeguardCancellation(sessionManager)).toBeNull();
  });

  it("keeps the stronger generated summary when a corrective retry loses more context", async () => {
    const better = structuredSummary({ decisions: "Keep the blue deployment." }).replace(
      "## Exact identifiers",
      "Identifiers",
    );
    mockSummarizeCompactionHistory
      .mockResolvedValueOnce(better)
      .mockResolvedValueOnce("Unrelated retry without sections.");
    const { result } = await runCompactionScenario(
      createQualityGuardSessionManager({ recentTurnsPreserve: 0, qualityGuardMaxRetries: 1 }),
      createCompactionEvent({ messageText: "confirm deployment status" }),
    );
    expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
    const summary = expectCompactionResult(result).summary;
    expect(summary).toContain("Keep the blue deployment.");
    expect(summary).not.toContain("Unrelated retry");
    expect(summary.match(/^## Pending user asks$/gm)).toHaveLength(1);
    expect(summary).toContain("confirm deployment status");
    expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps the generated split-turn context when a terminal audit failure trims the degraded suffix", async () => {
    const latestAsk = "roll back the api deployment and confirm health";
    const activeTurn = "Active turn: rolled back api-7 and is waiting on the health check.";
    // Twelve long preserved turns, the file lists and the split-turn summary each fill their
    // own cap, so the degraded suffix alone outgrows the artifact and must be trimmed.
    const files = (kind: string) =>
      Array.from({ length: 40 }, (_, index) => `/srv/app/${kind}/module-${index}.ts`);
    const history = Array.from({ length: 14 }, (_, turn) => [
      userMessage(`turn ${turn} ${"u".repeat(700)}`, 2 * turn + 1),
      castAgentMessage(timestampedTextAssistant(`reply ${turn} ${"r".repeat(700)}`, 2 * turn + 2)),
    ]).flat();
    mockSummarizeCompactionHistory.mockImplementation(async (params) =>
      params.summaryPrompt?.kind === "custom"
        ? "Core summary without headings"
        : `${activeTurn} ${"z".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`,
    );

    const event = createCompactionEvent({
      preparation: {
        messagesToSummarize: history,
        turnPrefixMessages: [userMessage(latestAsk, 100)],
        isSplitTurn: true,
      },
    });
    Object.assign(event.preparation.fileOps, { read: files("read"), edited: files("edit") });
    const { result } = await runCompactionScenario(terminalAttemptSession(12), event);

    expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
    const summary = expectCompactionResult(result).summary;
    // Capping the suffix by its tail used to drop the active split turn first.
    expect(summary).toContain(`**Turn Context (split turn):**\n\n${activeTurn}`);
    expect(summary).toContain(latestAsk);
    expect(summary).toContain(CONTEXT_TRUNCATED_MARKER.trim());
    expect(summary).toContain("reply 13 ");
    expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
    expect(mockSummarizeCompactionHistory).toHaveBeenCalledTimes(2);
  });
});
