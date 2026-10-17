import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import type { CodexCatalogIndexOptions } from "./session-catalog-index-contract.js";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import { CodexCatalogPersistence } from "./session-catalog-index-state.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  catalogRow,
  completeCatalogState as completeState,
  memoryCatalogState as memoryState,
} from "./session-catalog-index.test-support.js";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const indexes: CodexCatalogIndex[] = [];
function catalog(options: Omit<CodexCatalogIndexOptions, "assertCurrent">) {
  const index = new CodexCatalogIndex({ ...options, assertCurrent: () => {} });
  indexes.push(index);
  return index;
}
afterEach(async () => {
  for (const index of indexes.splice(0)) {
    await index.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function storedRow(threadId: string, recencyAt: number, archived = false): CodexCatalogIndexRow {
  return catalogRow(threadId, recencyAt, {}, { archived });
}
const readSnapshot = (rows: CodexCatalogIndexRow[]) =>
  new CodexCatalogPersistence(completeState(rows), () => {}).readSnapshot();

describe("resident Codex catalog restore bounds", () => {
  it("persists newly reached overflow when an incremental walk stops at its known prefix", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const { values, state } = memoryState();
    const native = Array.from({ length: 19_999 }, (_, i) => storedRow(`stored-${i}`, 20_000 - i));
    const readNative = vi.fn(async (params: CodexThreadListParams) => {
      const offset = Number(params.cursor ?? 0);
      return {
        rows: native.slice(offset, offset + 64),
        nextCursor: offset + 64 < native.length ? String(offset + 64) : undefined,
      };
    });
    const index = catalog({ homeId: "incremental-overflow", state, readNative });
    await index.initialize();
    expect(values.get("complete")).toEqual({ version: 1, kind: "complete" });
    for (const id of ["new-one", "new-two"]) {
      await index.upsertThread({
        id,
        projectId: null,
        source: "cli",
        preview: "New native request",
        recencyAt: 30_000,
      });
      native.unshift(index.get(id)!);
    }
    readNative.mockClear();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    expect(readNative).toHaveBeenCalledOnce();
    expect(values.get("complete")).toEqual({ version: 1, kind: "complete", overflow: true });
  });

  it("reads snapshots after mutations admitted while an earlier write settles", async () => {
    const { values, state } = memoryState();
    const persistence = new CodexCatalogPersistence(state, () => {});
    try {
      persistence.put(storedRow("first", 200));
      persistence.put(storedRow("second", 100));
      await persistence.finishHydration();
      const remove = state.delete;
      vi.spyOn(state, "delete").mockImplementation(async (key) => {
        const value = values.get(key);
        const deleted = await remove(key);
        if (value?.kind === "row" && value.row.threadId === "first") {
          queueMicrotask(() => queueMicrotask(() => persistence.remove("second")));
        }
        return deleted;
      });

      persistence.remove("first");
      const snapshot = await persistence.readSnapshot();

      expect(snapshot).toMatchObject({ rows: [], complete: true });
      expect([...values.values()]).toEqual([{ version: 1, kind: "complete" }]);
    } finally {
      await persistence.retire();
    }
  });

  it("bounds a complete snapshot by evicting archived-oldest rows before active rows", async () => {
    const active = Array.from({ length: 19_999 }, (_, index) =>
      storedRow(`active-${index}`, 20_000 - index),
    );
    const rows = [
      storedRow("archived-old", 50_000, true),
      ...active,
      storedRow("archived-new", 70_000, true),
      storedRow("archived-middle", 60_000, true),
    ];
    const readNative = vi.fn(async () => ({ rows: [] }));
    const index = catalog({
      homeId: "oversized-complete-snapshot",
      state: completeState(rows),
      readNative,
    });
    const first = await index.list({ limit: 64 });
    expect(first.sessions.map((session) => session.threadId)).toEqual(
      active.slice(0, 64).map((entry) => entry.threadId),
    );
    expect(readNative).not.toHaveBeenCalled();
    const retained = rows.reduce(
      (count, entry) => count + Number(index.get(entry.threadId) !== undefined),
      0,
    );
    expect(retained).toBe(20_000);
    expect(index.get("archived-old")).toBeUndefined();
    expect(index.get("archived-middle")).toBeUndefined();
    expect(index.get("archived-new")?.archived).toBe(true);
    expect(index.get("active-19998")).toBeDefined();
  });

  it("cleans a full invalid snapshot without mistaking repeated keys for overflow", async () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => storedRow(`invalid-${index}`, index));
    rows[0]!.preview = "x".repeat(501);
    const snapshot = await readSnapshot(rows);
    expect(snapshot).toMatchObject({ rows: [], complete: false, cleanupIncomplete: false });
    expect(snapshot.obsolete.size).toBe(20_001);
  });

  it("keeps the persisted rollout path within its native catalog bound", async () => {
    const valid = storedRow("bounded", 100);
    valid.rolloutPath = `/${"x".repeat(4_095)}`;
    const accepted = await readSnapshot([valid]);
    expect(accepted.complete).toBe(true);
    expect(accepted.rows[0]?.rolloutPath).toHaveLength(4_096);

    const oversized = { ...valid, rolloutPath: `${valid.rolloutPath}x` };
    const rejected = await readSnapshot([oversized]);
    expect(rejected).toMatchObject({ complete: false, rows: [] });
    expect(rejected.obsolete).toEqual(new Set(["bounded", "complete"]));
  });
});

