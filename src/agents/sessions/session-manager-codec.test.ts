import { fileURLToPath } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  buildSessionContext,
  cloneSessionModelContextEntries,
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-manager-codec.js";
import type { SessionEntry, SessionMessageEntry } from "./session-manager-types.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

const userMessage = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
function messageEntry(
  message: SessionMessageEntry["message"],
  id = "entry",
  parentId: string | null = null,
): SessionMessageEntry {
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message };
}
const sessionHeader = (id: string, version = CURRENT_SESSION_VERSION) => ({
  type: "session",
  version,
  id,
  cwd: "/tmp",
});

it("shares checkpoint prefixes and releases prepared transcript history", async ({ signal }) => {
  const result = await runNodeScript(
    [
      "--expose-gc",
      "--import",
      "./scripts/tsx.mjs",
      fileURLToPath(new URL("./system-prompt-pool.retention.test-support.ts", import.meta.url)),
    ],
    process.env,
    undefined,
    { cwd: fileURLToPath(new URL("../../../", import.meta.url)), signal },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

describe("session manager codec compatibility", () => {
  it("selects the new projection only for a genuinely new session", () => {
    expect(SessionManager.inMemory("/tmp").getHeader()?.version).toBe(4);
    for (const version of [1, 2, 3, 4, 99]) {
      const manager = SessionManager.fromEntries([sessionHeader("projection-version", version)]);
      expect(manager.getHeader()?.version).toBe(Math.max(3, version));
      expect(manager.migrated).toBe(version < 3);
    }
  });

  it("backfills current-version hook messages persisted without a custom type", () => {
    const manager = SessionManager.fromEntries([
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "persisted-hook-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
      },
      {
        type: "message",
        id: "persisted-hook-message",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "custom", content: "persisted hook context" },
      },
    ]);

    expect(manager.getEntry("persisted-hook-message")).toMatchObject({
      message: { role: "custom", customType: "hook", content: "persisted hook context" },
    });
  });

  it.each([
    {
      name: "message with malformed content",
      entry: { type: "message", id: "m1", parentId: null, message: { role: "user" } },
    },
    {
      name: "compaction without a kept entry",
      entry: { type: "compaction", id: "c1", parentId: null, summary: "", tokensBefore: 1 },
    },
    {
      name: "partial model change",
      entry: { type: "model_change", id: "model1", parentId: null, provider: "openai" },
    },
  ])("rejects an indexed $name", ({ entry }) => {
    expect(isIndexedSessionEntry(entry)).toBe(false);
  });

  it.each([
    { name: "singleton", reason: ["reset"] },
    { name: "nested singleton", reason: [["reset"]] },
  ])("preserves a $name legacy reset reason", ({ reason }) => {
    const manager = SessionManager.fromEntries([
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "legacy-reset-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
      },
      {
        type: "message",
        id: "before-reset",
        parentId: null,
        message: { role: "user", content: "before" },
      },
      { type: "reset", id: "legacy-reset", parentId: "before-reset", reason },
      {
        type: "message",
        id: "after-reset",
        parentId: "legacy-reset",
        message: { role: "user", content: "after" },
      },
    ]);

    expect(manager.getEntry("legacy-reset")).toBeDefined();
    const context = JSON.stringify(manager.buildSessionContext());
    expect(context).not.toContain("before");
    expect(context).toContain("after");
  });

  it.each([1, 2])("excludes malformed metadata after migrating version %i", (version) => {
    const before = { role: "user", content: "before malformed metadata" };
    const after = { role: "user", content: "valid descendant" };
    const manager = SessionManager.fromEntries([
      sessionHeader("legacy-metadata", version),
      { type: "message", id: "before", parentId: null, message: before },
      { type: "model_change", id: "invalid-model", parentId: "before", provider: "openai" },
      { type: "message", id: "after", parentId: "invalid-model", message: after },
      { type: "session_info", id: "invalid-name", parentId: "after", name: 42 },
    ]);

    expect(manager.getEntries().map((entry) => entry.type)).toEqual(["message", "message"]);
    expect(manager.getSessionName()).toBeUndefined();
    expect(manager.buildSessionContext()).toEqual({
      messages: [after],
      thinkingLevel: "off",
      model: null,
    });
  });

  it("parses opaque tree links without widening their variants", () => {
    expect(parseParentLinkedOpaqueEntry({ type: "future", id: "f1", parentId: null })).toEqual({
      id: "f1",
      parentId: null,
    });
    expect(parseParentLinkedOpaqueEntry({ id: "untyped", parentId: "f1" })).toEqual({
      id: "untyped",
      parentId: "f1",
    });
    expect(
      parseOpaqueLeafEntry({ type: "leaf", id: "leaf1", parentId: null, targetId: null }),
    ).toEqual({ id: "leaf1", parentId: null, targetId: null });
    expect(parseOpaqueLeafEntry({ type: "leaf", id: "leaf1", parentId: null })).toBeUndefined();
  });

  it("preserves the original parent fallback for an opaque compaction keep marker", () => {
    const manager = SessionManager.fromEntries([
      sessionHeader("self-parent-compaction"),
      { type: "future", id: "opaque-root", parentId: null },
      {
        type: "compaction",
        id: "compaction",
        parentId: "compaction",
        summary: "summary",
        firstKeptEntryId: "opaque-root",
        tokensBefore: 1,
      },
    ]);

    expect(manager.getEntry("compaction")).toMatchObject({
      parentId: null,
      firstKeptEntryId: "compaction",
    });
  });
});

