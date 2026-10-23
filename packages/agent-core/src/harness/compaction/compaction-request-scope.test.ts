import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { compactWithoutSummary, prepareCompaction } from "./compaction.js";
import {
  createContextUsage,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";

const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 };
const internalSources = [
  { label: "Inter-session input", metadata: { provenance: { kind: "inter_session" } } },
  { label: "Internal system input", metadata: { provenance: { kind: "internal_system" } } },
  { label: "Synthetic input", metadata: { synthetic: true as const } },
  { label: "Operator input", metadata: { operatorMessage: { turnScoped: true } } },
];

function assistant(text: string, timestamp: number): AgentMessage {
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
    pendingEntryId ? { requestFromEntryId: pendingEntryId } : undefined,
  );
  if (!result.ok || !result.value) {
    throw new Error("expected compactable history");
  }
  return result.value;
}

describe("manual compaction requests", () => {
  it("leaves request state unspecified for legacy callers", () => {
    const entries = [
      messageEntry({ role: "user", content: "Summarize this history", timestamp: 1 }, 0),
      messageEntry(assistant("Working on it.", 2), 1),
    ];
    const result = prepareCompaction(entries, settings);
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value) {
      throw new Error("expected compactable history");
    }
    expect(result.value.requestState).toBeUndefined();
  });
});

describe("run-owned compaction requests", () => {
  it.each(internalSources)(
    "retains the $label source when its split turn falls back without a summary",
    ({ label, metadata }) => {
      const source = "Inspect the worker artifact; do not publish it.";
      const input = Object.assign(
        { role: "user" as const, content: source, timestamp: 3 },
        metadata,
      );
      const entries = [
        messageEntry({ role: "user", content: "An earlier human task", timestamp: 1 }, 0),
        messageEntry(assistant("That task is complete.", 2), 1),
        messageEntry(input, 2),
        messageEntry(assistant("The internal task is still running.", 4), 3),
      ];
      const preparation = prepare(entries);
      expect(preparation.requestState).toBe("unresolved");
      expect(preparation.isSplitTurn).toBe(true);
      const result = compactWithoutSummary(preparation);
      if (!result.ok) {
        throw result.error;
      }
      expect(result.value.summary).toContain(`[${label}]: ${source}`);
      expect(result.value.firstKeptEntryId).toBe("entry-3");
    },
  );

  it.each(internalSources)(
    "does not revive completed human work for an independent $label run",
    ({ metadata }) => {
      const input = Object.assign(
        { role: "user" as const, content: "An independent internal task", timestamp: 3 },
        metadata,
      );
      const entries = [
        messageEntry({ role: "user", content: "Completed human task", timestamp: 1 }, 0),
        messageEntry(assistant("Completed.", 2), 1),
        messageEntry(input, 2),
        messageEntry(assistant("Working on the internal task.", 4), 3),
      ];
      expect(prepare(entries).latestUnresolvedUserRequest).toBeUndefined();
    },
  );

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
    expect(prepare(entries, "entry-2").latestUnresolvedUserRequest).toBe(request);
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
        summary: '## Latest unresolved user request\n"Old human ask"\n\nPrior work completed.',
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
    expect(preparation.latestUnresolvedUserRequest).toBeUndefined();
    const fallback = compactWithoutSummary(preparation);
    expect(fallback.ok).toBe(true);
    if (fallback.ok) {
      expect(fallback.value.summary).not.toContain("Old human ask");
      expect(fallback.value.summary).toContain("Prior work completed.");
    }
  });
});
