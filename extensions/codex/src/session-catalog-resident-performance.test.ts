import { afterEach, expect, it, vi } from "vitest";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";

afterEach(() => vi.useRealTimers());

it("keeps post-mutation pages and title filters within the resident CPU budget", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout"] });
  const rows: CodexCatalogIndexRow[] = Array.from({ length: 19_999 }, (_, position) => ({
    threadId: `thread-${position}`,
    archived: false,
    nativeMetadata: true,
    updatedAt: 20_000 - position,
    recencyAt: 20_000 - position,
    page: {
      sessions: [
        {
          threadId: `thread-${position}`,
          name: `Review the sidebar for project ${position}`,
          cwd: "/workspace/project",
          status: "notLoaded",
          archived: false,
        },
      ],
    },
  }));
  let nativeReads = 0;
  const index = new CodexCatalogIndex({
    homeId: "resident-page-cpu",
    assertCurrent: () => {},
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
  try {
    await index.initialize();
    const readsAfterHydration = nativeReads;
    const queries = [
      { searchTerm: undefined, cwd: undefined, matches: true },
      { searchTerm: "SIDEBAR", cwd: "/workspace/project", matches: true },
      { searchTerm: "absent-title-sentinel", cwd: undefined, matches: false },
    ].map((query) => Object.assign(query, { cpuMicros: 0, calls: 0 }));
    const started = performance.now();
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
    console.info("resident page CPU", {
      rows: rows.length,
      pages: 100,
      wallMs: performance.now() - started,
      mainThreadCpuMsPerPage,
    });
    expect(nativeReads).toBe(readsAfterHydration);
    for (const cpu of mainThreadCpuMsPerPage) {
      expect(cpu).toBeLessThan(2);
    }
  } finally {
    await index.close();
  }
});
