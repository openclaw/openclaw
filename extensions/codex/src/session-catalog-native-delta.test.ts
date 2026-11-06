import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CodexThread } from "./app-server/protocol.js";
import { catalogFactory, remoteCatalogFactory } from "./session-catalog-resident.test-support.js";
import type { CodexSessionCatalogSession } from "./session-catalog-types.js";
import { commandRpcMocks, idleThread } from "./session-catalog.test-helpers.js";

const rpc = commandRpcMocks.codexControlRequest;
const factories = new Set<ReturnType<typeof catalogFactory>>();
beforeEach(() => vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }));
afterEach(async () => {
  try {
    await Promise.all([...factories].map((factory) => factory.stop()));
  } finally {
    factories.clear();
    vi.useRealTimers();
  }
});
const thread = (id: string, fields: Partial<CodexThread> = {}) =>
  idleThread({ id, source: "cli", updatedAt: 100, recencyAt: 100, ...fields });

async function fixture(rows: () => CodexThread[], remote = true, pageSize?: number) {
  const lastPage = createDeferred<void>();
  rpc.mockImplementation(async (_plugin, method, params, options) => {
    expect(method).toBe("thread/list");
    if (params.useStateDbOnly) {
      expect(options).toHaveProperty("catalogPreview", true);
    }
    if (rpc.mock.calls.length > 1 && !pageSize) {
      expect(params.useStateDbOnly).toBe(true);
    }
    const native = rows();
    const offset = Number(params.cursor ?? 0);
    const data = pageSize ? native.slice(offset, offset + pageSize) : native;
    const nextCursor = offset + data.length < native.length ? String(offset + data.length) : null;
    if (params.useStateDbOnly && nextCursor === null) {
      lastPage.resolve();
    }
    return { data, nextCursor };
  });
  const factory = remote ? remoteCatalogFactory("native-delta") : catalogFactory();
  factories.add(factory);
  const source = (await factory.homesForAgent("main"))[0]!;
  const control = factory.forRequest("main", source);
  const idle = () => vi.waitFor(() => expect(factory.hasActiveWork()).toBe(false));
  const refresh = async (check: (sessions: CodexSessionCatalogSession[]) => void) => {
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () => check((await control.listPage({})).sessions));
  };
  return { control, source, idle, refresh, lastPage, stop: () => factory.stop() };
}

it("reconciles remote membership without reparsing unchanged visible or hidden previews", async () => {
  const known = thread("known", {
    name: "Previous title",
    preview: "Known request",
    path: "/remote/sessions/known.jsonl",
    status: { type: "active", activeFlags: ["waitingOnApproval"] },
  });
  const changed = thread("changed", { name: null, preview: "Previous request" });
  const hidden = thread("hidden", { source: "exec", preview: "Hidden native execution" });
  let native = [known, changed, idleThread({ id: "removed", source: "cli" }), hidden];
  const f = await fixture(() => native);
  expect(f.source.localSessionsRoot).toBeUndefined();
  await f.control.initialize();
  const initial = await f.control.listPage({});
  expect(initial.sessions.map((row) => row.threadId).toSorted()).toEqual([
    "changed",
    "known",
    "removed",
  ]);
  expect(rpc).toHaveBeenCalledOnce();
  const sanitize = vi.spyOn(terminalText, "sanitizeTerminalText");
  Object.assign(known, { name: null, status: { type: "idle" }, path: `${known.path}.zst` });
  Object.assign(changed, { preview: "Changed user request", updatedAt: 200, recencyAt: 200 });
  const created = thread("created", {
    name: null,
    preview: "New independent native task",
    updatedAt: 300,
    recencyAt: 300,
  });
  native = [created, changed, known, hidden];
  expect(await f.control.listPage({})).toEqual(initial);
  expect(rpc).toHaveBeenCalledOnce();
  await f.refresh((sessions) => {
    expect(sessions.toSorted((a, b) => a.threadId.localeCompare(b.threadId))).toMatchObject([
      { threadId: "changed", fallbackName: "Changed user request" },
      { threadId: "created", fallbackName: "New independent native task" },
      {
        threadId: "known",
        name: null,
        fallbackName: "Known request",
        status: "idle",
      },
    ]);
    expect(sessions.find((row) => row.threadId === "known")).not.toHaveProperty("activeFlags");
  });
  expect(rpc).toHaveBeenCalledTimes(2);
  expect(rpc.mock.calls[1]?.[2]).toMatchObject({ useStateDbOnly: true });
  expect(sanitize.mock.calls.map(([value]) => value)).not.toContain("Known request");
  expect(sanitize.mock.calls.map(([value]) => value)).not.toContain("Hidden native execution");
  await f.idle();
  sanitize.mockClear();
  const renamed = "Offline title ".repeat(60).trim();
  known.name = renamed;
  await f.refresh((sessions) =>
    expect(sessions.find((row) => row.threadId === known.id)?.name).toBe(renamed.slice(0, 500)),
  );
  expect(rpc).toHaveBeenCalledTimes(3);
  expect(sanitize).not.toHaveBeenCalled();
});