const createdAt = Date.parse("2026-09-16T12:00:00.000Z") / 1_000;
const line = (type: string, payload: unknown) => `${JSON.stringify({ type, payload })}\n`;
function rolloutContents(thread: CodexThread): string {
  return (
    line("session_meta", {
      id: thread.id,
      timestamp: new Date((thread.createdAt ?? createdAt) * 1_000).toISOString(),
      cwd: thread.cwd,
      source: thread.source,
      originator: "codex_cli_rs",
      session_id: thread.sessionId,
      model_provider: thread.modelProvider,
      cli_version: thread.cliVersion,
      git: thread.gitInfo,
    }) +
    line("event_msg", { type: "user_message", message: thread.preview }) +
    line("event_msg", { type: "agent_message", message: "x".repeat(256 * 1024) })
  );
}

async function fixture(data: (thread: CodexThread) => CodexThread[]) {
  const root = path.join(tempDirs.make("codex-native-authority-"), "sessions");
  const day = path.join(root, "2026", "09", "16");
  await fs.mkdir(day, { recursive: true });
  const file = path.join(day, "rollout-authority.jsonl");
  const thread: CodexThread = {
    id: "authority",
    projectId: null,
    path: file,
    name: null,
    preview: "Please preserve the current native workspace and catalog metadata.",
    source: "cli",
    originator: "codex_cli_rs",
    cwd: "/workspace/rollout-original",
    modelProvider: "rollout-provider",
    sessionId: "rollout-session",
    cliVersion: "0.100.0",
    gitInfo: { branch: "rollout-branch" },
    createdAt,
    updatedAt: createdAt + 100,
  };
  await fs.writeFile(file, rolloutContents(thread));
  await fs.utimes(file, createdAt + 100, createdAt + 100);
  const nativeData = data(thread);
  const readNative = vi.fn(async () => projectCodexCatalogPage({ data: nativeData }));
  const index = catalog({ homeId: root, localSessionsRoot: root, readNative });
  await index.initialize();
  return { file, thread, index, readNative };
}

async function reconcileAt(
  index: CodexCatalogIndex,
  file: string,
  timestamp: number,
  turnAt?: number,
) {
  if (turnAt !== undefined) {
    await fs.appendFile(
      file,
      line("event_msg", {
        type: "turn_started",
        turn_id: "new-turn",
        started_at: turnAt,
      }),
    );
  }
  await fs.utimes(file, timestamp, timestamp);
  await index.reconcile();
}

const sessionIds = async (index: CodexCatalogIndex) =>
  (await index.list({})).sessions.map((row) => row.threadId);

async function rewriteRollout(file: string, thread: CodexThread) {
  await fs.writeFile(file, rolloutContents(thread));
}

