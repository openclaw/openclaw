import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThreadListParams } from "./app-server/protocol.js";
import { memoryCatalogState } from "./session-catalog-index.test-support.js";
import { lookupNodeCodexCatalogRecord } from "./session-catalog-node-lookup.js";
import { NODE_INVOKE_TIMEOUT_MS } from "./session-catalog-parsing.js";
import { remoteCatalogFactory } from "./session-catalog-resident.test-support.js";
import type { CodexSessionCatalogPageParams } from "./session-catalog-types.js";
import {
  commandRpcMocks,
  createRuntime,
  idleThread,
  pinnedConnectionMocks,
} from "./session-catalog.test-helpers.js";

afterEach(() => vi.restoreAllMocks());

function fixture(total: number, splitWorkspaces = true) {
  const native = Array.from({ length: total }, (_, index) =>
    idleThread({
      id: `thread-${index}`,
      name: `${index >= 20_000 ? "Older" : "Recent"} investigation ${index}${index === 0 || index === total - 1 ? " sparse" : ""}`,
      cwd: splitWorkspaces && index >= 20_000 ? "/workspace/older" : "/workspace/recent",
      source: "cli",
      originator: "codex_cli_rs",
      preview: `Please investigate task ${index} and verify the result.`,
      recencyAt: total - index,
      updatedAt: total - index,
    }),
  );
  const { values, state } = memoryCatalogState({ clone: true });
  const calls: CodexThreadListParams[] = [];
  const read = (params: CodexThreadListParams) => {
    calls.push(params);
    const backwards = params.sortDirection === "asc";
    const anchor = params.cursor === undefined ? undefined : Number(params.cursor);
    const matching = native.filter(
      (thread, index) =>
        (!params.cwd || thread.cwd === params.cwd) &&
        (!params.searchTerm ||
          thread.name?.toLowerCase().includes(params.searchTerm.toLowerCase())) &&
        (anchor === undefined || (backwards ? index < anchor : index > anchor)),
    );
    if (backwards) {
      matching.reverse();
    }
    const data = matching.slice(0, params.limit ?? undefined);
    const position = (id: string) => id.slice("thread-".length);
    return {
      data,
      nextCursor: data.length < matching.length ? position(data.at(-1)!.id) : null,
      backwardsCursor: data[0] ? position(data[0].id) : null,
    };
  };
  commandRpcMocks.codexControlRequest.mockImplementation(async (_plugin, method, params) => {
    if (method === "thread/archive") {
      return {};
    }
    expect(method).toBe("thread/list");
    return read(params);
  });
  const make = async () => {
    const factory = remoteCatalogFactory("overflow", { openResidentState: () => state });
    const home = (await factory.homesForAgent("main"))[0]!;
    return { factory, control: factory.forRequest("main", home) };
  };
  return { native, values, calls, make, read };
}

