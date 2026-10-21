import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionEntries, SessionManager } from "../sessions/index.js";
import { textToolResult } from "../test-helpers/sparse-transcript.test-support.js";

const roots: string[] = [];
function appendUser(state: SessionManager, content = "continued") {
  return state.getEntry(state.appendMessage({ role: "user", content, timestamp: Date.now() }))!;
}
function branchIds(state: SessionManager, leaf?: string) {
  return state.getBranch(leaf).map((entry) => entry.id);
}

function controlEntry(
  type: string,
  id: string,
  parentId: string | null,
  fields: Record<string, unknown> = {},
) {
  return { type, id, parentId, ...fields };
}

function messageEntry(id: string, parentId: string | null, message: unknown) {
  return { type: "message", id, parentId, message };
}

async function readTranscriptState(sessionFile: string): Promise<SessionManager> {
  return SessionManager.fromEntries(parseSessionEntries(await fs.readFile(sessionFile, "utf8")));
}

async function persistTranscriptStateMutation(params: {
  sessionFile: string;
  state: SessionManager;
  appendedEntries: unknown[];
}): Promise<void> {
  const entries = params.state.migrated
    ? params.state.getPersistedEntries()
    : params.appendedEntries;
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  if (params.state.migrated) {
    await fs.writeFile(params.sessionFile, content, "utf8");
  } else {
    await fs.appendFile(params.sessionFile, content, "utf8");
  }
}

async function writeTranscriptFixture(
  entries: (string | Record<string, unknown>)[],
  header: { version?: number; timestamp?: string } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transcript-state-"));
  roots.push(root);
  const sessionFile = path.join(root, "session.jsonl");
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        version: header.version ?? 3,
        id: "session-1",
        timestamp: header.timestamp ?? "2026-05-16T00:00:00.000Z",
        cwd: root,
      }),
      ...entries.map((entry, index) =>
        typeof entry === "string"
          ? entry
          : JSON.stringify({
              ...(entry.type === "metadata"
                ? {}
                : {
                    timestamp: new Date(
                      Date.parse(header.timestamp ?? "2026-05-16T00:00:00.000Z") +
                        (index + 1) * 1_000,
                    ).toISOString(),
                  }),
              ...entry,
            }),
      ),
    ].join("\n") + "\n",
    "utf8",
  );
  return sessionFile;
}

