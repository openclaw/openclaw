import { setImmediate as nextTurn } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import {
  commandRpcMocks,
  createCodexSessionCatalogControlFactory,
  idleThread,
} from "./session-catalog.test-helpers.js";

function fixture(count = 160, previewBytes = 32) {
  let now = 1_000;
  const rows = Array.from({ length: count }, (_, i) => ({
    ...idleThread({
      id: `thread-${String(i).padStart(3, "0")}`,
      source: "cli",
      originator: "codex_cli_rs",
      preview: `Preview ${i} ${"x".repeat(previewBytes)}`,
    }),
    updatedAt: 1_000 - i,
    recencyAt: 1_000 - i,
  }));
  const fetched: string[][] = [];
  let failAt: number | undefined;
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, _method, params) => {
    const offset = Number(params.cursor ?? 0);
    const field = params.sortKey === "recency_at" ? "recencyAt" : "updatedAt";
    const ordered = rows.toSorted((a, b) => b[field] - a[field]);
    const data = structuredClone(ordered.slice(offset, offset + params.limit));
    fetched.push(data.map((row) => row.id));
    if (failAt === fetched.length) {
      failAt = undefined;
      throw new Error("interrupted refresh");
    }
    return {
      data,
      nextCursor: offset + data.length < rows.length ? String(offset + data.length) : null,
    };
  });
  const make = async () => {
    const factory = createCodexSessionCatalogControlFactory({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      // Exercise the owner directly; query-cache coverage lives in listing-cache tests.
      getRuntimeConfig: () => undefined,
      now: () => now,
    });
    return factory.forRequest("main", (await factory.homesForAgent("main"))[0]);
  };
  const expire = () => {
    now += 32_001;
    fetched.length = 0;
  };
  return {
    rows,
    fetched,
    make,
    expire,
    failNextPage: (page: number) => {
      failAt = page;
    },
  };
}

