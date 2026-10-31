import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { memoryCatalogState } from "./session-catalog-index.test-support.js";
import { lookupNodeCodexCatalogRecord } from "./session-catalog-node-lookup.js";
import { NODE_INVOKE_TIMEOUT_MS } from "./session-catalog-parsing.js";
import * as resident from "./session-catalog-resident.test-support.js";
import * as catalog from "./session-catalog.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

async function remoteFixture(count: number) {
  let activeRows: CodexThread[] = resident.nativeCatalogFixture(count).rows;
  const target = activeRows.at(-1)!;
  const { values: stored, state } = memoryCatalogState();
  const factory = resident.remoteCatalogFactory("exact-overflow", {
    getRuntimeConfig: () => catalog.config,
    openResidentState: () => state,
  });
  const home = (await factory.homesForAgent("main"))[0]!;
  expect(home.localSessionsRoot).toBeUndefined();
  const control = factory.forRequest("main", home);
  catalog.pinnedConnectionMocks.request.mockImplementation(async ({ method, requestParams }) => {
    if (method === "thread/read") {
      return { thread: target };
    }
    if (method === "thread/list") {
      expect(requestParams).toMatchObject({ archived: false, cwd: target.cwd });
      const offset = Number(requestParams.cursor ?? 0);
      const data = activeRows.slice(offset, offset + Number(requestParams.limit));
      const next = offset + data.length;
      return { data, ...(next < activeRows.length ? { nextCursor: String(next) } : {}) };
    }
    throw new Error(`Unexpected exact lookup request ${method}`);
  });
  await control.initialize();
  return {
    control,
    target,
    stored,
    setActiveRows: (rows: CodexThread[]) => {
      activeRows = rows;
    },
  };
}

it.each(["evicted", "not-member", "archived"])(
  "checks fresh remote membership for %s rows",
  async (kind) => {
    const f = await remoteFixture(kind === "evicted" ? 20_001 : 1);
    const rows = [...f.stored.values()].flatMap((entry) =>
      entry.kind === "row" ? [entry.row] : [],
    );
    expect(rows).toHaveLength(kind === "evicted" ? 20_000 : 1);
    expect(rows.some((row) => row.threadId === f.target.id)).toBe(kind !== "evicted");
    if (kind === "not-member") {
      f.setActiveRows([]);
    } else if (kind === "archived") {
      await f.control.archiveThread(f.target.id);
      f.setActiveRows([f.target]);
    }
    const result = expect(f.control.requireEligibleThread(f.target.id));
    if (kind === "not-member") {
      await result.rejects.toThrow("eligibility could not be verified");
    } else {
      await result.resolves.toMatchObject({ id: f.target.id });
    }
    if (kind === "evicted") {
      expect(
        catalog.pinnedConnectionMocks.request.mock.calls.map(([request]) => request.method),
      ).toEqual(expect.arrayContaining(["thread/read", "thread/list"]));
    }
  },
);

it("finds a paired-node thread after more than 100 catalog pages", async () => {
  const record = {
    threadId: "older-node-thread",
    status: "notLoaded",
    source: "cli",
    archived: false,
  };
  let page = 0;
  const invoke = vi.fn(async () => ({
    payloadJSON: JSON.stringify({
      sessions: ++page === 125 ? [record] : [],
      ...(page < 125 ? { nextCursor: `page-${page}` } : {}),
    }),
  }));
  const { runtime } = catalog.createRuntime({ invoke });
  await expect(
    lookupNodeCodexCatalogRecord({
      agentId: "main",
      runtime,
      nodeId: "node",
      threadId: record.threadId,
    }),
  ).resolves.toEqual({ kind: "found", record });
  expect(invoke).toHaveBeenCalledTimes(125);
});

it("keeps one node lookup deadline across advancing pages", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const invoke = vi.fn(async () => {
    elapsed += NODE_INVOKE_TIMEOUT_MS / 2 + 1;
    return { payloadJSON: JSON.stringify({ sessions: [], nextCursor: String(elapsed) }) };
  });
  const { runtime } = catalog.createRuntime({ invoke });
  await expect(
    lookupNodeCodexCatalogRecord({ agentId: "main", runtime, nodeId: "node", threadId: "older" }),
  ).rejects.toThrow("eligibility could not be verified");
  expect(invoke).toHaveBeenCalledTimes(2);
});
