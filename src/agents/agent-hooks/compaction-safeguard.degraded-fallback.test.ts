import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMessageEntry } from "../../../packages/agent-core/src/harness/compaction/compaction.test-support.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { summarizeCompactionHistory } from "../compaction.js";
import { castAgentMessage } from "../test-helpers/agent-message-fixtures.js";
import { timestampedTextAssistant } from "../test-helpers/sparse-transcript.test-support.js";
import { MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES } from "../workspace-bootstrap-read.js";
import { consumeCompactionSafeguardCancellation as consumeCancellation } from "./compaction-safeguard-runtime.js";
import {
  testing,
  stubSessionManager,
  structuredSummary,
  userMessage,
  createQualityGuardSessionManager as qualitySession,
  createCompactionEvent as compactionEvent,
  runCompactionScenario as runCompaction,
  expectCompactionResult,
} from "./compaction-safeguard.test-support.js";
import { readWorkspaceContextForSummary } from "./compaction-workspace-context.js";

const { MAX_COMPACTION_SUMMARY_CHARS, CONTEXT_TRUNCATED_MARKER } = testing;
const summarize = vi.fn<typeof summarizeCompactionHistory>();

beforeEach(() => {
  summarize.mockReset();
  testing.setSummarizeCompactionHistoryForTest(summarize);
});
afterEach(() => testing.setSummarizeCompactionHistoryForTest());

async function degradedSummary(
  event: Parameters<typeof compactionEvent>[0],
  runtime: Parameters<typeof qualitySession>[0] = {},
) {
  const session = qualitySession({ qualityGuardMaxRetries: 0, ...runtime });
  const { result } = await runCompaction(session, compactionEvent(event));
  expect(result).toMatchObject({ compaction: { details: { qualityDegraded: true } } });
  expect(consumeCancellation(session)).toBeNull();
  const { summary } = expectCompactionResult(result);
  expect(summary.length).toBeLessThanOrEqual(MAX_COMPACTION_SUMMARY_CHARS);
  return summary;
}

function expectSummaryContains(summary: string, ...fragments: string[]) {
  fragments.forEach((fragment) => expect(summary).toContain(fragment));
}

it.each(["branch read", "context projection"] as const)(
  "cancels rather than writing an empty boundary after a failed %s",
  async (stage) => {
    const failure = new Error(`Failed ${stage}`);
    const sessionManager = stubSessionManager();
    sessionManager.getBranch = () => {
      if (stage === "branch read") {
        throw failure;
      }
      const kept = createMessageEntry(userMessage("Kept user request", 1), 1);
      if (kept.type !== "message") {
        throw new Error("Expected a message fixture");
      }
      return [
        {
          ...kept,
          id: "entry-0",
          parentId: null,
          timestamp: "1970-01-01T00:00:00.000Z",
          get message(): never {
            throw failure;
          },
        },
        kept,
      ];
    };
    const { result, getApiKeyAndHeadersMock } = await runCompaction(
      sessionManager,
      compactionEvent({ preparation: { messagesToSummarize: [] } }),
    );

    expect(result).toEqual({ cancel: true });
    expect(consumeCancellation(sessionManager)).toEqual({
      reason: "session history inspection failed",
      error: failure,
    });
    expect(getApiKeyAndHeadersMock).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
  },
);

it("degrades oversized identifiers while preserving the run-owned request", async () => {
  const latestAsk = "preserve the pending deployment status";
  const identifier = `https://example.com/${"a".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`;
  const fittingIdentifier = "/var/log/deploy-status.log";
  summarize.mockResolvedValue(structuredSummary({ asks: latestAsk, identifiers: identifier }));

  const summary = await degradedSummary({
    preparation: {
      messagesToSummarize: [
        userMessage(`the status log is ${fittingIdentifier}`, 1),
        userMessage(`${latestAsk} ${identifier}`, 2),
      ],
      latestUnresolvedUserRequest: latestAsk,
    },
  });

  expectSummaryContains(summary, "Latest user request context:", latestAsk, fittingIdentifier);
  expect(summary).not.toContain(identifier);
});

