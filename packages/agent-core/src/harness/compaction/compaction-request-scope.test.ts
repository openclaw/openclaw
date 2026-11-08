import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { compactWithoutSummary, prepareCompaction } from "./compaction.js";
import {
  createContextUsage,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";
import { assistant as assistantMessage, user } from "./shard-fixtures.test-support.js";
import { compactionEntry } from "./summary-capture.test-support.js";

const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 };
const assistant = (text: string, timestamp: number): AgentMessage =>
  assistantMessage(text, { model: "summary-model", usage: createContextUsage(1), timestamp });

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
      compactionEntry(
        1,
        `## Latest unresolved user request\n${JSON.stringify(request)}\n\nPrior work continues.`,
        "entry-0",
        {
          id: "prior-compaction",
          tokensBefore: 100,
          details: { readFiles: [], modifiedFiles: [], latestUnresolvedUserRequest: request },
        },
      ),
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
  it("attributes a split internal run without reviving completed human work", () => {
    const source = "Inspect the worker artifact; do not publish it.";
    const entries = [
      messageEntry(user("Completed human task", 1), 0),
      messageEntry(assistant("Completed.", 2), 1),
      messageEntry(Object.assign(user(source, 3), { provenance: { kind: "inter_session" } }), 2),
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
      messageEntry(user("Completed earlier task", 1), 0),
      messageEntry(assistant("Completed.", 2), 1),
      messageEntry(user(request, 3), 2),
      messageEntry(assistant("Review started.", 4), 3),
      messageEntry(
        Object.assign(user("Worker update", 5), {
          provenance: { kind: "inter_session" },
        }),
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
      compactionEntry(
        1,
        'Generated recovery context.\n\n## Pending user asks\n- Old human ask\n\n## Decisions\nPrior work completed.\n\n## Latest unresolved user request\n"Old human ask"\n\n',
        "entry-0",
        {
          id: "prior-compaction",
          tokensBefore: 100,
          details: {
            readFiles: [],
            modifiedFiles: [],
            latestUnresolvedUserRequest: "Old human ask",
          },
        },
      ),
      messageEntry(
        Object.assign(user("Independent cron task", 3), {
          provenance: { kind: "internal_system" },
        }),
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
