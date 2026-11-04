import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { compactWithoutSummary, prepareCompaction } from "./compaction.js";
import {
  createCompactionModel,
  createContextUsage,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";
import { compactWith, responseStream } from "./shard-fixtures.test-support.js";

const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 };
function assistant(text: string, timestamp: number): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test-api",
    provider: "test-provider",
    model: "summary-model",
    usage: createContextUsage(1),
    stopReason: "stop",
    timestamp,
  };
}

function prepare(entries: SessionTreeEntry[], pendingEntryId?: string) {
  const result = prepareCompaction(
    entries,
    settings,
    "unresolved",
    pendingEntryId ? { requestBoundary: { entryId: pendingEntryId, preserve: false } } : undefined,
  );
  if (!result.ok || !result.value) {
    throw new Error("expected compactable history");
  }
  return result.value;
}

describe("manual compaction requests", () => {
  it("preserves a prior pending request when fallback has no authoritative replacement", () => {
    const request = "Review the patch; do not deploy it.";
    const entries: SessionTreeEntry[] = [
      messageEntry(assistant("Prior retained work", 1), 0),
      {
        type: "compaction",
        id: "prior-compaction",
        parentId: "entry-0",
        timestamp: new Date(2).toISOString(),
        firstKeptEntryId: "entry-0",
        tokensBefore: 100,
        summary: `## Latest unresolved user request\n${JSON.stringify(request)}\n\nPrior work continues.`,
        details: { readFiles: [], modifiedFiles: [], latestUnresolvedUserRequest: request },
      },
      messageEntry(assistant("Still working.", 3), 2),
      messageEntry(assistant("Still working after a tool result.", 4), 3),
    ];
    const prepared = prepareCompaction(entries, settings);
    if (!prepared.ok || !prepared.value) {
      throw new Error("expected compactable history");
    }
    expect(prepared.value.latestUnresolvedUserRequest).toBeUndefined();

    const fallback = compactWithoutSummary(prepared.value);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.value.summary).toContain(
        `## Latest unresolved user request\n${JSON.stringify(request)}`,
      );
      expect(fallback.value.summary).toContain("Prior work continues.");
    }
  });
});

