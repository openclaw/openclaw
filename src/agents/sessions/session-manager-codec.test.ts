import { fileURLToPath } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
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
      const manager = SessionManager.fromEntries([
        { type: "session", version, id: "projection-version", cwd: "/tmp" },
      ]);
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
    const manager = SessionManager.fromEntries([
      { type: "session", version, id: "legacy-metadata", cwd: "/tmp" },
      {
        type: "message",
        id: "before",
        parentId: null,
        message: { role: "user", content: "before malformed metadata" },
      },
      { type: "model_change", id: "invalid-model", parentId: "before", provider: "openai" },
      {
        type: "message",
        id: "after",
        parentId: "invalid-model",
        message: { role: "user", content: "valid descendant" },
      },
      { type: "session_info", id: "invalid-name", parentId: "after", name: 42 },
    ]);

    expect(manager.getEntries().map((entry) => entry.type)).toEqual(["message", "message"]);
    expect(manager.getSessionName()).toBeUndefined();
    expect(manager.buildSessionContext()).toEqual({
      messages: [{ role: "user", content: "valid descendant" }],
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
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "self-parent-compaction",
        cwd: "/tmp",
      },
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

const parentTraversalCases: Array<{
  name: string;
  parents: Array<[string, string | null]>;
  leaf: string | null;
  expected: string[];
}> = [
  {
    name: "tail entering a cycle",
    parents: [
      ["a", "b"],
      ["b", "a"],
      ["c", "a"],
    ],
    leaf: "c",
    expected: ["b", "a", "c"],
  },
  {
    name: "acyclic selected branch",
    parents: [
      ["a", null],
      ["b", "a"],
      ["other", null],
    ],
    leaf: "b",
    expected: ["a", "b"],
  },
  { name: "missing parent", parents: [["a", "missing"]], leaf: "a", expected: ["a"] },
  { name: "explicit empty branch", parents: [["a", "a"]], leaf: null, expected: [] },
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
  const cases: Array<{ name: string; message: SessionMessageEntry["message"]; expected: unknown }> =
    [
      {
        name: "private user metadata",
        message: Object.assign(
          { role: "user" as const, content: "visible", timestamp: 0 },
          { __openclaw: { upstreamUserText: "private", retained: { nested: "kept" } } },
        ),
        expected: {
          role: "user",
          content: "visible",
          timestamp: 0,
          __openclaw: { retained: { nested: "kept" } },
        },
      },
      { name: "plain tool result", message: toolResult, expected: toolResult },
      {
        name: "tool evidence",
        message: { ...toolResult, details: { evidence: "private" } },
        expected: toolResult,
      },
      {
        name: "missing-result marker",
        message: { ...toolResult, details: { openclawSyntheticMissingToolResult: true } },
        expected: { ...toolResult, details: { openclawSyntheticMissingToolResult: true } },
      },
      {
        name: "marker with evidence",
        message: {
          ...toolResult,
          details: { openclawSyntheticMissingToolResult: true, evidence: "private" },
        },
        expected: { ...toolResult, details: { openclawSyntheticMissingToolResult: true } },
      },
      {
        name: "false marker",
        message: { ...toolResult, details: { openclawSyntheticMissingToolResult: false } },
        expected: toolResult,
      },
      {
        name: "custom-message details",
        message: {
          role: "custom",
          customType: "synthetic",
          display: true,
          content: "visible",
          details: { retained: "kept" },
          timestamp: 0,
        },
        expected: {
          role: "custom",
          customType: "synthetic",
          display: true,
          content: "visible",
          details: { retained: "kept" },
          timestamp: 0,
        },
      },
    ];
  it.each(cases)(
    "preserves canonical payload and input bytes for $name",
    ({ message, expected }) => {
      const entry: SessionMessageEntry = {
        type: "message",
        id: "entry",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message,
      };
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
    const entry: SessionMessageEntry = {
      type: "message",
      id: "entry",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      message,
    };
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
    if (projectedEntry?.type !== "message" || projectedEntry.message.role !== "assistant") {
      throw new Error("Missing assistant projection");
    }
    const call = projectedEntry.message.content.find((item) => item.type === "toolCall");
    const nested = asOptionalRecord(call?.arguments.nested);
    if (!nested) {
      throw new Error("Missing nested tool arguments");
    }
    nested.path = "context-change.txt";
    const projectedMetadata = asOptionalRecord(Reflect.get(projectedEntry.message, "__openclaw"));
    const retained = asOptionalRecord(projectedMetadata?.retained);
    if (!retained) {
      throw new Error("Missing retained metadata");
    }
    retained.nested = "context-change";
    expect(argumentsValue.nested.path).toBe("caller-change.txt");
    expect(metadata.retained.nested).toBe("caller-change");
  });
});

describe("session context parent traversal", () => {
  it.each(parentTraversalCases)(
    "returns each selected entry once for $name",
    ({ parents, leaf, expected }) => {
      const entries: SessionEntry[] = parents.map(([id, parentId]) => ({
        type: "message",
        id,
        parentId,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: id, timestamp: 0 },
      }));
      const before = structuredClone(entries);
      const byId = new BoundedEntryMap(entries.map((entry) => [entry.id, entry]));

      expect(buildSessionContext(entries, leaf, byId).messages).toEqual(
        expected.map((content) => ({ role: "user", content, timestamp: 0 })),
      );
      expect(entries).toEqual(before);
    },
  );
});