class BoundedEntryMap extends Map<string, SessionEntry> {
  private readsRemaining = 100;

  override get(key: string): SessionEntry | undefined {
    // Fail a cyclic regression before an unbounded walk exhausts the test worker.
    if (this.readsRemaining-- === 0) {
      throw new Error("Session ancestry traversal exceeded its read budget");
    }
    return super.get(key);
  }
}

const parentTraversalCases: Array<
  [string, Record<string, string | null>, string | null, string[]]
> = [
  ["tail entering a cycle", { a: "b", b: "a", c: "a" }, "c", ["b", "a", "c"]],
  ["acyclic selected branch", { a: null, b: "a", other: null }, "b", ["a", "b"]],
  ["missing parent", { a: "missing" }, "a", ["a"]],
  ["explicit empty branch", { a: "a" }, null, []],
];

describe("model context projection isolation", () => {
  const toolResult = {
    role: "toolResult" as const,
    toolCallId: "call",
    toolName: "read",
    isError: false,
    content: [{ type: "text" as const, text: "visible" }],
    timestamp: 0,
  };
  const customMessage = {
    role: "custom" as const,
    customType: "synthetic",
    display: true,
    content: "visible",
    details: { retained: "kept" },
    timestamp: 0,
  };
  const missingDetails = { openclawSyntheticMissingToolResult: true };
  const missingResult = { ...toolResult, details: missingDetails };
  const cases: Array<[string, SessionMessageEntry["message"], unknown]> = [
    [
      "private user metadata",
      Object.assign(userMessage("visible"), {
        __openclaw: { upstreamUserText: "private", retained: { nested: "kept" } },
      }),
      {
        ...userMessage("visible"),
        __openclaw: { retained: { nested: "kept" } },
      },
    ],
    ["plain tool result", toolResult, toolResult],
    ["tool evidence", { ...toolResult, details: { evidence: "private" } }, toolResult],
    ["missing-result marker", missingResult, missingResult],
    [
      "marker with evidence",
      { ...toolResult, details: { ...missingDetails, evidence: "private" } },
      missingResult,
    ],
    [
      "false marker",
      { ...toolResult, details: { openclawSyntheticMissingToolResult: false } },
      toolResult,
    ],
    ["custom-message details", customMessage, customMessage],
  ];
  it.each(cases)(
    "preserves canonical payload and input bytes for %s",
    (_name, message, expected) => {
      const entry = messageEntry(message);
      const before = JSON.stringify(entry);
      Object.freeze(entry);
      Object.freeze(message);
      expect(cloneSessionModelContextEntries(null, [entry])).toEqual([
        { ...entry, message: expected },
      ]);
      expect(JSON.stringify(entry)).toBe(before);
    },
  );

  it("detaches surviving nested tool arguments in both directions", () => {
    const argumentsValue = { nested: { path: "original.txt" } };
    const metadata = { upstreamUserText: "private", retained: { nested: "kept" } };
    const message = Object.assign(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call", name: "read", arguments: argumentsValue }],
      }),
      { __openclaw: metadata },
    );
    const entry = messageEntry(message);
    const projected = cloneSessionModelContextEntries(null, [entry]);
    argumentsValue.nested.path = "caller-change.txt";
    metadata.retained.nested = "caller-change";
    expect(projected).toMatchObject([
      {
        message: {
          content: [{ arguments: { nested: { path: "original.txt" } } }],
          __openclaw: { retained: { nested: "kept" } },
        },
      },
    ]);
    const projectedEntry = projected[0];
    assert(
      projectedEntry?.type === "message" && projectedEntry.message.role === "assistant",
      "Missing assistant projection",
    );
    const call = projectedEntry.message.content.find((item) => item.type === "toolCall");
    const nested = asOptionalRecord(call?.arguments.nested);
    assert(nested, "Missing nested tool arguments");
    nested.path = "context-change.txt";
    const projectedMetadata = asOptionalRecord(Reflect.get(projectedEntry.message, "__openclaw"));
    const retained = asOptionalRecord(projectedMetadata?.retained);
    assert(retained, "Missing retained metadata");
    retained.nested = "context-change";
    expect(argumentsValue.nested.path).toBe("caller-change.txt");
    expect(metadata.retained.nested).toBe("caller-change");
  });
});

describe("session context parent traversal", () => {
  it.each(parentTraversalCases)(
    "returns each selected entry once for %s",
    (_name, parents, leaf, expected) => {
      const entries = Object.entries(parents).map(([id, parentId]) =>
        messageEntry(userMessage(id), id, parentId),
      );
      const before = structuredClone(entries);
      const byId = new BoundedEntryMap(entries.map((entry) => [entry.id, entry]));

      expect(buildSessionContext(entries, leaf, byId).messages).toEqual(expected.map(userMessage));
      expect(entries).toEqual(before);
    },
  );
});
