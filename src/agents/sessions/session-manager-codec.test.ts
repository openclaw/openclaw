import { fileURLToPath } from "node:url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, describe, expect, it, vi } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { partitionSessionFileEntries } from "../../config/sessions/session-entry-codec.js";
import { freezeTranscriptSnapshot } from "../../config/sessions/transcript-snapshot.js";
import { freezeJsonSnapshot, freezeTrustedJsonSnapshot } from "../../shared/immutable-data.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  buildSessionContext,
  projectSessionModelContextEntries,
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
  prepareSessionManagerEntries,
  reuseResidentSessionEntryStrings,
  ownSessionTranscriptEntries,
} from "./session-manager-codec.js";
import { SessionManagerCore } from "./session-manager-core.js";
import { sessionManagerReadInitialContext } from "./session-manager-current-turn.js";
import type { SessionEntry, SessionMessageEntry } from "./session-manager-types.js";
import { sessionManagerReadTranscriptBranch } from "./session-manager-view-types.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";
import { toolResult as makeToolResult } from "./session-message-fixtures.test-support.js";

const userMessage = (content: string) => ({ role: "user" as const, content, timestamp: 0 });
type Message = SessionMessageEntry["message"];
function messageEntry(message: Message, id = "entry", parentId: string | null = null) {
  return { type: "message" as const, id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message };
}
function sessionHeader(id: string, version = CURRENT_SESSION_VERSION) {
  return { type: "session", version, id, cwd: "/tmp" };
}

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
  it.each([true, false])(
    "probes a frozen history root once, not once per entry (owner-sealed=%s)",
    (owned) => {
      const events = [
        sessionHeader("frozen-root"),
        ...Array.from({ length: 64 }, (_, index) =>
          messageEntry(
            userMessage(`turn ${index}`),
            `entry-${index}`,
            index === 0 ? null : `entry-${index - 1}`,
          ),
        ),
        { type: "foreign-row", payload: { kept: true } },
      ];
      const snapshot = {
        events,
        version: { generation: "frozen-root", rawSeq: events.length, updatedAt: 1 },
      };
      if (owned) {
        freezeTranscriptSnapshot(snapshot);
      } else {
        Object.freeze(snapshot.events);
      }
      const probe = vi.spyOn(Object, "isFrozen");
      try {
        const prepared = prepareSessionManagerEntries(snapshot.events);
        expect(prepared.fileEntries).toHaveLength(65);
        // Bun's JavaScriptCore scans every index per call: a per-entry probe of a
        // 36K-event root blocked the Gateway's main thread for about five minutes.
        expect(probe.mock.calls.filter(([value]) => value === snapshot.events)).toHaveLength(1);
      } finally {
        probe.mockRestore();
      }
    },
  );

  it.each([true, false])("loads history after freezer memo rotation (owner-sealed=%s)", (owned) => {
    const details = { evidence: [{ path: "synthetic.ts", lines: [1, 2] }] };
    const entry = messageEntry({
      ...makeToolResult("retained"),
      details,
    });
    const snapshot = {
      events: [sessionHeader("owned-history"), entry],
      version: { generation: "owned", rawSeq: 1, updatedAt: 1 },
    };
    if (owned) {
      freezeTranscriptSnapshot(snapshot);
    } else {
      Object.freeze(snapshot.events);
    }
    const before = JSON.stringify(snapshot);
    // Other sessions rotate the generic memo; the transcript owner's proof must survive.
    freezeTrustedJsonSnapshot(Array.from({ length: 262_145 }, () => ({})));
    const inspect = vi.spyOn(Reflect, "ownKeys");
    let first: SessionManagerCore;
    let second: SessionManagerCore;
    let context: SessionEntry[];
    try {
      first = new SessionManagerCore("/tmp", undefined, snapshot.events);
      second = new SessionManagerCore("/tmp", undefined, snapshot.events);
      context = projectSessionModelContextEntries(first[sessionManagerReadTranscriptBranch]());
      const inspections = inspect.mock.calls.filter(
        ([value]) => details === value || snapshot.events.some((event) => event === value),
      );
      expect(inspections.length === 0).toBe(owned);
    } finally {
      inspect.mockRestore();
    }
    const writable = first.getEntry("entry");
    assert(writable?.type === "message" && writable.message.role === "toolResult");
    writable.message.content.push({ type: "text", text: "caller mutation" });
    writable.parentId = "caller-parent";
    expect(second.getEntry("entry")).toEqual(entry);
    expect(JSON.stringify(snapshot)).toBe(before);
    expect(context).toEqual([messageEntry(makeToolResult("retained"))]);
    const projected = context[0];
    assert(projected?.type === "message" && projected.message.role === "toolResult");
    const content = projected.message.content;
    expect(() => content.push({ type: "text", text: "shared edit" })).toThrow(TypeError);
  });

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
      sessionHeader("persisted-hook-session"),
      {
        ...messageEntry(userMessage(""), "persisted-hook-message"),
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
      sessionHeader("legacy-reset-session"),
      messageEntry(userMessage("before"), "before-reset"),
      { type: "reset", id: "legacy-reset", parentId: "before-reset", reason },
      messageEntry(userMessage("after"), "after-reset", "legacy-reset"),
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

  it("keeps malformed and foreign rows opaque without changing their positions or payloads", () => {
    const header = sessionHeader("partition");
    const recognized = [
      messageEntry(userMessage("valid")),
      {
        type: "compaction",
        id: "c",
        summary: "",
        firstKeptEntryId: "entry",
        tokensBefore: Number.NaN,
      },
      { type: "custom", id: "plugin", customType: "plugin-state", data: { retained: true } },
      { type: "custom_message", id: "cm", customType: "plugin", content: [], display: false },
      { type: "label", id: "label", targetId: "entry", label: "" },
      { type: "session_info", id: "info" },
    ];
    const sparseContent: unknown[] = [];
    sparseContent.length = 1;
    const opaque = [
      { type: "future-plugin", id: "future", parentId: null, payload: [1, 2] },
      { ...recognized[0], id: "" },
      { ...recognized[0], parentId: 1 },
      { ...recognized[0], timestamp: null },
      { ...recognized[0], message: { role: "user", content: [null] } },
      { ...recognized[0], message: { role: "user", content: sparseContent } },
      {
        ...recognized[0],
        message: { role: "toolResult", content: [], toolCallId: "t", toolName: "read" },
      },
      { type: "model_change", id: "model", provider: "openai", modelId: "" },
      { type: "custom_message", id: "custom", customType: "plugin", content: [], display: 1 },
      { type: "session_info", id: "info", name: null },
      { type: "reset", id: "reset", reason: "unknown" },
      null,
    ];
    const entries = [header, ...recognized, ...opaque];
    const partitioned = partitionSessionFileEntries(entries);
    expect(partitioned.fileEntries).toEqual([header, ...recognized]);
    expect(partitioned.fileEntriesByOriginalIndex).toEqual([header, ...recognized]);
    expect(partitioned.opaqueEntries).toEqual(opaque.map((record) => ({ index: 7, record })));
    for (const [index, preserved] of partitioned.opaqueEntries.entries()) {
      expect(preserved.record).toBe(opaque[index]);
    }
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
  it.each(["equal", "changed", "reordered", "mutable"])(
    "preserves reload bytes and writable isolation with %s resident payloads",
    (kind) => {
      const incoming = messageEntry(makeToolResult("original"));
      const resident = structuredClone(incoming);
      assert(resident.message.role === "toolResult");
      if (kind === "changed") {
        resident.message.content = [{ type: "text", text: "older" }];
      } else if (kind === "reordered") {
        const { content, ...rest } = resident.message;
        resident.message = { content, ...rest };
      }
      const version = { generation: "reload", rawSeq: 1, updatedAt: 1 };
      freezeTranscriptSnapshot({ events: [incoming], version });
      if (kind !== "mutable") {
        freezeTranscriptSnapshot({ events: [resident], version });
      }
      const bytes = JSON.stringify(incoming);
      const prepared = prepareSessionManagerEntries([sessionHeader("reload"), incoming]);
      reuseResidentSessionEntryStrings(prepared.fileEntries, new Map([[resident.id, resident]]));
      const adopted = prepared.fileEntries[1];
      assert(adopted?.type === "message");
      expect(JSON.stringify(adopted)).toBe(bytes);
      expect(adopted.message === resident.message).toBe(kind === "equal");
      const context = projectSessionModelContextEntries([adopted]);
      const contextBytes = JSON.stringify(context);
      const residentBytes = JSON.stringify(resident);
      ownSessionTranscriptEntries([adopted], prepared.pendingWritableTranscriptEntries);
      assert(adopted.message.role === "toolResult");
      adopted.message.content.push({ type: "text", text: "SDK edit after publication" });
      expect(JSON.stringify(incoming)).toBe(bytes);
      expect(JSON.stringify(resident)).toBe(residentBytes);
      expect(JSON.stringify(context)).toBe(contextBytes);
      if (kind === "mutable") {
        assert(resident.message.role === "toolResult");
        resident.message.content.push({ type: "text", text: "old SDK reference edit" });
        expect(adopted.message.content).toEqual([
          { type: "text", text: "original" },
          { type: "text", text: "SDK edit after publication" },
        ]);
      }
    },
  );

  it("isolates SDK edits from published context, including opaque values and symbols", async () => {
    const manager = SessionManager.fromEntries([
      sessionHeader("sdk-context"),
      messageEntry(
        makeAgentAssistantMessage({
          content: [
            {
              type: "toolCall",
              id: "call",
              name: "read",
              arguments: { nested: { path: "original" } },
            },
          ],
        }),
      ),
    ]);
    const entry = manager.getEntry("entry");
    assert(entry?.type === "message" && entry.message.role === "assistant");
    const call = entry.message.content[0];
    assert(call?.type === "toolCall");
    const marker = Symbol("sdk-data");
    for (const value of [
      { nested: { path: "original" } },
      { map: new Map([["key", { path: "original" }]]), set: new Set(["original"]) },
      { bytes: new Uint8Array([1, 2]) },
      { [marker]: { path: "original" } },
    ]) {
      call.arguments = value;
      const context = await manager[sessionManagerReadInitialContext]();
      const projectedMessage = context.messages[0];
      assert(projectedMessage?.role === "assistant");
      const projectedCall = projectedMessage.content[0];
      assert(projectedCall?.type === "toolCall");
      expect(projectedCall.arguments).toEqual(value);
      expect(projectedCall.arguments).not.toBe(value);
      expect(Reflect.set(projectedCall.arguments, "edited", true)).toBe(false);
      if (value.nested) {
        value.nested.path = "sdk edit";
        expect(projectedCall.arguments.nested).toEqual({ path: "original" });
      } else if (value.map) {
        const map = projectedCall.arguments.map;
        assert(map instanceof Map);
        map.set("key", "context edit");
        expect(value.map.get("key")).toEqual({ path: "original" });
      } else if (value.bytes) {
        const bytes = projectedCall.arguments.bytes;
        assert(bytes instanceof Uint8Array);
        bytes[0] = 9;
        expect(value.bytes[0]).toBe(1);
      } else {
        const symbolValue = Reflect.get(projectedCall.arguments, marker);
        expect(Reflect.set(symbolValue, "path", "context edit")).toBe(false);
        expect(value[marker]).toEqual({ path: "original" });
      }
    }
  });
  const toolResult = makeToolResult("visible");
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
  const cases: Array<[string, Message, unknown]> = [
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
      freezeJsonSnapshot(entry);
      const projected = projectSessionModelContextEntries([entry]);
      expect(projected).toEqual([{ ...entry, message: expected }]);
      const projectedEntry = projected[0];
      assert(projectedEntry?.type === "message");
      expect(Reflect.set(projectedEntry, "timestamp", "changed")).toBe(false);
      expect(Reflect.set(projectedEntry.message, "content", [])).toBe(false);
      expect(JSON.stringify(entry)).toBe(before);
    },
  );

  it("isolates mutable inputs and freezes projected nested tool arguments", () => {
    const argumentsValue = { nested: { path: "original.txt" } };
    const metadata = { upstreamUserText: "private", retained: { nested: "kept" } };
    const message = Object.assign(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "call", name: "read", arguments: argumentsValue }],
      }),
      { __openclaw: metadata },
    );
    const entry = messageEntry(message);
    const projected = projectSessionModelContextEntries([entry]);
    expect(metadata.upstreamUserText).toBe("private");
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
    expect(() => {
      nested.path = "context-change.txt";
    }).toThrow(TypeError);
    const projectedMetadata = asOptionalRecord(Reflect.get(projectedEntry.message, "__openclaw"));
    expect(projectedMetadata).not.toHaveProperty("upstreamUserText");
    const retained = asOptionalRecord(projectedMetadata?.retained);
    assert(retained, "Missing retained metadata");
    expect(() => {
      retained.nested = "context-change";
    }).toThrow(TypeError);
    expect(argumentsValue.nested.path).toBe("caller-change.txt");
    expect(metadata.retained.nested).toBe("caller-change");
  });

  it("shares frozen nested arguments in the projected view", () => {
    const message = makeAgentAssistantMessage({
      content: [
        { type: "toolCall", id: "call", name: "read", arguments: { path: "original.txt" } },
      ],
    });
    freezeJsonSnapshot(message.content);
    const projected = projectSessionModelContextEntries([messageEntry(message)])[0];
    assert(projected?.type === "message" && projected.message.role === "assistant");
    const call = projected.message.content[0];
    assert(call?.type === "toolCall");
    expect(projected.message.content).toBe(message.content);
    expect(Reflect.set(call.arguments, "path", "changed.txt")).toBe(false);
    expect(Reflect.set(projected.message.content, "length", 0)).toBe(false);
    expect(message.content).toMatchObject([{ arguments: { path: "original.txt" } }]);
  });
});

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