async function readFixture(...args: Parameters<typeof writeTranscriptFixture>) {
  return readTranscriptState(await writeTranscriptFixture(...args));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readTranscriptState", () => {
  it("normalizes appended session names to one line", async () => {
    const state = await readFixture([], { timestamp: "2026-07-16T00:00:00.000Z" });

    const entry = state.getEntry(state.appendSessionInfo("  first\nsecond\r\nthird  "))!;

    expect(entry).toMatchObject({ name: "first second third" });
    expect(state.getEntries().at(-1)).toMatchObject({ name: "first second third" });
  });

  it("preserves repair-supported assistant tool call payload shapes", async () => {
    const state = await readFixture([
      messageEntry("user-1", null, { role: "user", content: "read a file" }),
      messageEntry("assistant-tool", "user-1", {
        role: "assistant",
        content: [
          { type: "toolUse", id: "call-input", name: "read", input: { path: "README.md" } },
          { type: "toolCall", id: "call-args", name: "write", arguments: { path: "out" } },
          { type: "toolUse", id: "call-no-args", name: "list" },
          {
            type: "function_call",
            call_id: "call-legacy",
            name: "search",
            arguments: '{"query":"docs"}',
          },
          { type: "toolCall", id: "call-null-args", name: "noop", arguments: null },
        ],
      }),
      messageEntry(
        "tool-result",
        "assistant-tool",
        textToolResult("call-input", "read", "contents", { isError: false }),
      ),
    ]);

    expect(state.getEntries().map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-tool",
      "tool-result",
    ]);
    expect(state.getLeafId()).toBe("tool-result");
    expect(state.buildSessionContext().messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("canonicalizes opaque append parents before a legacy migration rewrite", async () => {
    const sessionFile = await writeTranscriptFixture(
      [
        { type: "message", message: { role: "assistant", content: "legacy active" } },
        controlEntry("metadata", "plugin-metadata", "missing-before-migration"),
      ],
      { version: 1, timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const activeLeafId = state.getLeafId();
    const appended = appendUser(state);
    await persistTranscriptStateMutation({ sessionFile, state, appendedEntries: [appended] });

    expect(state.migrated).toBe(true);
    expect(appended.parentId).toBe(activeLeafId);
    const reopened = await readTranscriptState(sessionFile);
    expect(branchIds(reopened)).toEqual([activeLeafId, appended.id]);
  });

  it("preserves legacy compaction keep indexes across JSON-valid non-object rows", async () => {
    const state = await readFixture(
      [
        { type: "message", message: { role: "user", content: "legacy prelude" } },
        "null",
        { type: "message", message: { role: "user", content: "legacy kept suffix" } },
        { type: "compaction", summary: "summary", firstKeptEntryIndex: 3, tokensBefore: 200 },
      ],
      { version: 1 },
    );

    const kept = state
      .getEntries()
      .find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "user" &&
          entry.message.content === "legacy kept suffix",
      );
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(kept).toBeDefined();
    expect(compaction).toMatchObject({ firstKeptEntryId: kept?.id });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "legacy kept suffix" },
    ]);
  });

  it("remaps malformed compaction markers to descendants on the active branch", async () => {
    const state = await readFixture([
      messageEntry("bad-message", null, { role: "user" }),
      messageEntry("branch-a-user", "bad-message", { role: "user", content: "other branch" }),
      messageEntry("branch-b-user", "bad-message", {
        role: "user",
        content: "active branch kept turn",
      }),
      messageEntry("branch-b-assistant", "branch-b-user", {
        role: "assistant",
        content: [{ type: "text", text: "active reply" }],
      }),
      {
        type: "compaction",
        id: "compact-1",
        parentId: "branch-b-assistant",
        summary: "summary",
        firstKeptEntryId: "bad-message",
        tokensBefore: 200,
      },
    ]);

    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "branch-b-user" });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "active branch kept turn" },
      { role: "assistant", content: [{ type: "text", text: "active reply" }] },
    ]);
  });

  it("breaks cycles between canonical and opaque rows", async () => {
    const state = await readFixture(
      [
        messageEntry("active-entry", "opaque-cycle", {
          role: "user",
          content: "kept through cycle",
        }),
        controlEntry("metadata", "opaque-cycle", "active-entry", { payload: { source: "plugin" } }),
      ],
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    expect(state.getBranch().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
      { id: "active-entry", parentId: null },
    ]);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "kept through cycle" },
    ]);
    const appended = appendUser(state);
    expect(appended.parentId).toBe("active-entry");
    expect(branchIds(state)).toEqual(["active-entry", appended.id]);
  });

  it("drops labels targeting rejected entries before transcript rewrite replay", async () => {
    const state = await readFixture([
      messageEntry("user-1", null, { role: "user", content: "before malformed row" }),
      messageEntry("bad-message", "user-1", { role: "user" }),
      messageEntry("user-2", "bad-message", { role: "user", content: "after malformed row" }),
      {
        type: "label",
        id: "label-1",
        parentId: "user-2",
        targetId: "bad-message",
        label: "bad",
      },
      messageEntry("user-3", "label-1", { role: "user", content: "after poisoned label" }),
    ]);

    expect(state.getEntries().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual(
      [
        { id: "user-1", parentId: null },
        { id: "user-2", parentId: "user-1" },
        { id: "user-3", parentId: "user-2" },
      ],
    );
    expect(state.getLabel("bad-message")).toBeUndefined();
  });

  it("applies leaf controls to active state and marker-linked descendants", async () => {
    const rootEntry = messageEntry("root-user", null, { role: "user", content: "root question" });
    const abandonedEntry = messageEntry("abandoned-assistant", rootEntry.id, {
      role: "assistant",
      content: "abandoned answer",
    });
    const leafEntry = controlEntry("leaf", "leaf-1", abandonedEntry.id, { targetId: rootEntry.id });
    const sessionFile = await writeTranscriptFixture([rootEntry, abandonedEntry, leafEntry]);

    const selectedState = await readTranscriptState(sessionFile);
    expect(selectedState.getLeafId()).toBe(rootEntry.id);
    expect(branchIds(selectedState)).toEqual([rootEntry.id]);

    const replacementEntry = messageEntry("replacement-assistant", leafEntry.id, {
      role: "assistant",
      content: "replacement answer",
    });
    await fs.appendFile(
      sessionFile,
      `${JSON.stringify({ timestamp: "2026-05-16T00:00:04.000Z", ...replacementEntry })}\n`,
      "utf8",
    );

    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getEntries().find((entry) => entry.id === replacementEntry.id)).toEqual(
      expect.objectContaining({ parentId: rootEntry.id }),
    );
    expect(branchIds(reopened)).toEqual([rootEntry.id, replacementEntry.id]);
  });

  it("keeps parentless canonical ancestry through rewrite replay", async () => {
    const state = await readFixture(
      [
        {
          type: "message",
          id: "user-1",
          message: { role: "user", content: "question", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant-1",
          message: { role: "assistant", content: "answer", timestamp: 2 },
        },
        controlEntry("leaf", "active-leaf", "assistant-1", { targetId: "assistant-1" }),
      ],
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    expect(branchIds(state)).toEqual(["user-1", "assistant-1"]);
  });

  it("preserves marked side ancestry without capturing the next active append", async () => {
    const state = await readFixture(
      [
        messageEntry("active-root", null, { role: "assistant", content: "active" }),
        messageEntry("side-one", "active-root", {
          role: "assistant",
          content: "first side delivery",
        }),
        controlEntry("leaf", "first-leaf", "side-one", {
          targetId: "active-root",
          appendParentId: "side-one",
          appendMode: "side",
        }),
        {
          type: "message",
          id: "side-two",
          parentId: "side-one",
          appendMode: "side",
          message: { role: "assistant", content: "second side delivery" },
        },
      ],
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    expect(branchIds(state, "side-two")).toEqual(["active-root", "side-one", "side-two"]);
    expect(branchIds(state)).toEqual(["active-root"]);
    expect(state.getLeafId()).toBe("active-root");
    expect(state.getAppendParentId()).toBe("side-two");
    expect(state.getAppendMode()).toBe("side");

    const nextUser = appendUser(state, "next question");
    expect(branchIds(state, nextUser.id)).toEqual(["active-root", nextUser.id]);
  });

  it("keeps a terminal leaf control's opaque append parent", async () => {
    const sessionFile = await writeTranscriptFixture(
      [
        messageEntry("active-root", null, { role: "assistant", content: "active" }),
        controlEntry("metadata", "plugin-metadata", null, { payload: { source: "plugin" } }),
        messageEntry("side-delivery", "active-root", {
          role: "assistant",
          content: "side delivery",
        }),
        controlEntry("leaf", "active-leaf", "side-delivery", {
          targetId: "active-root",
          appendParentId: "plugin-metadata",
        }),
      ],
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const appended = appendUser(state);
    await persistTranscriptStateMutation({ sessionFile, state, appendedEntries: [appended] });
    const persisted = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state.getLeafId()).toBe(appended.id);
    expect(appended.parentId).toBe("active-root");
    expect(branchIds(state)).toEqual(["active-root", appended.id]);
    expect(persisted.at(-1)).toMatchObject({ id: appended.id, parentId: "active-root" });
  });

  it("ignores leaf controls with dangling target or append references", async () => {
    const sessionFile = await writeTranscriptFixture(
      [
        messageEntry("active-root", null, { role: "assistant", content: "active" }),
        controlEntry("metadata", "plugin-metadata", "active-root", {
          payload: { source: "plugin" },
        }),
        controlEntry("leaf", "missing-target", "plugin-metadata", { targetId: "missing" }),
        controlEntry("leaf", "missing-append", "missing-target", {
          targetId: "active-root",
          appendParentId: "missing",
        }),
      ],
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const appended = appendUser(state);
    await persistTranscriptStateMutation({ sessionFile, state, appendedEntries: [appended] });

    expect(appended.parentId).toBe("active-root");
    expect(branchIds(state)).toEqual(["active-root", appended.id]);
    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getLeafId()).toBe(appended.id);
    expect(branchIds(reopened)).toEqual(["active-root", appended.id]);
  });
});
