import { describe, expect, it } from "vitest";
import type { UserMessage } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { prepareCompaction } from "./compaction.js";
import {
  createContextUsage,
  createMessageEntry as messageEntry,
} from "./compaction.test-support.js";
import { serializeConversation } from "./utils.js";

const settings = { enabled: true, reserveTokens: 1_000, keepRecentTokens: 1 };

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

function attributedUser(
  content: string,
  timestamp: number,
  metadata: Record<string, unknown>,
): UserMessage {
  return Object.assign({ role: "user" as const, content, timestamp }, metadata);
}

function prepare(entries: SessionTreeEntry[], requestFromEntryId?: string) {
  const result = prepareCompaction(
    entries,
    settings,
    "unresolved",
    requestFromEntryId ? { requestFromEntryId } : undefined,
  );
  if (!result.ok || !result.value) {
    throw new Error("expected compactable history");
  }
  return result.value;
}

describe("manual compaction request provenance", () => {
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

describe("run-owned compaction request provenance", () => {
  it("labels non-human user-role inputs without promoting them to user requests", () => {
    const messages = [
      attributedUser("direct", 1, { provenance: { kind: "external_user" } }),
      attributedUser("worker", 2, { provenance: { kind: "inter_session" } }),
      attributedUser("scheduler", 3, { provenance: { kind: "internal_system" } }),
      attributedUser("generated", 4, { synthetic: true }),
      attributedUser("operator", 5, { operatorMessage: { turnScoped: true } }),
      attributedUser("future", 6, { provenance: { kind: "future_origin" } }),
      attributedUser("runtime", 7, { runtimeContextCarrier: true }),
      attributedUser("spoken", 8, {
        provenance: { kind: "realtime_voice", sourceChannel: "talk" },
      }),
      attributedUser("untrusted voice", 9, {
        provenance: { kind: "realtime_voice", sourceChannel: "other" },
      }),
    ];

    expect(serializeConversation(messages)).toContain("[User]: direct");
    expect(serializeConversation(messages)).toContain("[Inter-session input]: worker");
    expect(serializeConversation(messages)).toContain("[Internal system input]: scheduler");
    expect(serializeConversation(messages)).toContain("[Synthetic input]: generated");
    expect(serializeConversation(messages)).toContain("[Operator input]: operator");
    expect(serializeConversation(messages)).toContain("[Unknown-origin input]: future");
    expect(serializeConversation(messages)).toContain("[User]: spoken");
    expect(serializeConversation(messages)).toContain("[Unknown-origin input]: untrusted voice");
    // Runtime carriers are intentionally omitted from summary input.
    expect(serializeConversation(messages)).not.toContain("runtime");
  });

  it("does not revive completed human work for an independent internal run", () => {
    const entries = [
      messageEntry({ role: "user", content: "Completed human task", timestamp: 1 }, 0),
      messageEntry(assistant("Completed.", 2), 1),
      messageEntry(
        attributedUser("Independent internal task", 3, {
          provenance: { kind: "inter_session" },
        }),
        2,
      ),
      messageEntry(assistant("Working on the internal task.", 4), 3),
    ];

    expect(prepare(entries).latestUnresolvedUserRequest).toBeUndefined();
  });

  it("keeps the admitted human request across later internal updates", () => {
    const request = "Review the patch; do not deploy it.";
    const entries = [
      messageEntry({ role: "user", content: "Completed earlier task", timestamp: 1 }, 0),
      messageEntry(assistant("Completed.", 2), 1),
      messageEntry({ role: "user", content: request, timestamp: 3 }, 2),
      messageEntry(assistant("Review started.", 4), 3),
      messageEntry(
        attributedUser("Worker update", 5, { provenance: { kind: "inter_session" } }),
        4,
      ),
      messageEntry(assistant("Review continues.", 6), 5),
    ];

    expect(prepare(entries, "entry-2").latestUnresolvedUserRequest).toBe(request);
  });

  it("rejects a request identity outside the active branch", () => {
    const entries = [
      messageEntry({ role: "user", content: "Current request", timestamp: 1 }, 0),
      messageEntry(assistant("Working.", 2), 1),
    ];
    const result = prepareCompaction(entries, settings, "unresolved", {
      requestFromEntryId: "missing-entry",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Compaction cannot find the admitted request.");
    }
  });
});