describe("native catalog metadata authority", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  });
  it.each([null, createdAt + 100])(
    "moves a file-observed turn ahead of a native timestamp tie (previous recency: %s)",
    async (recencyAt) => {
      const { file, thread, index, readNative } = await fixture((base) => {
        const native = {
          ...base,
          recencyAt,
          updatedAt: recencyAt === null ? createdAt + 100 : createdAt + 400,
        };
        return [
          { ...native, id: "newer-peer", path: undefined, recencyAt: createdAt + 200 },
          native,
        ];
      });
      expect(await sessionIds(index)).toEqual(["newer-peer", thread.id]);
      await reconcileAt(index, file, createdAt + 500, createdAt + 200);
      const current = await index.list({ limit: 1 });
      expect(current.sessions[0]).toMatchObject({
        threadId: thread.id,
        recencyAt: createdAt + 200,
        updatedAt: recencyAt === null ? createdAt + 100 : createdAt + 400,
      });
      expect(current.nextCursor).toBeDefined();
      await reconcileAt(index, file, createdAt + 600);
      expect(await index.list({ limit: 1 })).toEqual(current);
      expect(readNative).toHaveBeenCalledOnce();
    },
  );

  it("refreshes the selected file's preview without replacing native workspace metadata", async () => {
    const { file, thread, index, readNative } = await fixture((base) => [
      {
        ...base,
        cwd: "/workspace/native",
        preview: "Previous first request",
        updatedAt: createdAt + 300,
      },
    ]);
    await rewriteRollout(file, {
      ...thread,
      preview: "New first user request in the selected file",
    });
    await reconcileAt(index, file, createdAt + 400);
    expect((await index.list({ searchTerm: "new first" })).sessions[0]).toMatchObject({
      cwd: "/workspace/native",
      updatedAt: createdAt + 300,
      fallbackName: "New first user request in the selected file",
    });
    expect(readNative).toHaveBeenCalledOnce();
  });

  it("keeps native selections and fallback ordering when an old rollout is touched", async () => {
    const nativeMetadata = {
      cwd: "/workspace/native-selected",
      modelProvider: "native-provider",
      source: "vscode",
      sessionId: "native-session",
      cliVersion: "0.155.0",
      createdAt: createdAt + 10,
      updatedAt: createdAt + 300,
    } satisfies Partial<CodexThread>;
    const { file, index, readNative } = await fixture((thread) => {
      const native = {
        ...thread,
        ...nativeMetadata,
        gitInfo: { branch: "native-branch" },
        recencyAt: null,
      };
      return [{ ...native, id: "newer-peer", path: undefined, updatedAt: createdAt + 400 }, native];
    });
    const selected = {
      threadId: "authority",
      ...nativeMetadata,
      gitBranch: "native-branch",
    };
    await index.reconcile();
    expect(await sessionIds(index)).toEqual(["newer-peer", "authority"]);

    await reconcileAt(index, file, createdAt + 500);
    const touched = await index.list({});
    expect(touched.sessions.map((row) => row.threadId)).toEqual(["newer-peer", "authority"]);
    expect(touched.sessions[1]).toMatchObject(selected);
    expect((await index.list({ cwd: selected.cwd })).sessions).toEqual(touched.sessions);

    await reconcileAt(index, file, createdAt + 600, createdAt + 450);
    const started = await index.list({});
    expect(started.sessions.map((row) => row.threadId)).toEqual(["authority", "newer-peer"]);
    expect(started.sessions[0]).toMatchObject({ ...selected, recencyAt: createdAt + 450 });
    expect(index.get("authority")).toMatchObject({
      nativeMetadata: true,
      updatedAt: createdAt + 300,
      recencyAt: createdAt + 450,
    });
    expect(readNative).toHaveBeenCalledOnce();
  });

  it("updates provisional file metadata until a native upsert selects its authoritative values", async () => {
    const { file, thread, index, readNative } = await fixture(() => []);
    await index.reconcile();
    expect((await index.list({})).sessions[0]).toMatchObject({
      cwd: "/workspace/rollout-original",
      source: "cli",
      sessionId: "rollout-session",
    });

    const moved = {
      cwd: "/workspace/rollout-moved",
      source: "vscode",
      sessionId: "rollout-replaced-session",
      createdAt: createdAt + 20,
    } satisfies Partial<CodexThread>;
    await rewriteRollout(file, { ...thread, ...moved });
    await reconcileAt(index, file, createdAt + 200);
    expect((await index.list({ cwd: moved.cwd })).sessions[0]).toMatchObject({
      ...moved,
      updatedAt: createdAt + 200,
    });
    const provisional = index.get("authority");

    const promoted = {
      cwd: "/workspace/native-promoted",
      source: "cli",
      sessionId: "native-promoted-session",
      createdAt: createdAt + 30,
      updatedAt: createdAt + 300,
    } satisfies Partial<CodexThread>;
    await index.upsertThread({ ...thread, ...promoted });
    await fs.appendFile(file, line("event_msg", { type: "agent_message", message: "More output" }));
    await reconcileAt(index, file, createdAt + 400);
    expect((await index.list({})).sessions[0]).toMatchObject(promoted);
    expect((await index.list({ cwd: "/workspace/rollout-moved" })).sessions).toEqual([]);
    expect(provisional).toMatchObject({ nativeMetadata: false });
    expect(index.get("authority")).toMatchObject({ nativeMetadata: true });
    expect(readNative).toHaveBeenCalledOnce();
  });
});

