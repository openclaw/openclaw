import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { projectCodexCatalogPage } from "./session-catalog-projection.js";
import {
  measureCatalogLists,
  nativeCatalogFixture as fixture,
  writeCatalogRollout,
} from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  createCodexSessionCatalogControl,
  idleThread,
} from "./session-catalog.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resident Codex catalog", () => {
  it("preserves native sub-second order when exposed timestamps tie", async () => {
    const native = ["alpha", "bravo", "zulu"].map((id) =>
      idleThread({
        id,
        source: "cli",
        originator: "codex_cli_rs",
        recencyAt: id === "zulu" ? 99 : 100,
      }),
    );
    const index = new CodexCatalogIndex({
      homeId: "native-order",
      assertCurrent: () => {},
      readNative: async () =>
        projectCodexCatalogPage({ data: native }, { sanitize: sanitizeTerminalText }),
    });
    try {
      await index.initialize();
      const first = await index.list({ limit: 1 });
      expect(first.sessions[0]?.threadId).toBe("alpha");
      const second = await index.list({ limit: 1, cursor: first.nextCursor });
      expect(second.sessions[0]?.threadId).toBe("bravo");
      expect((await index.list({ limit: 1, cursor: second.backwardsCursor })).sessions).toEqual(
        first.sessions,
      );
      await index.upsertThread({ ...native[2]!, recencyAt: 100 });
      let current = await index.list({ limit: 1 });
      const ids = current.sessions.map((session) => session.threadId);
      while (current.nextCursor) {
        current = await index.list({ limit: 1, cursor: current.nextCursor });
        ids.push(...current.sessions.map((session) => session.threadId));
      }
      expect(ids).toEqual(["zulu", "alpha", "bravo"]);
    } finally {
      await index.close();
    }
  });

  it("serves every warm page and filter without re-entering the native producer", async () => {
    const f = fixture(3_000);
    const control = await f.make();
    let page = await control.listPage({ limit: 100 });
    while (page.nextCursor) {
      page = await control.listPage({ limit: 100, cursor: page.nextCursor });
    }
    f.expire();
    const readFile = vi.spyOn(fs, "readFile");
    const open = vi.spyOn(fs, "open");
    const first = await control.listPage({ limit: 100 });
    await control.listPage({ limit: 50, cursor: first.nextCursor });
    await control.listPage({ limit: 20, cwd: "/workspace/project", searchTerm: "native" });
    expect(f.fetched).toEqual([]);
    expect(readFile).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["larger limit", "removed rows"])(
    "ends a backward page before its anchor after %s",
    async (change) => {
      const control = await fixture(90).make();
      const limit = change === "larger limit" ? 20 : 64;
      const first = await control.listPage({ limit });
      const second = await control.listPage({ limit, cursor: first.nextCursor });
      const removed = change === "removed rows" ? first.sessions.slice(0, 24) : [];
      for (const session of removed) {
        await control.archiveThread(session.threadId);
      }
      const previous = await control.listPage({ limit: 64, cursor: second.backwardsCursor });
      expect(previous.sessions.map((session) => session.threadId)).toEqual(
        first.sessions.slice(removed.length).map((session) => session.threadId),
      );
    },
  );

  it("hydrates the complete home once while retaining 64-row wire pages", async () => {
    const f = fixture();
    const control = await f.make();
    const first = await control.listPage({ limit: 100 });
    expect(first.sessions).toHaveLength(64);
    expect(f.fetched.flat()).toHaveLength(160);
    expect(Math.max(...f.fetched.map((rows) => rows.length))).toBe(64);
    const calls = f.fetched.length;
    const second = await control.listPage({ limit: 100, cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(64);
    expect(second.sessions[0]?.threadId).toBe("thread-064");
    expect(f.fetched).toHaveLength(calls);
  });

  it("retains only display-sized previews from large native responses", async () => {
    const f = fixture(80, 1024 * 1024);
    for (const row of f.rows) {
      row.name = null;
    }
    const page = await (await f.make()).listPage({ limit: 100 });
    expect(f.fetched[0]).toHaveLength(64);
    expect(page.sessions.every((row) => row.fallbackName?.length === 500)).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThan(64 * 4_096);
  });

  it("keeps native order for tied recency timestamps across every resident page", async () => {
    const f = fixture(3_000);
    for (const row of f.rows) {
      row.recencyAt = 1_000;
      row.updatedAt = 1_000;
    }
    const control = await f.make();
    let page = await control.listPage({ limit: 64 });
    const ids = page.sessions.map((row) => row.threadId);
    while (page.nextCursor) {
      page = await control.listPage({ limit: 64, cursor: page.nextCursor });
      ids.push(...page.sessions.map((row) => row.threadId));
    }
    expect(ids).toEqual(
      f.rows
        .map((row) => row.id)
        .toSorted()
        .toReversed(),
    );
    expect(new Set(ids).size).toBe(3_000);
  });

  it("orders by native recency instead of metadata modification time", async () => {
    const f = fixture();
    f.rows[20] = { ...f.rows[20]!, recencyAt: 20_000, updatedAt: 1 };
    const control = await f.make();
    expect((await control.listPage({ limit: 100 })).sessions[0]?.threadId).toBe("thread-020");
    f.expire();
    expect((await control.listPage({ limit: 100 })).sessions[0]?.threadId).toBe("thread-020");
    expect(f.fetched).toEqual([]);
  });

  it("filters arbitrary cwd views and title searches from the same home inventory", async () => {
    const f = fixture();
    for (let i = 0; i < f.rows.length; i++) {
      f.rows[i]!.cwd = `/workspace/${i % 40}`;
      f.rows[i]!.name = i % 2 ? "Native feature" : "Bug fix";
      f.rows[i]!.preview = "Native preview must not match a title search";
    }
    const control = await f.make();
    await control.listPage({ limit: 100 });
    f.fetched.length = 0;
    for (let i = 0; i < 40; i++) {
      const page = await control.listPage({ cwd: `/workspace/${i}`, limit: 100 });
      expect(page.sessions.map((row) => row.threadId)).toEqual(
        f.rows.filter((row) => row.cwd === `/workspace/${i}`).map((row) => row.id),
      );
    }
    expect(
      (await control.listPage({ cwd: "/workspace/0", searchTerm: "native" })).sessions,
    ).toEqual([]);
    expect(
      (await control.listPage({ cwd: "/workspace/1", searchTerm: " NATIVE " })).sessions,
    ).toHaveLength(4);
    expect(f.fetched).toEqual([]);
  });

  it("removes an archived thread before the next list without a native re-walk", async () => {
    const f = fixture();
    const control = await f.make();
    await control.listPage({ limit: 100 });
    f.fetched.length = 0;
    await control.archiveThread("thread-000");
    const page = await control.listPage({ limit: 100 });
    expect(page.sessions[0]?.threadId).toBe("thread-001");
    expect(page.sessions.some((row) => row.threadId === "thread-000")).toBe(false);
    expect(f.fetched).toEqual([]);
    expect(
      commandRpcMocks.codexControlRequest.mock.calls.filter((call) => call[1] === "thread/archive"),
    ).toHaveLength(1);
  });

  it("reconciles a new rollout with only bounded reads of that file", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const root = path.join(tempDirs.make("openclaw-resident-currency-"), "sessions");
    const existing = idleThread({ id: "existing", source: "cli", originator: "codex_cli_rs" });
    existing.path = await writeCatalogRollout(root, existing);
    const readNative = vi.fn(async () =>
      projectCodexCatalogPage({ data: [existing] }, { sanitize: sanitizeTerminalText }),
    );
    const index = new CodexCatalogIndex({
      homeId: "currency",
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await vi.advanceTimersByTimeAsync(0);
      await index.reconcile();
      const stat = vi.spyOn(fs, "lstat");
      await vi.advanceTimersByTimeAsync(30_000);
      expect(stat).not.toHaveBeenCalled();
      expect(readNative).toHaveBeenCalledOnce();
      const added = await writeCatalogRollout(
        root,
        idleThread({ id: "new-thread", preview: "A new native request" }),
        2 * 1024 * 1024,
      );
      const reads: Array<() => Promise<number[]>> = [];
      const realOpen = fs.open;
      const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        const read = vi.spyOn(handle, "read");
        reads.push(async () =>
          Promise.all(read.mock.results.map(async (result) => (await result.value).bytesRead)),
        );
        return handle;
      });
      const readFile = vi.spyOn(fs, "readFile");
      await vi.advanceTimersByTimeAsync(14 * 60_000 + 30_000);
      await index.reconcile();
      await vi.waitFor(async () => {
        expect((await index.list({})).sessions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              threadId: "new-thread",
              fallbackName: "A new native request",
            }),
            expect.objectContaining({ threadId: "existing" }),
          ]),
        );
      });
      expect(open.mock.calls.map((call) => call[0])).toEqual([added]);
      const bytesRead = (await Promise.all(reads.map((read) => read()))).flat();
      expect(bytesRead.reduce((sum, value) => sum + value, 0)).toBe(256 * 1024);
      expect(readFile).not.toHaveBeenCalled();
      expect(readNative).toHaveBeenCalledTimes(2);
      open.mockClear();
      await index.list({});
      expect(open).not.toHaveBeenCalled();
    } finally {
      await index.close();
    }
  });

  it("does not reread unchanged incomplete rollouts during currency scans", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const root = path.join(tempDirs.make("openclaw-resident-incomplete-"), "sessions");
    const file = await writeCatalogRollout(root, idleThread({ id: "partial" }));
    await fs.writeFile(file, '{"type":"session_meta","payload":');
    const index = new CodexCatalogIndex({
      homeId: "incomplete",
      localSessionsRoot: root,
      readNative: async () => ({ rows: [] }),
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await vi.advanceTimersByTimeAsync(0);
      await index.reconcile();
      const open = vi.spyOn(fs, "open");
      await index.reconcile();
      expect(open).not.toHaveBeenCalled();
      await writeCatalogRollout(
        root,
        idleThread({ id: "partial", preview: "Completed native request" }),
      );
      await index.reconcile();
      expect(open.mock.calls.map(([opened]) => opened)).toEqual([file]);
      expect((await index.list({})).sessions[0]?.fallbackName).toBe("Completed native request");
    } finally {
      await index.close();
    }
  });

  it("keeps file scans on their own safety cadence through native outages and recovery", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const root = path.join(tempDirs.make("openclaw-catalog-outage-"), "sessions");
    const existing = idleThread({ id: "existing", source: "cli" });
    existing.path = await writeCatalogRollout(root, existing);
    const page = await projectCodexCatalogPage(
      { data: [existing] },
      { sanitize: sanitizeTerminalText },
    );
    const readNative = vi.fn(async () => page);
    const index = new CodexCatalogIndex({
      homeId: "file-scan-outage",
      localSessionsRoot: root,
      readNative,
      assertCurrent: () => {},
    });
    try {
      await index.initialize();
      await vi.advanceTimersByTimeAsync(0);
      await index.reconcile();
      readNative.mockRejectedValueOnce(new Error("native unavailable"));
      readNative.mockRejectedValueOnce(new Error("native retry unavailable"));
      const stat = vi.spyOn(fs, "lstat");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(stat).toHaveBeenCalled();
      expect(readNative).toHaveBeenCalledTimes(2);
      stat.mockClear();
      await index.upsertThread(existing);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(readNative).toHaveBeenCalledTimes(3);
      expect(stat).not.toHaveBeenCalled();
      await index.upsertThread(existing);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(readNative).toHaveBeenCalledTimes(4);
      expect(stat).not.toHaveBeenCalled();

      await writeCatalogRollout(root, idleThread({ id: "external", preview: "External request" }));
      await vi.advanceTimersByTimeAsync(14 * 60_000);
      await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
      expect(stat).toHaveBeenCalled();
      expect(index.get("external")?.preview).toBe("External request");
    } finally {
      await index.close();
    }
  });

  it("rejects malformed cursors before native reads", async () => {
    const f = fixture();
    const control = createCodexSessionCatalogControl({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      getRuntimeConfig: () => undefined,
    });
    await expect(control.listPage({ cursor: "x".repeat(4097), limit: 100 })).rejects.toThrow(
      /cursor/,
    );
    expect(f.fetched).toEqual([]);
  });

  it("serves 100 warm 3,000-thread queries within the resident latency budget", async () => {
    const f = fixture(3_000, 512);
    const metrics = await measureCatalogLists(await f.make(), f.expire);
    console.info("resident catalog fixture", JSON.stringify(metrics));
    expect(metrics.threadListCalls).toBe(0);
    expect(metrics.p50Ms).toBeLessThan(20);
  });
});
