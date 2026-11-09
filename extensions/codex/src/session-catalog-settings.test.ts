import { setImmediate as nextTurn } from "node:timers/promises";
import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { threadStartResult } from "./app-server/codex-app-server.test-fixtures.js";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { resumeCodexAppServerThread } from "./app-server/thread-resume.js";
import {
  catalogClient,
  catalogIndex,
  catalogThread,
} from "./session-catalog-client.test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
  subscribeCodexCatalogEvents,
} from "./session-catalog-events.js";
import type { CodexCatalogIndex } from "./session-catalog-index.js";
import {
  catalogRow,
  catalogWebSocketOptions,
  completeCatalogState,
} from "./session-catalog-index.test-support.js";
import {
  canReuseCodexCatalogPreview,
  projectCodexCatalogDeltaPage,
  projectCodexCatalogPage,
} from "./session-catalog-projection.js";
import { projectNativeCatalogFixture } from "./session-catalog-projection.test-support.js";
import type { CodexSessionCatalogPageParams } from "./session-catalog-types.js";

let fixtureId = 0;
const persisted = { cwd: "/workspace/persisted", modelProvider: "openai" };
const runtime = { cwd: "/workspace/runtime", modelProvider: "runtime-provider" };
const live = { cwd: "/workspace/live", modelProvider: "live-provider" };

function nativeThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    ...threadStartResult().thread,
    ...catalogThread(persisted),
    status: { type: "idle" },
    source: "cli",
    ...overrides,
  };
}

async function fixture(overflow = false, evicted = false, source = false) {
  const options = catalogWebSocketOptions(
    `wss://catalog-settings-${++fixtureId}.example.test/codex`,
  );
  const inventory = source
    ? [catalogThread({ cwd: "/workspace/original" })]
    : [
        nativeThread({ recencyAt: evicted ? 0 : 100 }),
        nativeThread({ id: "other", recencyAt: 200 }),
      ];
  if (overflow) {
    for (let i = inventory.length; i < 20_001; i++) {
      inventory.push(nativeThread({ id: `stored-${i}`, recencyAt: 1 }));
    }
  }
  const respond = ({ method, params }: { method: string; params: CodexThreadListParams }) => {
    if (source) {
      return method === "thread/list" ? { data: inventory } : undefined;
    }
    if (method === "thread/resume") {
      return { ...threadStartResult(), thread: inventory[0]!, ...runtime };
    }
    if (method !== "thread/list") {
      return undefined;
    }
    const ordered = overflow
      ? inventory.toSorted((left, right) => (right.recencyAt ?? 0) - (left.recencyAt ?? 0))
      : inventory;
    const matching = ordered.filter((thread) => !params.cwd || thread.cwd === params.cwd);
    const offset = Number(params.cursor ?? 0);
    const data = matching.slice(offset, offset + (params.limit ?? 0));
    return {
      data,
      nextCursor: offset + data.length < matching.length ? String(offset + data.length) : undefined,
    };
  };
  const a = catalogClient(respond);
  const b = catalogClient(source ? undefined : respond);
  // Worker startup is fixture setup, outside the live-settings request deadline.
  const reader = overflow ? b.client : a.client;
  if (!source) {
    await reader.request("thread/list", { limit: 1 }, { catalogPreview: true });
  }
  await observeCodexCatalogClient(a.client, { startOptions: options });
  await observeCodexCatalogClient(b.client, { startOptions: options });
  const homeId = await codexCatalogResidentHomeKey({ startOptions: options });
  const index = catalogIndex({
    homeId,
    readNative: async (params: CodexThreadListParams) =>
      projectNativeCatalogFixture(
        // Overflow queries still have a native reader after the live settings source closes.
        await reader.request("thread/list", params, {
          catalogPreview: true,
          ...(source ? { timeoutMs: 1_000 } : {}),
        }),
      ),
  });
  await index.initialize();
  const abandonClient = vi.fn(async () => {});
  const resume = () =>
    resumeCodexAppServerThread({
      client: a.client,
      abandonClient,
      request: { threadId: "thread-1", excludeTurns: true },
      timeoutMs: 1_000,
    });
  const sessions = async (cwd?: string) => (await index.list({ cwd })).sessions;
  const session = async (cwd?: string) => {
    let cursor: string | undefined;
    do {
      const page = await index.list({ cwd, cursor });
      const found = page.sessions.find((row) => row.threadId === "thread-1");
      if (found || !page.nextCursor) {
        return found;
      }
      cursor = page.nextCursor;
    } while (cursor);
    return undefined;
  };
  return { a, b, index, inventory, homeId, resume, abandonClient, sessions, session };
}