describe("projectCodexCatalogNativeThread string bounds", () => {
  it.each([
    [{ originator: `${"s".repeat(499)}🙂` }, "originator", "s".repeat(499)],
    [{ source: { custom: `${"s".repeat(498)}🙂` } }, "source", { custom: `${"s".repeat(498)}🙂` }],
  ] as const)(
    "preserves whole surrogate pairs at native string bounds: %j",
    (input, field, expected) => {
      const row = projectCodexCatalogNativeThread({ id: "t1", ...input }, sanitizeTerminalText);
      expect(row[field]).toEqual(expected);
    },
  );

  it("carries bounded native fields into the displayed catalog", async () => {
    const thread = projectCodexCatalogNativeThread(
      {
        id: " thread-1 ",
        sessionId: " native-session ",
        name: " Title ",
        preview: "\u001b[31mFirst\nrequest\u001b[0m",
        cwd: " /workspace/project ",
        modelProvider: "p".repeat(501),
        cliVersion: " 0.155.0 ",
        gitInfo: { branch: " main " },
        createdAt: 100,
        updatedAt: Number.NaN,
        recencyAt: null,
        source: "cli",
        status: { type: "active", activeFlags: [" waitingOnApproval ", "", 42] },
      },
      sanitizeTerminalText,
    );
    const page = await projectCodexCatalogPage({ data: [thread] });
    expect(page.rows[0]?.page.sessions).toEqual([
      {
        threadId: "thread-1",
        sessionId: "native-session",
        name: "Title",
        cwd: "/workspace/project",
        source: "cli",
        status: "active",
        activeFlags: ["waitingOnApproval"],
        createdAt: 100,
        recencyAt: null,
        modelProvider: "p".repeat(500),
        cliVersion: "0.155.0",
        gitBranch: "main",
        archived: false,
      },
    ]);
    expect(page.rows[0]?.preview).toBe("First request");
  });
});

it("keeps post-mutation pages and title filters within the resident CPU budget", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const rows = Array.from({ length: 19_999 }, (_, position) =>
    catalogRow(`thread-${position}`, 20_000 - position, {
      name: `Review the sidebar for project ${position}`,
      cwd: "/workspace/project",
    }),
  );
  let nativeReads = 0;
  const index = catalog({
    homeId: "resident-page-cpu",
    readNative: async (params) => {
      nativeReads++;
      const offset = Number(params.cursor ?? 0);
      const end = offset + 64;
      return {
        rows: rows.slice(offset, end),
        ...(end < rows.length ? { nextCursor: String(end) } : {}),
      };
    },
  });
  await index.initialize();
  const readsAfterHydration = nativeReads;
  const queries = [
    { searchTerm: undefined, cwd: undefined, matches: true },
    { searchTerm: "SIDEBAR", cwd: "/workspace/project", matches: true },
    { searchTerm: "absent-title-sentinel", cwd: undefined, matches: false },
  ].map((query) => Object.assign(query, { cpuMicros: 0, calls: 0 }));
  for (let iteration = 0; iteration < 100; iteration++) {
    index.archive(rows[iteration]!.threadId);
    const query = queries[iteration % queries.length]!;
    const cpu = process.threadCpuUsage();
    const page = await index.list({
      limit: 64,
      searchTerm: query.searchTerm,
      cwd: query.cwd,
    });
    const usage = process.threadCpuUsage(cpu);
    query.cpuMicros += usage.user + usage.system;
    query.calls++;
    expect(page.sessions).toHaveLength(query.matches ? 64 : 0);
    if (query.matches) {
      expect(page.sessions[0]?.threadId).toBe(`thread-${iteration + 1}`);
    }
  }
  const mainThreadCpuMsPerPage = queries.map((query) => query.cpuMicros / query.calls / 1_000);
  expect(nativeReads).toBe(readsAfterHydration);
  for (const cpu of mainThreadCpuMsPerPage) {
    expect(cpu).toBeLessThan(2);
  }
});