describe("in-memory Codex catalog producer", () => {
  it("serves a cold page immediately and fetches older pages only on demand", async () => {
    const f = fixture();
    const control = await f.make();
    const first = await control.listPage({ limit: 100 });
    expect(first.sessions).toHaveLength(64);
    expect(f.fetched).toHaveLength(1);
    expect(first.nextCursor).toBeDefined();
    const second = await control.listPage({ limit: 100, cursor: first.nextCursor });
    expect(second.sessions).toHaveLength(64);
    expect(second.sessions[0]?.threadId).toBe("thread-064");
    expect(f.fetched).toHaveLength(2);
  });

  it("bounds native wire pages and retains only display-sized previews", async () => {
    const f = fixture(160, 1024 * 1024);
    const page = await (await f.make()).listPage({ limit: 100 });
    expect(f.fetched[0]).toHaveLength(64);
    expect(page.sessions.every((row) => (row.fallbackName?.length ?? 0) <= 500)).toBe(true);
    expect(JSON.stringify(page).length).toBeLessThan(64 * 4_096);
  });

  it("probes an unchanged watermark with one row and reuses the bounded page", async () => {
    const f = fixture();
    const control = await f.make();
    const first = await control.listPage({ limit: 100 });
    f.expire();
    expect(await control.listPage({ limit: 100 })).toEqual(first);
    expect(f.fetched).toEqual([["thread-000"]]);
  });

  it("starts cold after a new owner is created", async () => {
    const f = fixture();
    await (await f.make()).listPage({ limit: 100 });
    f.expire();
    const page = await (await f.make()).listPage({ limit: 100 });
    expect(page.sessions).toHaveLength(64);
    expect(f.fetched).toHaveLength(1);
    expect(f.fetched[0]).toHaveLength(64);
  });

  it("refreshes a changed thread without walking the untouched inventory", async () => {
    const f = fixture(1_000);
    const control = await f.make();
    await control.listPage({ limit: 100 });
    f.rows[20] = { ...f.rows[20]!, updatedAt: 2_000, recencyAt: 2_000, name: "Changed title" };
    f.expire();
    const page = await control.listPage({ limit: 100 });
    expect(page.sessions[0]).toMatchObject({ threadId: "thread-020", name: "Changed title" });
    expect(f.fetched.flat()).not.toContain("thread-999");
    expect(f.fetched.length).toBeLessThanOrEqual(4);
  });

  it.each([0, 1_001])(
    "reads past an unchanged page when timestamps tie (clock step %i)",
    async (stepMs) => {
      const f = fixture();
      for (const row of f.rows.slice(0, 100)) {
        row.updatedAt = 1_000;
        row.recencyAt = 1_000;
      }
      const control = await f.make();
      const first = await control.listPage({ limit: 100 });
      await control.listPage({ limit: 100, cursor: first.nextCursor });
      let clock = 0;
      const timing = vi.spyOn(performance, "now").mockImplementation(() => (clock += stepMs));
      try {
        f.rows[70] = { ...f.rows[70]!, name: "Updated within the tied second" };
        f.expire();
        await control.listPage({ limit: 100 });
        expect(f.fetched.flat()).toContain("thread-070");
        expect(f.fetched.flat()).not.toContain("thread-159");
        const second = await control.listPage({ limit: 100, cursor: first.nextCursor });
        expect(second.sessions.find((row) => row.threadId === "thread-070")?.name).toBe(
          "Updated within the tied second",
        );
      } finally {
        timing.mockRestore();
      }
    },
  );

  it("uses native recency when activity order differs from metadata modification time", async () => {
    const f = fixture();
    f.rows[20] = { ...f.rows[20]!, recencyAt: 2_000 };
    const control = await f.make();
    const first = await control.listPage({ limit: 100 });
    expect(first.sessions[0]?.threadId).toBe("thread-020");
    f.expire();
    await control.listPage({ limit: 100 });
    expect(f.fetched).toEqual([["thread-020"]]);
    f.expire();
    f.rows[30] = { ...f.rows[30]!, recencyAt: 3_000 };
    const refreshed = await control.listPage({ limit: 100 });
    expect(refreshed.sessions[0]?.threadId).toBe("thread-030");
    expect(new Set(refreshed.sessions.map((row) => row.threadId)).size).toBe(
      refreshed.sessions.length,
    );
  });

  it("drops a missing thread from the refreshed page", async () => {
    const f = fixture();
    const control = await f.make();
    await control.listPage({ limit: 100 });
    f.rows.shift();
    f.expire();
    const page = await control.listPage({ limit: 100 });
    expect(page.sessions.some((row) => row.threadId === "thread-000")).toBe(false);
    expect(page.sessions[0]?.threadId).toBe("thread-001");
  });

  it("retries an interrupted refresh without advancing its watermark", async () => {
    const f = fixture();
    const control = await f.make();
    await control.listPage({ limit: 100 });
    f.rows[20] = {
      ...f.rows[20]!,
      updatedAt: 2_000,
      recencyAt: 2_000,
      name: "Changed after interruption",
    };
    f.expire();
    f.failNextPage(2);
    await expect(control.listPage({ limit: 100 })).rejects.toThrow("interrupted refresh");
    const page = await control.listPage({ limit: 100 });
    expect(page.sessions[0]).toMatchObject({
      threadId: "thread-020",
      name: "Changed after interruption",
    });
    expect(f.fetched.filter((batch) => batch[0] === "thread-020").length).toBeGreaterThanOrEqual(2);
  });

  it("refreshes the bounded head after repeated unchanged probes and an interruption", async () => {
    const f = fixture();
    const control = await f.make();
    await control.listPage({ limit: 100 });
    f.rows.splice(2, 1);
    for (let i = 0; i < 9; i++) {
      f.expire();
      await control.listPage({ limit: 100 });
    }
    f.expire();
    f.failNextPage(1);
    await expect(control.listPage({ limit: 100 })).rejects.toThrow("interrupted refresh");
    const refreshed = await control.listPage({ limit: 100 });
    expect(refreshed.sessions.some((row) => row.threadId === "thread-002")).toBe(false);
    expect(f.fetched.flat()).not.toContain("thread-159");
  });

  it("recognizes the unchanged head after browsing beyond row cache residency", async () => {
    const f = fixture(3_000);
    const control = await f.make();
    let page = await control.listPage({ limit: 100 });
    const ids = new Set(page.sessions.map((row) => row.threadId));
    while (page.nextCursor) {
      page = await control.listPage({ limit: 100, cursor: page.nextCursor });
      for (const row of page.sessions) {
        ids.add(row.threadId);
      }
    }
    expect(ids.size).toBe(3_000);
    for (let i = 0; i < 10; i++) {
      f.expire();
      await control.listPage({ limit: 100 });
    }
    expect(f.fetched).toHaveLength(2);
    expect(f.fetched.flat()).not.toContain("thread-128");
  });

  it("refetches evicted cwd views without limiting catalog membership", async () => {
    const f = fixture();
    const control = await f.make();
    for (let i = 0; i < 33; i++) {
      const page = await control.listPage({ cwd: `/workspace/${i}`, limit: 100 });
      expect(page.sessions).toHaveLength(64);
    }
    f.fetched.length = 0;
    const page = await control.listPage({ cwd: "/workspace/0", limit: 100 });
    expect(page.sessions).toHaveLength(64);
    expect(f.fetched).toHaveLength(1);
  });

  it("keeps a pending cwd view shared while idle views are evicted", async () => {
    const f = fixture();
    const control = await f.make();
    const native = commandRpcMocks.codexControlRequest.getMockImplementation();
    if (!native) {
      throw new Error("expected native fixture");
    }
    const gate = createDeferred<void>();
    const started = createDeferred<void>();
    let heldRequests = 0;
    commandRpcMocks.codexControlRequest.mockImplementation(
      async (plugin, method, params, options) => {
        if (params.cwd === "/held") {
          heldRequests++;
          started.resolve();
          await gate.promise;
        }
        return await native(plugin, method, params, options);
      },
    );
    const first = control.listPage({ cwd: "/held", limit: 100 });
    let joined;
    try {
      await started.promise;
      for (let i = 0; i < 33; i++) {
        await control.listPage({ cwd: `/workspace/${i}`, limit: 100 });
      }
      joined = control.listPage({ cwd: "/held", limit: 100 });
      await nextTurn();
      expect(heldRequests).toBe(1);
      gate.resolve();
      expect(await joined).toEqual(await first);
    } finally {
      gate.resolve();
      await Promise.allSettled([first, joined]);
    }
  });

  it("rejects malformed cursors before native reads", async () => {
    const f = fixture();
    await expect(
      (await f.make()).listPage({ cursor: "x".repeat(4097), limit: 100 }),
    ).rejects.toThrow(/cursor/);
    expect(f.fetched).toEqual([]);
  });
});