it("walks remote pages beyond the resident bound without projecting the uncached tail", async () => {
  const native = Array.from({ length: 20_001 }, (_, i) =>
    thread(`bounded-thread-${i}`, {
      source: i === 20_000 ? "exec" : "cli",
      preview: `Synthetic first user request ${i}`,
    }),
  );
  const f = await fixture(() => native, true, 64);
  const tailPreview = vi.fn(() => {
    throw new Error("Uncached native tail must not be projected on each refresh");
  });
  await f.control.initialize();
  const first = await f.control.listPage({ limit: 64 });
  expect(first.sessions.map((row) => row.threadId)).toEqual(
    native.slice(0, 64).map((row) => row.id),
  );
  const pages = Math.ceil(native.length / 64);
  expect(rpc).toHaveBeenCalledTimes(pages);
  Object.defineProperty(native[20_000]!, "preview", { get: tailPreview });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  expect(rpc).toHaveBeenCalledTimes(pages);
  await f.control.listPage({ cwd: "/workspace/project", limit: 64 });
  expect(rpc).toHaveBeenCalledTimes(pages + 1);
  await f.control.listPage({ limit: 64 });
  await f.lastPage.promise;
  const refreshed = await f.control.listPage({ limit: 64 });
  await f.stop();
  expect(refreshed).toEqual(first);
  expect(rpc).toHaveBeenCalledTimes(pages * 2 + 1);
  expect(tailPreview).not.toHaveBeenCalled();
});

it("reconciles displayed native metadata and explicit Git clears without activity or file changes", async () => {
  const native = thread("metadata", {
    createdAt: 10,
    sessionId: "previous-session",
    cliVersion: "0.154.0",
    gitInfo: { branch: "previous-branch" },
  });
  const f = await fixture(() => [native], false);
  await f.control.initialize();
  expect((await f.control.listPage({})).sessions[0]).toMatchObject({
    gitBranch: "previous-branch",
  });
  const changes = {
    cliVersion: "0.155.0",
    modelProvider: "updated-provider",
    createdAt: 20,
    sessionId: "current-session",
    source: "vscode" as const,
  };
  Object.assign(native, changes, { gitInfo: { branch: "updated-branch" } });
  await f.refresh((sessions) =>
    expect(sessions[0]).toMatchObject({
      ...changes,
      gitBranch: "updated-branch",
      updatedAt: 100,
      recencyAt: 100,
    }),
  );
  Object.assign(native, { gitInfo: null });
  await f.idle();
  await f.refresh((sessions) => expect(sessions[0]).not.toHaveProperty("gitBranch"));
  expect(rpc).toHaveBeenCalledTimes(3);
});