describe("run-owned compaction requests", () => {
  it.each([null, "Review the new patch; do not deploy."])(
    "reconciles the prior generated request when the current request is %s",
    async (currentRequest) => {
      const priorSummary =
        'Prior context.\n\n## Latest unresolved user request\n"Completed human task"\n\n## Decisions\nKeep useful facts.';
      const entries: SessionTreeEntry[] = [
        messageEntry(assistant("Prior retained work", 1), 0),
        {
          type: "compaction",
          id: "prior-compaction",
          parentId: "entry-0",
          timestamp: new Date(2).toISOString(),
          firstKeptEntryId: "entry-0",
          tokensBefore: 100,
          summary: priorSummary,
          details: {
            readFiles: ["src/prior.ts"],
            modifiedFiles: ["src/changed.ts"],
            latestUnresolvedUserRequest: "Completed human task",
          },
        },
        messageEntry(assistant("Completed prior work.", 3), 1),
        messageEntry(
          Object.assign(
            { role: "user" as const, content: currentRequest ?? "Internal work", timestamp: 4 },
            currentRequest ? {} : { provenance: { kind: "internal_system" } },
          ),
          2,
        ),
        messageEntry(assistant("Continuing.", 5), 3),
      ];
      let suppliedPriorSummary = "";
      const result = await compactWith(prepare(entries), createCompactionModel(), {
        runtime: {
          completeSimple: async (_model, context) => {
            const prompt = context.messages[0];
            const content = prompt?.content;
            const text =
              typeof content === "string"
                ? content
                : content?.map((block) => (block.type === "text" ? block.text : "")).join("");
            const previous = /<previous-summary>\n([\s\S]*?)\n<\/previous-summary>/u.exec(
              text ?? "",
            );
            if (previous) {
              suppliedPriorSummary = previous[1] ?? "";
            }
            return assistant(previous ? suppliedPriorSummary : "Current turn context.", 6);
          },
        },
      });
      if (!result.ok) {
        throw result.error;
      }
      expect(suppliedPriorSummary).toBe(priorSummary);
      expect(result.value.summary).not.toContain('"Completed human task"');
      expect(result.value.summary).toContain("Keep useful facts.");
      expect(result.value.summary.match(/## Latest unresolved user request/gu) ?? []).toHaveLength(
        currentRequest ? 1 : 0,
      );
      if (currentRequest) {
        expect(result.value.summary).toContain(JSON.stringify(currentRequest));
      }
      expect(result.value.details).toEqual({
        readFiles: ["src/prior.ts"],
        modifiedFiles: ["src/changed.ts"],
        ...(currentRequest ? { latestUnresolvedUserRequest: currentRequest } : {}),
      });
    },
  );

  it("clears stale model-generated pending asks when the owner selects none", async () => {
    const entries = [
      messageEntry({ role: "user", content: "Completed human task", timestamp: 1 }, 0),
      messageEntry(assistant("Completed.", 2), 1),
      messageEntry(
        Object.assign(
          { role: "user" as const, content: "Independent internal task", timestamp: 3 },
          { provenance: { kind: "internal_system" } },
        ),
        2,
      ),
    ];
    const result = await compactWith(prepare(entries), createCompactionModel(), {
      streamFn: () =>
        responseStream(
          assistant(
            "## Pending user asks\n- Completed human task\n\n## Decisions\nKeep the useful facts.",
            4,
          ),
        ),
    });
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.summary).toContain("## Pending user asks\nNone.");
    expect(result.value.summary).not.toContain("Completed human task");
    expect(result.value.summary).toContain("Keep the useful facts.");
  });

  it("attributes a split internal run without reviving completed human work", () => {
    const source = "Inspect the worker artifact; do not publish it.";
    const entries = [
      messageEntry({ role: "user", content: "Completed human task", timestamp: 1 }, 0),
      messageEntry(assistant("Completed.", 2), 1),
      messageEntry(
        Object.assign(
          { role: "user" as const, content: source, timestamp: 3 },
          { provenance: { kind: "inter_session" } },
        ),
        2,
      ),
      messageEntry(assistant("The internal task is still running.", 4), 3),
    ];
    const preparation = prepare(entries);
    expect(preparation.requestSelection).toEqual({ state: "none" });
    expect(preparation.latestUnresolvedUserRequest).toBeUndefined();
    expect(preparation.isSplitTurn).toBe(true);
    const result = compactWithoutSummary(preparation);
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value.summary).toContain(`[Inter-session input]: ${source}`);
  });

  it("keeps the admitted human request across later internal updates", () => {
    const request = "Review the patch; do not deploy it.";
    const entries = [
      messageEntry({ role: "user", content: "Completed earlier task", timestamp: 1 }, 0),
      messageEntry(assistant("Completed.", 2), 1),
      messageEntry({ role: "user", content: request, timestamp: 3 }, 2),
      messageEntry(assistant("Review started.", 4), 3),
      messageEntry(
        Object.assign(
          { role: "user" as const, content: "Worker update", timestamp: 5 },
          {
            provenance: { kind: "inter_session" },
          },
        ),
        4,
      ),
      messageEntry(assistant("Review continues.", 6), 5),
    ];
    expect(prepare(entries, "entry-2")).toMatchObject({
      requestSelection: { state: "unresolved", request },
      latestUnresolvedUserRequest: request,
    });
  });

  it("does not carry a prior checkpoint's pending ask into a new internal run", () => {
    const entries: SessionTreeEntry[] = [
      messageEntry(assistant("Prior retained work", 1), 0),
      {
        type: "compaction",
        id: "prior-compaction",
        parentId: "entry-0",
        timestamp: new Date(2).toISOString(),
        firstKeptEntryId: "entry-0",
        tokensBefore: 100,
        summary:
          'Generated recovery context.\n\n## Pending user asks\n- Old human ask\n\n## Decisions\nPrior work completed.\n\n## Latest unresolved user request\n"Old human ask"\n\n',
        details: { readFiles: [], modifiedFiles: [], latestUnresolvedUserRequest: "Old human ask" },
      },
      messageEntry(
        Object.assign(
          { role: "user" as const, content: "Independent cron task", timestamp: 3 },
          {
            provenance: { kind: "internal_system" },
          },
        ),
        2,
      ),
      messageEntry(assistant("Working on cron.", 4), 3),
    ];
    const preparation = prepare(entries);
    expect(preparation.requestSelection).toEqual({ state: "none" });
    expect(preparation.latestUnresolvedUserRequest).toBeUndefined();
    const fallback = compactWithoutSummary(preparation);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.value.summary).not.toContain("Old human ask");
      expect(fallback.value.summary).toContain("Generated recovery context.");
      expect(fallback.value.summary).toContain("## Pending user asks\nNone.");
      expect(fallback.value.summary).toContain("Prior work completed.");
    }
  });
});