it.each([false, true])(
  "keeps acknowledged resume settings authoritative (overflow=%s)",
  async (overflow) => {
    const { a, index, inventory, resume, abandonClient, sessions, session } = await fixture(
      overflow,
      overflow,
    );
    if (overflow) {
      expect(index.get("thread-1")).toBeUndefined();
    }
    await resume();
    expect(await session(runtime.cwd)).toMatchObject({ threadId: "thread-1", ...runtime });
    expect(await session(persisted.cwd)).toBeUndefined();
    if (!overflow) {
      inventory[0]!.updatedAt = 300;
      await index.upsertThread(inventory[0]!);
      expect((await sessions(runtime.cwd))[0]).toMatchObject(runtime);
    }
    a.client.close();
    expect(await sessions(runtime.cwd)).toEqual([]);
    expect(await session(persisted.cwd)).toMatchObject({ threadId: "thread-1", ...persisted });
    expect(abandonClient).not.toHaveBeenCalled();
  },
);

it("keeps another connection's active status on overflow pages until it closes", async () => {
  const { a, inventory, session } = await fixture(true);
  inventory[0]!.status = { type: "notLoaded" };
  active(a, "waitingOnApproval");
  const expected = { status: "active", activeFlags: ["waitingOnApproval"] };
  expect(await session()).toMatchObject(expected);
  expect(await session("/workspace/persisted")).toMatchObject(expected);
  a.client.close();
  const closed = await session("/workspace/persisted");
  expect([closed?.status, closed?.activeFlags]).toEqual(["notLoaded", undefined]);
});

it("keeps a successful resume subscribed when a catalog observer fails", async () => {
  const { a, homeId, resume, abandonClient } = await fixture();
  const observer = vi.fn(async () => {
    throw new Error("catalog observer failed");
  });
  onTestFinished(subscribeCodexCatalogEvents(homeId, () => {}, { onResume: observer }));
  await expect(resume()).resolves.toMatchObject({ thread: { id: "thread-1" }, cwd: runtime.cwd });
  expect(observer).toHaveBeenCalledOnce();
  expect(abandonClient).not.toHaveBeenCalled();
  expect(a.client.getCloseError()).toBeUndefined();
});

it.each(["thread/status/changed", "thread/archived", "thread/deleted"])(
  "withdraws live settings on %s without leaking them into native metadata",
  async (method) => {
    const { a, b, index, inventory, sessions, session } = await fixture();
    const unloaded = method === "thread/status/changed";
    const event = {
      method,
      params: { threadId: "thread-1", ...(unloaded ? { status: { type: "notLoaded" } } : {}) },
    };
    a.send({
      method: "thread/settings/updated",
      params: { threadId: "thread-1", threadSettings: live },
    });
    expect(await sessions(live.cwd)).toEqual([expect.objectContaining({ threadId: "thread-1" })]);
    if (unloaded) {
      b.send(event);
      expect((await sessions(live.cwd))[0]?.threadId).toBe("thread-1");
    }
    a.send(event);
    expect(await sessions(live.cwd)).toEqual([]);
    if (!unloaded) {
      await index.upsertThread(inventory[0]!);
      expect(await sessions(live.cwd)).toEqual([]);
    }
    expect(await session()).toMatchObject(persisted);
    if (unloaded) {
      expect(a.client.getCloseError()).toBeUndefined();
    }
  },
);

const ids = async (index: CodexCatalogIndex, params: CodexSessionCatalogPageParams = {}) =>
  (await index.list(params)).sessions.map((row) => row.threadId);
const session = async (index: CodexCatalogIndex) => (await index.list({})).sessions[0];
const sourceB = { status: "active", activeFlags: ["source-b"] };
const active = (harness: ReturnType<typeof catalogClient>, flag: string) =>
  harness.send({
    method: "thread/status/changed",
    params: {
      threadId: "thread-1",
      status: { type: "active", activeFlags: [flag] },
    },
  });
