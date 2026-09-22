import { expect, it } from "vitest";
import type { CodexCatalogIndexRow } from "./session-catalog-index-row.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
import { listCodexSessionCatalog } from "./session-catalog-list-operation.js";
import {
  config,
  createCodexSessionCatalogControlFactory,
  createCodexTestBindingStore,
  createControl,
  createRuntime,
} from "./session-catalog.test-helpers.js";

it.each([1, 4])("measures warm listing of 11000 threads across %i homes", async (homeCount) => {
  const base = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({ supervision: { enabled: true } }),
    getRuntimeConfig: () => config,
  });
  const primary = (await base.homesForAgent("main"))[0]!;
  const homes = Array.from({ length: homeCount }, (_, home) => ({
    ...primary,
    sourceHomeId: `perf-home-${home}`,
    hostId: `gateway:local:perf-home-${home}`,
  }));
  const indexes = homes.map((home) => {
    const rows: CodexCatalogIndexRow[] = Array.from({ length: 11_000 / homeCount }, (_, i) => ({
      threadId: `thread-${i}`,
      updatedAt: 20_000 - i,
      recencyAt: 20_000 - i,
      archived: i % 10 === 9,
      nativeMetadata: true,
      page: {
        sessions: [
          {
            threadId: `thread-${i}`,
            name: `Session ${i}`,
            fallbackName: "Synthetic preview ".repeat(20),
            cwd: "/workspace/project",
            status: "notLoaded",
            source: "cli",
            archived: i % 10 === 9,
          },
        ],
      },
    }));
    return new CodexCatalogIndex({
      homeId: home.sourceHomeId,
      assertCurrent: () => {},
      readNative: async (params) => {
        const start = Number(params.cursor ?? 0);
        const end = start + params.limit!;
        return {
          rows: rows.slice(start, end),
          ...(end < rows.length ? { nextCursor: String(end) } : {}),
        };
      },
    });
  });
  const controls = new Map(
    homes.map((home, i) => [
      home.sourceHomeId,
      createControl({ listPage: (params) => indexes[i]!.list(params) }),
    ]),
  );
  const { runtime } = createRuntime();
  const bindingStore = createCodexTestBindingStore();
  const control = {
    ...base,
    homesForAgent: async () => homes,
    forRequest: (_agentId: string, home = primary) => controls.get(home.sourceHomeId)!,
  };
  try {
    await Promise.all(indexes.map((index) => index.initialize()));
    const first = await indexes[0]!.list({ limit: 64 });
    const second = await indexes[0]!.list({ limit: 64, cursor: first.nextCursor });
    expect(second.sessions[0]?.threadId).toBe("thread-71");
    expect(
      (await indexes[0]!.list({ limit: 64, cursor: second.backwardsCursor })).sessions,
    ).toEqual(first.sessions);
    const cases = {
      head: () => indexes[0]!.list({ limit: 64 }),
      forward: () => indexes[0]!.list({ limit: 64, cursor: first.nextCursor }),
      backward: () => indexes[0]!.list({ limit: 64, cursor: second.backwardsCursor }),
      hosts: () =>
        listCodexSessionCatalog({
          bindingStore,
          config,
          runtime,
          control,
          localHomes: homes,
          query: { limitPerHost: 64, hostIds: homes.map((home) => home.hostId) },
        }),
    };
    const measurements = [];
    for (const [name, run] of Object.entries(cases)) {
      for (let i = 0; i < 50; i++) {
        await run();
      }
      const elapsed: number[] = [];
      const cpu = process.threadCpuUsage();
      for (let i = 0; i < 1_000; i++) {
        const started = performance.now();
        await run();
        elapsed.push(performance.now() - started);
      }
      const usage = process.threadCpuUsage(cpu);
      elapsed.sort((a, b) => a - b);
      measurements.push({
        name,
        p50Ms: elapsed[499],
        p95Ms: elapsed[949],
        cpuMsPerCall: (usage.user + usage.system) / 1_000_000,
      });
    }
    const result = await cases.hosts();
    expect(result.hosts).toHaveLength(homeCount);
    for (const host of result.hosts) {
      expect(host.sessions).toHaveLength(64);
      expect(host.sessions.map((session) => session.threadId)).toEqual(
        first.sessions.map((session) => session.threadId),
      );
      expect(host.nextCursor).toBeDefined();
    }
    console.info("warm catalog listing", JSON.stringify({ rows: 11_000, homeCount, measurements }));
  } finally {
    await Promise.all(indexes.map((index) => index.close()));
  }
});
