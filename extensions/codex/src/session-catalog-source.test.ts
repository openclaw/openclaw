import { setImmediate as nextTurn } from "node:timers/promises";
import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { afterEach, expect, it, vi } from "vitest";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import {
  catalogClient as createTrackedClient,
  catalogIndex as catalog,
  catalogThread as sourceThread,
} from "./session-catalog-client.test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
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

const ids = async (index: CodexCatalogIndex, params: CodexSessionCatalogPageParams = {}) =>
  (await index.list(params)).sessions.map((row) => row.threadId);
let fixtureId = 0;
const sourceB = { status: "active", activeFlags: ["source-b"] };

async function fixture(date = false) {
  const timers = ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] as const;
  vi.useFakeTimers({ toFake: date ? [...timers, "Date"] : [...timers] });
  const options = catalogWebSocketOptions(`wss://catalog-source-${++fixtureId}.example.test/codex`);
  const inventory = [sourceThread({ cwd: "/workspace/original" })];
  const a = createTrackedClient(({ method }) =>
    method === "thread/list" ? { data: inventory } : undefined,
  );
  const b = createTrackedClient();
  await observeCodexCatalogClient(a.client, { startOptions: options });
  await observeCodexCatalogClient(b.client, { startOptions: options });
  const readNative = vi.fn(async (params: CodexThreadListParams) =>
    projectNativeCatalogFixture(
      await a.client.request("thread/list", params, { timeoutMs: 1_000, catalogPreview: true }),
    ),
  );
  const index = catalog({
    homeId: await codexCatalogResidentHomeKey({ startOptions: options }),
    readNative,
  });
  await index.initialize();
  const active = (harness: ReturnType<typeof createTrackedClient>, flag: string) =>
    harness.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active", activeFlags: [flag] } },
    });
  return { a, b, index, inventory, readNative, active };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("ignores a buffered thread/read status after its source closes", async () => {
  const { a, b, index, active } = await fixture();
  const reading = a.client.request<{ thread: CodexThread }>(
    "thread/read",
    { threadId: "thread-1" },
    { timeoutMs: 1_000 },
  );
  const request = JSON.parse(await a.waitForWrite(1));
  const native = sourceThread({ status: { type: "active", activeFlags: ["stale-source-a"] } });
  a.send({ id: request.id, result: { thread: native } });
  a.client.close();
  active(b, "source-b");
  const response = await reading;
  expect(response.thread).toEqual(native);
  await index.upsertThread(response.thread);
  expect((await index.list({})).sessions[0]).toMatchObject(sourceB);
  expect(JSON.stringify(index.get("thread-1"))).not.toContain('"closed"');
});

it("keeps another source active when a DB-only list reports source-local notLoaded", async () => {
  const { b, index, inventory, readNative, active } = await fixture(true);
  active(b, "source-b");
  inventory[0] = sourceThread({ cwd: "/workspace/fresh", status: { type: "notLoaded" } });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  await index.list({});
  await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(2));
  await readNative.mock.results[1]!.value;
  await vi.waitFor(async () =>
    expect((await index.list({})).sessions[0]?.cwd).toBe("/workspace/fresh"),
  );
  await nextTurn();
  expect((await index.list({})).sessions[0]).toMatchObject(sourceB);
  expect(readNative).toHaveBeenCalledTimes(2);
  expect(readNative.mock.calls[1]?.[0]).toMatchObject({ useStateDbOnly: true });
});

it("finishes reconnect hydration after an offline snapshot refresh and resumes periodic currency", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const startOptions = catalogWebSocketOptions("wss://catalog-recovery.example.test/codex");
  const original = createTrackedClient();
  const replacement = createTrackedClient();
  const offline = new Error("remote connection unavailable");
  const readNative = vi
    .fn()
    .mockRejectedValueOnce(offline)
    .mockResolvedValue({ rows: [catalogRow("reconnected")] });
  const index = catalog({
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
    const threads: CodexThread[] = ["alpha", "bravo", "charlie"].map((id, position) => ({
      id,
      projectId: null,
      name: id,
      source: "cli",
      originator: "codex_cli_rs",
      recencyAt: position < 2 ? 200 : 100,
    }));
    const startOptions = catalogWebSocketOptions(`wss://cursor-${recencyAt}.example.test/codex`);
    const harness = createTrackedClient((request) => {
      expect(request).toMatchObject({ method: "thread/read", params: { threadId: "bravo" } });
      return { thread: { ...threads[1], recencyAt } };
    });
    const readNative = vi.fn(async () => projectNativeCatalogFixture({ data: threads }));
    const index = catalog({
      homeId: await codexCatalogResidentHomeKey({ startOptions }),
      readNative,
    });
    await observeCodexCatalogClient(harness.client, { startOptions });
    await index.initialize();
    const first = await index.list({ limit: 1 });
    const second = await index.list({ limit: 1, cursor: first.nextCursor });
    expect(first.sessions.map((row) => row.threadId)).toEqual(["alpha"]);
    expect(second.sessions.map((row) => row.threadId)).toEqual(["bravo"]);
    expect(second.backwardsCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toEqual(expect.any(String));
    harness.send({
      method: "turn/started",
      params: {
        threadId: "bravo",
        turn: { id: "new-turn", startedAt: recencyAt, items: [] },
      },
    });
    await vi.waitFor(async () =>
      expect((await index.list({ limit: 1 })).sessions[0]?.threadId).toBe("bravo"),
    );
    expect(await ids(index, { limit: 1, cursor: second.backwardsCursor })).toEqual(["alpha"]);
    expect(await ids(index, { limit: 64, cursor: second.backwardsCursor })).toEqual(["alpha"]);
    expect(await ids(index, { limit: 1, cursor: second.nextCursor })).toEqual(["charlie"]);
    expect(readNative).toHaveBeenCalledOnce();
    expect(harness.writes).toHaveLength(1);
  },
);

it.each([
  ["", "First user request"],
  ["Previous first user request", ""],
])(
  "observes native preview transition %j to %j within one timestamp second",
  async (before, after) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const thread = sourceThread({
      name: null,
      originator: "codex_cli_rs",
      preview: before,
    });
    const requests: CodexThreadListParams[] = [];
    const harness = createTrackedClient((request) => {
      expect(request.method).toBe("thread/list");
      requests.push(request.params);
      return { data: [thread] };
    });
    const index = catalog({
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
    expect((await index.list({})).sessions[0]?.fallbackName).toBe(before || undefined);
    thread.preview = after;
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await vi.waitFor(async () =>
      expect((await index.list({})).sessions[0]?.fallbackName).toBe(after || undefined),
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
    expect((await index.list({})).sessions[0]?.fallbackName).toBe(after || undefined);
    expect(sanitize).not.toHaveBeenCalled();
  },
);