function sourceFixture(date = false) {
  const timers = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;
  vi.useFakeTimers({ toFake: date ? [...timers, "Date"] : [...timers] });
  return fixture(false, false, true);
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("ignores a buffered thread/read status after its source closes", async () => {
  const { a, b, index } = await sourceFixture();
  const reading = a.client.request<{ thread: CodexThread }>(
    "thread/read",
    { threadId: "thread-1" },
    { timeoutMs: 1_000 },
  );
  const request = JSON.parse(await a.waitForWrite(1));
  const native = catalogThread({ status: { type: "active", activeFlags: ["stale-source-a"] } });
  a.send({ id: request.id, result: { thread: native } });
  a.client.close();
  active(b, "source-b");
  await index.upsertThread((await reading).thread);
  expect(await session(index)).toMatchObject(sourceB);
  expect(JSON.stringify(index.get("thread-1"))).not.toContain('"closed"');
});

it("keeps another source active when a DB-only list reports source-local notLoaded", async () => {
  const { b, index, inventory } = await sourceFixture(true);
  active(b, "source-b");
  inventory[0] = catalogThread({ cwd: "/workspace/fresh", status: { type: "notLoaded" } });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  await index.list({});
  await vi.waitFor(async () => expect((await session(index))?.cwd).toBe("/workspace/fresh"));
  await nextTurn();
  expect(await session(index)).toMatchObject(sourceB);
});

it("finishes reconnect hydration after an offline snapshot refresh and resumes periodic currency", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const startOptions = catalogWebSocketOptions("wss://catalog-recovery.example.test/codex");
  const original = catalogClient();
  const replacement = catalogClient();
  const offline = new Error("remote connection unavailable");
  const readNative = vi
    .fn()
    .mockRejectedValueOnce(offline)
    .mockResolvedValue({ rows: [catalogRow("reconnected")] });
  const index = catalogIndex({
    homeId: await codexCatalogResidentHomeKey({ startOptions }),
    readNative,
    state: completeCatalogState([catalogRow("saved")]),
  });
  await observeCodexCatalogClient(original.client, { startOptions });
  await expect(index.initialize()).rejects.toBe(offline);
  original.client.close();
  await observeCodexCatalogClient(replacement.client, { startOptions });
  await index.initialize();
  expect(await ids(index)).toEqual(["reconnected"]);
  readNative.mockResolvedValue({ rows: [catalogRow("later")] });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  await vi.waitFor(async () => expect(await ids(index)).toEqual(["later"]));
});

it.each([300, 200])(
  "keeps the backward boundary when its anchor moves to recency %s",
  async (recencyAt) => {
    const threads = ["alpha", "bravo", "charlie"].map((id, position) =>
      catalogThread({
        id,
        name: id,
        originator: "codex_cli_rs",
        recencyAt: position < 2 ? 200 : 100,
      }),
    );
    const startOptions = catalogWebSocketOptions(`wss://cursor-${recencyAt}.example.test/codex`);
    const harness = catalogClient(() => ({ thread: { ...threads[1], recencyAt } }));
    const index = catalogIndex({
      homeId: await codexCatalogResidentHomeKey({ startOptions }),
      readNative: async () => projectNativeCatalogFixture({ data: threads }),
    });
    await observeCodexCatalogClient(harness.client, { startOptions });
    await index.initialize();
    const first = await index.list({ limit: 1 });
    const second = await index.list({ limit: 1, cursor: first.nextCursor });
    harness.send({
      method: "turn/started",
      params: { threadId: "bravo", turn: { id: "new-turn", startedAt: recencyAt, items: [] } },
    });
    await vi.waitFor(async () => expect(await ids(index, { limit: 1 })).toEqual(["bravo"]));
    expect(await ids(index, { limit: 1, cursor: second.backwardsCursor })).toEqual(["alpha"]);
    expect(await ids(index, { limit: 64, cursor: second.backwardsCursor })).toEqual(["alpha"]);
    expect(await ids(index, { limit: 1, cursor: second.nextCursor })).toEqual(["charlie"]);
  },
);

it.each([
  ["", "First user request"],
  ["Previous first user request", ""],
])(
  "observes native preview transition %j to %j within one timestamp second",
  async (before, after) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const thread = catalogThread({ name: null, originator: "codex_cli_rs", preview: before });
    const requests: CodexThreadListParams[] = [];
    const harness = catalogClient((request) => {
      requests.push(request.params);
      return { data: [thread] };
    });
    const index = catalogIndex({
      homeId: "preview-transitions",
      readNative: async (params) => {
        const response = await harness.client.request("thread/list", params, {
          catalogPreview: true,
          catalogPreviewCache: params.useStateDbOnly
            ? (candidate) => {
                const row = index.get(candidate.id);
                return canReuseCodexCatalogPreview(row, candidate) ? row?.preview : undefined;
              }
            : undefined,
        });
        return params.useStateDbOnly
          ? projectCodexCatalogDeltaPage(response, { getRow: (id) => index.get(id) })
          : projectCodexCatalogPage(response);
      },
    });
    await index.initialize();
    expect((await session(index))?.fallbackName).toBe(before || undefined);
    thread.preview = after;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () =>
      expect((await session(index))?.fallbackName).toBe(after || undefined),
    );
    expect(index.get(thread.id)?.preview).toBe(after);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ useStateDbOnly: true });
    await vi.waitFor(() => expect(index.hasActiveWork()).toBe(false));
    const sanitize = vi.spyOn(terminalText, "sanitizeTerminalText");
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(requests).toHaveLength(2);
    await index.list({});
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    expect((await session(index))?.fallbackName).toBe(after || undefined);
    expect(sanitize).not.toHaveBeenCalled();
  },
);
