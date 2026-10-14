// Transcript file state tests cover tolerant JSONL reads, malformed entries,
// branch leaf recovery, and repair-supported legacy payload shapes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSessionEntries, SessionManager } from "../sessions/index.js";
import { textToolResult } from "../test-helpers/sparse-transcript.test-support.js";

const roots: string[] = [];

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

async function makeRoot(prefix: string): Promise<string> {
  // Each file-state case writes a full JSONL transcript under its own root so
  // orphan/leaf behavior stays isolated.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeTranscriptFixture(
  prefix: string,
  entryLines: string[],
  header: { version?: number; timestamp?: string } = {},
): Promise<string> {
  const root = await makeRoot(prefix);
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
      ...entryLines,
    ].join("\n") + "\n",
    "utf8",
  );
  return sessionFile;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("readTranscriptState", () => {
  it("normalizes appended session names to one line", async () => {
    const sessionFile = await writeTranscriptFixture("openclaw-transcript-state-name-", [], {
      timestamp: "2026-07-16T00:00:00.000Z",
    });
    const state = await readTranscriptState(sessionFile);

    const entry = state.getEntry(state.appendSessionInfo("  first\nsecond\r\nthird  "))!;

    expect(entry).toMatchObject({ name: "first second third" });
    expect(state.getEntries().at(-1)).toMatchObject({ name: "first second third" });
  });

  it("preserves repair-supported assistant tool call payload shapes", async () => {
    const sessionFile = await writeTranscriptFixture("openclaw-transcript-state-tool-input-", [
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-16T00:00:01.000Z",
        message: { role: "user", content: "read a file" },
      }),
      JSON.stringify({
        type: "message",
        id: "assistant-tool",
        parentId: "user-1",
        timestamp: "2026-05-16T00:00:02.000Z",
        message: {
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
        },
      }),
      JSON.stringify({
        type: "message",
        id: "tool-result",
        parentId: "assistant-tool",
        timestamp: "2026-05-16T00:00:03.000Z",
        message: textToolResult("call-input", "read", "contents", { isError: false }),
      }),
    ]);

    const state = await readTranscriptState(sessionFile);

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
      "openclaw-transcript-state-v1-opaque-parent-",
      [
        {
          type: "message",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "legacy active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "missing-before-migration",
        },
      ].map((entry) => JSON.stringify(entry)),
      { version: 1, timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const activeLeafId = state.getLeafId();
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });

    expect(state.migrated).toBe(true);
    expect(appended.parentId).toBe(activeLeafId);
    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([activeLeafId, appended.id]);
  });

  it("preserves legacy compaction keep indexes across JSON-valid non-object rows", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-v1-compaction-null-row-",
      [
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user", content: "legacy prelude" },
        }),
        "null",
        JSON.stringify({
          type: "message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "legacy kept suffix" },
        }),
        JSON.stringify({
          type: "compaction",
          timestamp: "2026-05-16T00:00:03.000Z",
          summary: "summary",
          firstKeptEntryIndex: 3,
          tokensBefore: 200,
        }),
      ],
      { version: 1 },
    );

    const state = await readTranscriptState(sessionFile);
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
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-compaction-branch-marker-",
      [
        JSON.stringify({
          type: "message",
          id: "bad-message",
          parentId: null,
          timestamp: "2026-05-16T00:00:01.000Z",
          message: { role: "user" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-a-user",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:02.000Z",
          message: { role: "user", content: "other branch" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-b-user",
          parentId: "bad-message",
          timestamp: "2026-05-16T00:00:03.000Z",
          message: { role: "user", content: "active branch kept turn" },
        }),
        JSON.stringify({
          type: "message",
          id: "branch-b-assistant",
          parentId: "branch-b-user",
          timestamp: "2026-05-16T00:00:04.000Z",
          message: { role: "assistant", content: [{ type: "text", text: "active reply" }] },
        }),
        JSON.stringify({
          type: "compaction",
          id: "compact-1",
          parentId: "branch-b-assistant",
          timestamp: "2026-05-16T00:00:05.000Z",
          summary: "summary",
          firstKeptEntryId: "bad-message",
          tokensBefore: 200,
        }),
      ],
    );

    const state = await readTranscriptState(sessionFile);
    const compaction = state.getEntries().find((entry) => entry.type === "compaction");

    expect(compaction).toMatchObject({ firstKeptEntryId: "branch-b-user" });
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "compactionSummary", summary: "summary" },
      { role: "user", content: "active branch kept turn" },
      { role: "assistant", content: [{ type: "text", text: "active reply" }] },
    ]);
  });

  it("breaks cycles between canonical and opaque rows", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-canonical-opaque-cycle-",
      [
        {
          type: "message",
          id: "active-entry",
          parentId: "opaque-cycle",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "kept through cycle" },
        },
        {
          type: "metadata",
          id: "opaque-cycle",
          parentId: "active-entry",
          payload: { source: "plugin" },
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getBranch().map((entry) => ({ id: entry.id, parentId: entry.parentId }))).toEqual([
      { id: "active-entry", parentId: null },
    ]);
    expect(state.buildSessionContext().messages).toMatchObject([
      { role: "user", content: "kept through cycle" },
    ]);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    expect(appended.parentId).toBe("active-entry");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-entry", appended.id]);
  });

  it("drops labels targeting rejected entries before transcript rewrite replay", async () => {
    const sessionFile = await writeTranscriptFixture("openclaw-transcript-state-rejected-label-", [
      JSON.stringify({
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-05-16T00:00:01.000Z",
        message: { role: "user", content: "before malformed row" },
      }),
      JSON.stringify({
        type: "message",
        id: "bad-message",
        parentId: "user-1",
        timestamp: "2026-05-16T00:00:02.000Z",
        message: { role: "user" },
      }),
      JSON.stringify({
        type: "message",
        id: "user-2",
        parentId: "bad-message",
        timestamp: "2026-05-16T00:00:03.000Z",
        message: { role: "user", content: "after malformed row" },
      }),
      JSON.stringify({
        type: "label",
        id: "label-1",
        parentId: "user-2",
        timestamp: "2026-05-16T00:00:04.000Z",
        targetId: "bad-message",
        label: "bad",
      }),
      JSON.stringify({
        type: "message",
        id: "user-3",
        parentId: "label-1",
        timestamp: "2026-05-16T00:00:05.000Z",
        message: { role: "user", content: "after poisoned label" },
      }),
    ]);

    const state = await readTranscriptState(sessionFile);

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
    const rootEntry = {
      type: "message",
      id: "root-user",
      parentId: null,
      timestamp: "2026-05-16T00:00:01.000Z",
      message: { role: "user", content: "root question" },
    };
    const abandonedEntry = {
      type: "message",
      id: "abandoned-assistant",
      parentId: rootEntry.id,
      timestamp: "2026-05-16T00:00:02.000Z",
      message: { role: "assistant", content: "abandoned answer" },
    };
    const leafEntry = {
      type: "leaf",
      id: "leaf-1",
      parentId: abandonedEntry.id,
      timestamp: "2026-05-16T00:00:03.000Z",
      targetId: rootEntry.id,
    };
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-leaf-",
      [rootEntry, abandonedEntry, leafEntry].map((entry) => JSON.stringify(entry)),
    );

    const selectedState = await readTranscriptState(sessionFile);
    expect(selectedState.getLeafId()).toBe(rootEntry.id);
    expect(selectedState.getBranch().map((entry) => entry.id)).toEqual([rootEntry.id]);

    const replacementEntry = {
      type: "message",
      id: "replacement-assistant",
      parentId: leafEntry.id,
      timestamp: "2026-05-16T00:00:04.000Z",
      message: { role: "assistant", content: "replacement answer" },
    };
    await fs.appendFile(sessionFile, `${JSON.stringify(replacementEntry)}\n`, "utf8");

    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getEntries().find((entry) => entry.id === replacementEntry.id)).toEqual(
      expect.objectContaining({ parentId: rootEntry.id }),
    );
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual([
      rootEntry.id,
      replacementEntry.id,
    ]);
  });

  it("keeps parentless canonical ancestry through rewrite replay", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-parentless-leaf-",
      [
        {
          type: "message",
          id: "user-1",
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "user", content: "question", timestamp: 1 },
        },
        {
          type: "message",
          id: "assistant-1",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "answer", timestamp: 2 },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "assistant-1",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "assistant-1",
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
  });

  it("preserves marked side ancestry without capturing the next active append", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-side-append-",
      [
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "message",
          id: "side-one",
          parentId: "active-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "first side delivery" },
        },
        {
          type: "leaf",
          id: "first-leaf",
          parentId: "side-one",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "side-one",
          appendMode: "side",
        },
        {
          type: "message",
          id: "side-two",
          parentId: "side-one",
          timestamp: "2026-06-15T00:00:04.000Z",
          appendMode: "side",
          message: { role: "assistant", content: "second side delivery" },
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);

    expect(state.getBranch("side-two").map((entry) => entry.id)).toEqual([
      "active-root",
      "side-one",
      "side-two",
    ]);
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root"]);
    expect(state.getLeafId()).toBe("active-root");
    expect(state.getAppendParentId()).toBe("side-two");
    expect(state.getAppendMode()).toBe("side");

    const nextUser = state.getEntry(
      state.appendMessage({ role: "user", content: "next question", timestamp: Date.now() }),
    )!;
    expect(state.getBranch(nextUser.id).map((entry) => entry.id)).toEqual([
      "active-root",
      nextUser.id,
    ]);
  });

  it("keeps a terminal leaf control's opaque append parent", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-opaque-append-parent-",
      [
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: null,
          payload: { source: "plugin" },
        },
        {
          type: "message",
          id: "side-delivery",
          parentId: "active-root",
          timestamp: "2026-06-15T00:00:02.000Z",
          message: { role: "assistant", content: "side delivery" },
        },
        {
          type: "leaf",
          id: "active-leaf",
          parentId: "side-delivery",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "plugin-metadata",
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });
    const persisted = (await fs.readFile(sessionFile, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(state.getLeafId()).toBe(appended.id);
    expect(appended.parentId).toBe("active-root");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
    expect(persisted.at(-1)).toMatchObject({ id: appended.id, parentId: "active-root" });
  });

  it("ignores leaf controls with dangling target or append references", async () => {
    const sessionFile = await writeTranscriptFixture(
      "openclaw-transcript-state-invalid-leaf-",
      [
        {
          type: "message",
          id: "active-root",
          parentId: null,
          timestamp: "2026-06-15T00:00:01.000Z",
          message: { role: "assistant", content: "active" },
        },
        {
          type: "metadata",
          id: "plugin-metadata",
          parentId: "active-root",
          payload: { source: "plugin" },
        },
        {
          type: "leaf",
          id: "missing-target",
          parentId: "plugin-metadata",
          timestamp: "2026-06-15T00:00:02.000Z",
          targetId: "missing",
        },
        {
          type: "leaf",
          id: "missing-append",
          parentId: "missing-target",
          timestamp: "2026-06-15T00:00:03.000Z",
          targetId: "active-root",
          appendParentId: "missing",
        },
      ].map((entry) => JSON.stringify(entry)),
      { timestamp: "2026-06-15T00:00:00.000Z" },
    );

    const state = await readTranscriptState(sessionFile);
    const appended = state.getEntry(
      state.appendMessage({ role: "user", content: "continued", timestamp: Date.now() }),
    )!;
    await persistTranscriptStateMutation({
      sessionFile,
      state,
      appendedEntries: [appended],
    });

    expect(appended.parentId).toBe("active-root");
    expect(state.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
    const reopened = await readTranscriptState(sessionFile);
    expect(reopened.getLeafId()).toBe(appended.id);
    expect(reopened.getBranch().map((entry) => entry.id)).toEqual(["active-root", appended.id]);
  });
});
