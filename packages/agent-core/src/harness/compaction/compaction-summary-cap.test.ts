import { describe, expect, it, vi } from "vitest";
import type { StreamFn } from "../../llm.js";
import {
  createCompactionModel,
  createContextUsage as createUsage,
} from "./compaction.test-support.js";
import {
  assistant,
  compactWith,
  responseStream,
  text,
  toolCall,
} from "./shard-fixtures.test-support.js";
import { createFileOps } from "./utils.js";

const MAX_SUMMARY_CHARS = 16_000;
const TRUNCATED_MARKER = "\n\n[Compaction summary truncated to fit budget]";
const TURN_CONTEXT_HEADING = "\n\n---\n\n**Turn Context (split turn):**\n\n";

describe("split-turn compaction summary cap", () => {
  it("preserves the previous summary and latest split-turn context", async () => {
    const model = createCompactionModel();
    let prefixSummary = "prefix summary";
    const prompts: string[] = [];
    const streamFn = vi.fn<StreamFn>((_model, context) => {
      const promptMessage = context.messages[0];
      if (!promptMessage || promptMessage.role !== "user") {
        throw new Error("expected a user message containing the split-turn prompt");
      }
      prompts.push(
        typeof promptMessage.content === "string"
          ? promptMessage.content
          : promptMessage.content
              .map((block) => (block.type === "text" ? block.text : ""))
              .join(""),
      );
      return responseStream(assistant(prefixSummary, { usage: createUsage(0) }));
    });
    const fileOps = createFileOps();
    fileOps.read.add("src/read.ts");
    fileOps.edited.add("src/write.ts");
    const fileOperations =
      "\n\n<read-files>\nsrc/read.ts\n</read-files>\n\n<modified-files>\nsrc/write.ts\n</modified-files>";
    const nearCapPreviousSummary = `${"p".repeat(
      MAX_SUMMARY_CHARS - fileOperations.length,
    )}${fileOperations}`;
    const runCompaction = async (
      previousSummary = nearCapPreviousSummary,
      budget?: { summaryTokenBudget: number; latestUnresolvedUserRequest: string },
    ) => {
      const result = await compactWith(
        {
          ...budget,
          firstKeptEntryId: "kept-entry",
          messagesToSummarize: [],
          turnPrefixMessages: [
            assistant(
              [
                { type: "thinking", thinking: "PRIVATE_PREFIX_REASONING" },
                text("visible prefix"),
                toolCall("read", { path: "prefix.ts" }, "prefix-call"),
              ],
              { usage: createUsage(1) },
            ),
          ],
          isSplitTurn: true,
          tokensBefore: 100,
          previousSummary,
          previousSummaryDetails: {
            readFiles: ["src/read.ts"],
            modifiedFiles: ["src/write.ts"],
          },
          fileOps,
          settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
        },
        model,
        { streamFn },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw result.error;
      }
      return result.value.summary;
    };

    expect(await runCompaction(`previous summary${fileOperations}`)).toBe(
      `previous summary${TURN_CONTEXT_HEADING}prefix summary${fileOperations}`,
    );
    expect(prompts[0]).toContain("[Assistant]: visible prefix");
    expect(prompts[0]).toContain('[Assistant tool calls]: read(path="prefix.ts")');
    expect(prompts[0]).not.toContain("PRIVATE_PREFIX_REASONING");

    const persistedSummary = await runCompaction();
    expect(persistedSummary.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(persistedSummary).toContain(TRUNCATED_MARKER);
    expect(persistedSummary).toContain("prefix summary");
    expect(persistedSummary.endsWith(fileOperations)).toBe(true);

    const latestContextBudget =
      MAX_SUMMARY_CHARS -
      TRUNCATED_MARKER.length -
      fileOperations.length -
      Math.floor(MAX_SUMMARY_CHARS / 2);
    prefixSummary = `${"x".repeat(latestContextBudget - TURN_CONTEXT_HEADING.length - 1)}🚀tail`;
    const oversizedPrefix = await runCompaction();
    expect(oversizedPrefix.length).toBeLessThanOrEqual(MAX_SUMMARY_CHARS);
    expect(oversizedPrefix).toMatch(/^p{100}/);
    expect(oversizedPrefix).toContain(TURN_CONTEXT_HEADING);
    expect(oversizedPrefix).toContain("x".repeat(100));
    expect(oversizedPrefix).not.toContain("🚀");
    expect(oversizedPrefix).toContain(TRUNCATED_MARKER);
    expect(oversizedPrefix).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(oversizedPrefix).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(oversizedPrefix.endsWith(fileOperations)).toBe(true);
    expect(streamFn).toHaveBeenCalledTimes(3);

    fileOps.read = new Set([`src/${"r".repeat(830)}.ts`]);
    fileOps.edited = new Set([`src/${"w".repeat(820)}.ts`]);
    prefixSummary = "The split turn still needs its archive result.";
    const budgeted = await runCompaction(nearCapPreviousSummary, {
      summaryTokenBudget: 1_000,
      latestUnresolvedUserRequest: "Current request details. ".repeat(32),
    });
    expect(budgeted.length).toBeLessThanOrEqual(4_000);
    expect(budgeted).toContain(prefixSummary);
    expect(budgeted).toContain(TURN_CONTEXT_HEADING);
    expect(budgeted).toContain([...fileOps.read][0]);
    expect(budgeted).toContain([...fileOps.edited][0]);
  });
});