it("keeps the stronger summary when a corrective retry loses context", async () => {
  const better = structuredSummary({ decisions: "Keep blue." }).replace("## Exact", "Exact");
  summarize.mockResolvedValueOnce(better).mockResolvedValueOnce("Unrelated retry.");
  const identifier = "/tmp/degraded-retention.log";
  const summary = await degradedSummary(
    { messageText: `status ${identifier}` },
    { qualityGuardMaxRetries: 1 },
  );
  expectSummaryContains(summary, "Keep blue.", "status", identifier);
  expect(summary).not.toContain("Unrelated retry");
  expect(summary.match(/^## Pending user asks$/gm)).toHaveLength(1);
  expect(summarize).toHaveBeenCalledTimes(2);
});

it("keeps generated split-turn context when a terminal audit trims the suffix", async () => {
  const latestAsk = "roll back the api deployment and confirm health";
  const activeTurn = "Active turn: rolled back api-7 and is waiting on the health check.";
  const files = (kind: string) =>
    Array.from({ length: 40 }, (_, index) => `/srv/app/${kind}/module-${index}.ts`);
  const history = Array.from({ length: 14 }, (_, turn) => [
    userMessage(`turn ${turn} ${"u".repeat(700)}`, 2 * turn + 1),
    castAgentMessage(timestampedTextAssistant(`reply ${turn} ${"r".repeat(700)}`, 2 * turn + 2)),
  ]).flat();
  summarize.mockImplementation(async (params) =>
    params.summaryPrompt?.kind === "custom"
      ? "Core summary without headings"
      : `${activeTurn} ${"z".repeat(MAX_COMPACTION_SUMMARY_CHARS)}`,
  );

  const event = compactionEvent({
    preparation: {
      messagesToSummarize: history,
      turnPrefixMessages: [userMessage(latestAsk, 100)],
      isSplitTurn: true,
    },
  });
  Object.assign(event.preparation.fileOps, { read: files("read"), edited: files("edit") });
  const summary = await degradedSummary(event, { recentTurnsPreserve: 12 });
  // Capping the suffix by its tail used to drop the active split turn first.
  expectSummaryContains(
    summary,
    `**Turn Context (split turn):**\n\n${activeTurn}`,
    latestAsk,
    CONTEXT_TRUNCATED_MARKER.trim(),
    "reply 13 ",
  );
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
function workspace(content: string) {
  const root = tempDirs.make("openclaw-compaction-summary-");
  fs.writeFileSync(path.join(root, "AGENTS.md"), content);
  return root;
}

const startup = ["Session Startup"];
const defaults = [...startup, "Red Lines"];
const section = (text: string, name = startup[0]) => `## ${name}\n\n${text}`;
const wrapRules = (text: string) =>
  `\n\n<workspace-critical-rules>\n${text}\n</workspace-critical-rules>`;
const rules = section("Read AGENTS.md");
const legacy = `${section("Start.", "Every Session")}\n\n${section("Be safe.", "Safety")}`;
const limitPrefix = section("").padEnd(1_999, "x");
const boundedContent = `${limitPrefix}🚀tail\n`;
const atByteLimit = boundedContent.padEnd(
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES - Buffer.byteLength(boundedContent) + boundedContent.length,
  "x",
);
const read = (root: string | undefined) => readWorkspaceContextForSummary(startup, root);
it.each<[string, string, string, string[]]>([
  ["disabled sections", rules, "", []],
  ["oversized file", atByteLimit + "x", "", startup],
  ["byte limit", atByteLimit, `${limitPrefix}\n...[truncated]...`, startup],
  ["legacy defaults", legacy, legacy, defaults],
  ["missing sections", section("No rules", "Other"), "", startup],
  ["partial sections", rules, rules, defaults],
])("reads workspace context with %s", async (_, content, expected, sections) => {
  const result = await readWorkspaceContextForSummary(sections, workspace(content));
  expect(result).toBe(expected ? wrapRules(expected) : "");
});

it("uses only the configured workspace", async ({ onTestFinished }) => {
  const processRoot = workspace(section("Wrong cwd"));
  const workspaceRoot = workspace(`${rules}\n${section("Ignore me", "Other")}`);
  const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(processRoot);
  onTestFinished(() => cwdSpy.mockRestore());
  expect(await read(workspaceRoot)).toBe(wrapRules(rules));
  await expect(read(undefined)).resolves.toBe("");
  fs.unlinkSync(path.join(workspaceRoot, "AGENTS.md"));
  await expect(read(workspaceRoot)).resolves.toBe("");
});

it.runIf(process.platform !== "win32").each(["symlink", "hardlink"] as const)(
  "returns empty when AGENTS.md is a %s alias",
  async (kind) => {
    const root = tempDirs.make("openclaw-compaction-summary-");
    const outside = path.join(root, "outside-secret.txt");
    fs.writeFileSync(outside, "secret");
    const link = kind === "symlink" ? fs.symlinkSync : fs.linkSync;
    link(outside, path.join(root, "AGENTS.md"));
    await expect(read(root)).resolves.toBe("");
  },
);
