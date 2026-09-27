import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import type { CodexCatalogState, StoredCodexCatalogEntry } from "./session-catalog-index-state.js";
import { lookupNodeCodexCatalogRecord } from "./session-catalog-node-lookup.js";
import { NODE_INVOKE_TIMEOUT_MS } from "./session-catalog-parsing.js";
import { nativeCatalogFixture } from "./session-catalog-resident.test-support.js";
import {
  commandRpcMocks,
  config,
  createCodexSessionCatalogControlFactory,
  createRuntime,
  idleThread,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

async function remoteFixture(count: number) {
  const native = nativeCatalogFixture(count);
  const target =
    native.rows.at(-1) ?? idleThread({ id: "uncached", source: "cli", ephemeral: false });
  let activeRows: CodexThread[] = native.rows;
  const stored = new Map<string, StoredCodexCatalogEntry>();
  const state: CodexCatalogState = {
    entries: async () => [...stored].map(([key, value]) => ({ key, value, createdAt: 0 })),
    register: async (key, value) => {
      stored.set(key, value);
    },
    delete: async (key) => stored.delete(key),
  };
  const factory = createCodexSessionCatalogControlFactory({
    getPluginConfig: () => ({
      supervision: { enabled: true },
      appServer: {
        transport: "websocket",
        url: "wss://exact-overflow.example.test/codex",
        authToken: "synthetic-exact-token",
      },
    }),
    getRuntimeConfig: () => config,
    openResidentState: () => state,
  });
  const home = (await factory.homesForAgent("main"))[0]!;
  expect(home.localSessionsRoot).toBeUndefined();
  const control = factory.forRequest("main", home);
  pinnedConnectionMocks.request.mockImplementation(async ({ method, requestParams }) => {
    if (method === "thread/read") {
      return { thread: target };
    }
    if (method === "thread/list") {
      expect(requestParams.archived).toBe(false);
      expect(requestParams.cwd).toBe(target.cwd);
      const offset = Number(requestParams.cursor ?? 0);
      const data = activeRows.slice(offset, offset + Number(requestParams.limit));
      const next = offset + data.length;
      return { data, ...(next < activeRows.length ? { nextCursor: String(next) } : {}) };
    }
    throw new Error(`Unexpected exact lookup request ${method}`);
  });
  await control.initialize();
  commandRpcMocks.codexControlRequest.mockClear();
  return {
    control,
    target,
    stored,
    clearActiveRows: () => {
      activeRows = [];
    },
    restoreActiveRows: () => {
      activeRows = [target];
    },
  };
}

describe("exact Codex lookup beyond resident retention", () => {
  it("opens an evicted remote thread after hydrating more than 20,000 rows", async () => {
    const f = await remoteFixture(20_001);
    const rows = [...f.stored.values()].flatMap((entry) =>
      entry.kind === "row" ? [entry.row] : [],
    );
    expect(rows).toHaveLength(20_000);
    expect(rows.some((row) => row.threadId === f.target.id)).toBe(false);

    await expect(f.control.requireEligibleThread(f.target.id)).resolves.toMatchObject({
      id: f.target.id,
    });

    expect(
      pinnedConnectionMocks.request.mock.calls.some(
        ([request]) => request.method === "thread/read",
      ),
    ).toBe(true);
    expect(
      pinnedConnectionMocks.request.mock.calls.some(
        ([request]) => request.method === "thread/list",
      ),
    ).toBe(true);
  });

  it.each([0, 1])(
    "requires native non-archived membership even when thread/read succeeds (cached rows: %i)",
    async (count) => {
      const f = await remoteFixture(count);
      expect(
        [...f.stored.values()].some(
          (entry) => entry.kind === "row" && entry.row.threadId === f.target.id,
        ),
      ).toBe(count === 1);
      f.clearActiveRows();
      await expect(f.control.requireEligibleThread(f.target.id)).rejects.toThrow(
        "eligibility could not be verified",
      );
    },
  );

  it("uses fresh native membership after a remote resident row was archived", async () => {
    const f = await remoteFixture(1);
    await f.control.archiveThread(f.target.id);
    f.restoreActiveRows();
    await expect(f.control.requireEligibleThread(f.target.id)).resolves.toMatchObject({
      id: f.target.id,
    });
  });

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
    const { runtime } = createRuntime({ invoke });

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
    const { runtime } = createRuntime({ invoke });
    await expect(
      lookupNodeCodexCatalogRecord({ agentId: "main", runtime, nodeId: "node", threadId: "older" }),
    ).rejects.toThrow("eligibility could not be verified");
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