it("keeps paging and searching older native rows beyond the retained window after restart", async () => {
  const { native, values, calls, make } = fixture(20_003);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const initial = await make();
    await initial.control.initialize();
    expect([...values.values()].filter((entry) => entry.kind === "row")).toHaveLength(20_000);
    await initial.factory.stop();
    const { control } = await make();
    const list = (query: CodexSessionCatalogPageParams = {}) =>
      control.listPage({ limit: 40, ...query });
    const before = calls.length;
    let page = await list();
    expect(calls).toHaveLength(before);
    expect(page.sessions.map((row) => row.threadId)).toEqual(
      native.slice(0, 40).map((row) => row.id),
    );
    const ids = page.sessions.map((row) => row.threadId);
    while (page.nextCursor) {
      page = await list({ cursor: page.nextCursor });
      ids.push(...page.sessions.map((row) => row.threadId));
    }
    expect(ids).toEqual(native.map((thread) => thread.id));
    expect(page.backwardsCursor).toEqual(expect.any(String));
    const previous = await list({ cursor: page.backwardsCursor });
    const again = await list({ cursor: previous.nextCursor });
    expect(again.sessions).toEqual(page.sessions);
    const expected = native.slice(20_000).map((thread) => thread.id);
    let searched = await list({ searchTerm: "older investigation" });
    expect(searched.nextCursor).toEqual(expect.any(String));
    while (!searched.sessions.length && searched.nextCursor) {
      searched = await list({
        searchTerm: "older investigation",
        cursor: searched.nextCursor,
      });
    }
    const scoped = await list({ cwd: "/workspace/older" });
    expect(searched.sessions.map((row) => row.threadId)).toEqual(expected);
    expect(scoped.sessions.map((row) => row.threadId)).toEqual(expected);
    let sparse = await list({ searchTerm: "sparse" });
    expect(sparse.sessions.map((row) => row.threadId)).toEqual([native[0]!.id]);
    while (sparse.nextCursor) {
      sparse = await list({ searchTerm: "sparse", cursor: sparse.nextCursor });
    }
    expect(sparse.sessions.map((row) => row.threadId)).toEqual([native.at(-1)!.id]);
    let newer = await list({ searchTerm: "sparse", cursor: sparse.backwardsCursor });
    expect(newer.sessions).toEqual([]);
    expect(newer.backwardsCursor).toEqual(expect.any(String));
    expect(newer.nextCursor).toBeUndefined();
    while (!newer.sessions.length && newer.backwardsCursor) {
      newer = await list({ searchTerm: "sparse", cursor: newer.backwardsCursor });
    }
    expect(newer.sessions.map((row) => row.threadId)).toEqual([native[0]!.id]);
    expect(calls.slice(before).every((request) => request.useStateDbOnly === true)).toBe(true);
    expect([...values.values()].filter((entry) => entry.kind === "row")).toHaveLength(20_000);
    await expect(
      control.listPage({ searchTerm: "different", cursor: previous.nextCursor }),
    ).rejects.toThrow(/cursor/);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["evicted", "archived"])("checks fresh remote membership for %s rows", async (kind) => {
  const { native, values, make, read } = fixture(kind === "evicted" ? 20_001 : 1, false);
  const target = native.at(-1)!;
  const { factory, control } = await make();
  pinnedConnectionMocks.request.mockImplementation(async ({ method, requestParams }) => {
    if (method === "thread/read") {
      return { thread: target };
    }
    if (method === "thread/list") {
      expect(requestParams).toMatchObject({ archived: false, cwd: target.cwd });
      return read(requestParams);
    }
    throw new Error(`Unexpected exact lookup request ${method}`);
  });
  try {
    await control.initialize();
    const rows = [...values.values()].flatMap((entry) => (entry.kind === "row" ? [entry.row] : []));
    expect(rows).toHaveLength(kind === "evicted" ? 20_000 : 1);
    expect(rows.some((row) => row.threadId === target.id)).toBe(kind !== "evicted");
    if (kind === "archived") {
      await control.archiveThread(target.id);
    }
    await expect(control.requireEligibleThread(target.id)).resolves.toMatchObject({
      id: target.id,
    });
  } finally {
    await factory.stop();
  }
});

const lookup = (
  invoke: NonNullable<NonNullable<Parameters<typeof createRuntime>[0]>["invoke"]>,
  threadId = "older",
) =>
  lookupNodeCodexCatalogRecord({
    agentId: "main",
    runtime: createRuntime({ invoke }).runtime,
    nodeId: "node",
    threadId,
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
  await expect(lookup(invoke, record.threadId)).resolves.toEqual({ kind: "found", record });
});

it("keeps one node lookup deadline across advancing pages", async () => {
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const invoke = vi.fn(async () => {
    elapsed += NODE_INVOKE_TIMEOUT_MS / 2 + 1;
    return { payloadJSON: JSON.stringify({ sessions: [], nextCursor: String(elapsed) }) };
  });
  await expect(lookup(invoke)).rejects.toThrow("eligibility could not be verified");
  expect(invoke).toHaveBeenCalledTimes(2);
});
