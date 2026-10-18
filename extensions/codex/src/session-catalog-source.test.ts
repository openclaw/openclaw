import { setImmediate as nextTurn } from "node:timers/promises";
import * as terminalText from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexThread, CodexThreadListParams } from "./app-server/protocol.js";
import { createClientHarness } from "./app-server/test-support.js";
import {
  codexCatalogResidentHomeKey,
  observeCodexCatalogClient,
} from "./session-catalog-events.js";
import type { CodexCatalogIndexOptions } from "./session-catalog-index-contract.js";
import { CodexCatalogIndex } from "./session-catalog-index.js";
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

const indexes: CodexCatalogIndex[] = [];
const clients: ReturnType<typeof createClientHarness>[] = [];
function createTrackedClient(options?: Parameters<typeof createClientHarness>[0]) {
  const harness = createClientHarness(options);
  clients.push(harness);
  return harness;
}
function catalog(options: Omit<CodexCatalogIndexOptions, "assertCurrent">) {
  const index = new CodexCatalogIndex({ ...options, assertCurrent: () => {} });
  indexes.push(index);
  return index;
}
let fixtureId = 0;

function sourceThread(overrides: Partial<CodexThread> = {}): CodexThread {
  return {
    id: "thread-1",
    projectId: null,
    name: "Native thread",
    preview: "First user request",
    source: "cli",
    cwd: "/workspace/original",
    updatedAt: 100,
    recencyAt: 100,
    status: { type: "idle" },
    ...overrides,
  };
}

async function fixture() {
  const options = {
    ...catalogWebSocketOptions(`wss://catalog-source-${++fixtureId}.example.test/codex`),
    authToken: "synthetic-catalog-source-token",
  };
  const inventory = [sourceThread()];
  const a = createTrackedClient({
    onWrite(line, send) {
      const request = JSON.parse(line);
      if (request.method === "thread/list") {
        send({ id: request.id, result: { data: inventory } });
      }
    },
  });
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
  const active = (harness: ReturnType<typeof createClientHarness>, flag: string) =>
    harness.send({
      method: "thread/status/changed",
      params: { threadId: "thread-1", status: { type: "active", activeFlags: [flag] } },
    });
  return { a, b, index, inventory, readNative, active };
}

afterEach(async () => {
  for (const { client } of clients) {
    client.close();
  }
  await Promise.all([
    ...indexes.splice(0).map((index) => index.close()),
    ...clients.splice(0).map(({ client }) => client.closeAndWait()),
  ]);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Codex catalog physical status sources", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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
    a.send({
      id: request.id,
      result: { thread: native },
    });
    a.client.close();
    active(b, "source-b");
    const response = await reading;
    expect(response.thread).toEqual(native);
    await index.upsertThread(response.thread);
    expect((await index.list({})).sessions[0]).toMatchObject({
      status: "active",
      activeFlags: ["source-b"],
    });
    expect(JSON.stringify(index.get("thread-1"))).not.toContain('"closed"');
  });

  it("keeps another source active when a DB-only list reports source-local notLoaded", async () => {
    vi.useFakeTimers({
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const { b, index, inventory, readNative, active } = await fixture();
    active(b, "source-b");
    inventory[0] = sourceThread({ cwd: "/workspace/fresh", status: { type: "notLoaded" } });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await index.list({});
    await vi.waitFor(() => expect(readNative).toHaveBeenCalledTimes(2));
    await readNative.mock.results[1]!.value;
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]?.cwd).toBe("/workspace/fresh");
    });
    await nextTurn();
    expect((await index.list({})).sessions[0]).toMatchObject({
      status: "active",
      activeFlags: ["source-b"],
    });
    expect(readNative).toHaveBeenCalledTimes(2);
    expect(readNative.mock.calls[1]?.[0]).toMatchObject({ useStateDbOnly: true });
  });
});

it("finishes reconnect hydration after an offline snapshot refresh and resumes periodic currency", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  const startOptions = catalogWebSocketOptions("wss://catalog-recovery.example.test/codex");
  const original = createTrackedClient();
  const replacement = createTrackedClient();
  const row = (threadId: string) => catalogRow(threadId, 100, { name: threadId });
  const offline = new Error("remote connection unavailable");
  const readNative = vi
    .fn()
    .mockRejectedValueOnce(offline)
    .mockResolvedValue({ rows: [row("reconnected")] });
  const index = catalog({
    homeId: await codexCatalogResidentHomeKey({ startOptions }),
    readNative,
    state: completeCatalogState([row("saved")]),
  });
  await observeCodexCatalogClient(original.client, { startOptions });
  await expect(index.initialize()).rejects.toBe(offline);
  original.client.close();
  await observeCodexCatalogClient(replacement.client, { startOptions });
  let settled = false;
  const recovering = index.initialize().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(settled).toBe(true));
  await recovering;
  expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual([
    "reconnected",
  ]);
  readNative.mockResolvedValue({ rows: [row("later")] });
  await vi.advanceTimersByTimeAsync(15 * 60_000);
  await vi.waitFor(async () => {
    expect((await index.list({})).sessions.map((session) => session.threadId)).toEqual(["later"]);
  });
  await index.retire();
});

it.each([
  { change: "newer recency", recencyAt: 300 },
  { change: "a turn within the same timestamp", recencyAt: 200 },
])("keeps the backward boundary when its anchor moves after $change", async ({ recencyAt }) => {
  const threads: CodexThread[] = ["alpha", "bravo", "charlie"].map((id, position) => ({
    id,
    projectId: null,
    name: id,
    preview: `Please review the ${id} workspace change.`,
    source: "cli",
    originator: "codex_cli_rs",
    recencyAt: position < 2 ? 200 : 100,
  }));
  const startOptions = catalogWebSocketOptions(`wss://cursor-${recencyAt}.example.test/codex`);
  const harness = createTrackedClient({
    onWrite(line, send) {
      const request = JSON.parse(line);
      expect(request).toMatchObject({ method: "thread/read", params: { threadId: "bravo" } });
      send({ id: request.id, result: { thread: { ...threads[1], recencyAt } } });
    },
  });
  const readNative = vi.fn(async () => projectNativeCatalogFixture({ data: threads }));
  const nativeReads = vi.spyOn(harness.client, "request");
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
  await harness.waitForWrite(0);
  await nativeReads.mock.results[0]!.value;
  await vi.waitFor(async () => {
    expect((await index.list({ limit: 1 })).sessions[0]?.threadId).toBe("bravo");
  });
  const previous = await index.list({ limit: 1, cursor: second.backwardsCursor });
  expect(previous.sessions.map((row) => row.threadId)).toEqual(["alpha"]);
  const expandedPrevious = await index.list({ limit: 64, cursor: second.backwardsCursor });
  expect(expandedPrevious.sessions.map((row) => row.threadId)).toEqual(["alpha"]);
  const following = await index.list({ limit: 1, cursor: second.nextCursor });
  expect(following.sessions.map((row) => row.threadId)).toEqual(["charlie"]);
  expect(readNative).toHaveBeenCalledOnce();
  expect(harness.writes).toHaveLength(1);
});

it.each([
  ["", "First user request"],
  ["Previous first user request", ""],
])(
  "observes native preview transition %j to %j within one timestamp second",
  async (before, after) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const thread = sourceThread({
      id: "preview-transition",
      name: null,
      originator: "codex_cli_rs",
      cwd: "/workspace/project",
      path: null,
      preview: before,
    });
    const requests: CodexThreadListParams[] = [];
    const harness = createTrackedClient({
      onWrite(line, send) {
        const request = JSON.parse(line);
        expect(request.method).toBe("thread/list");
        requests.push(request.params);
        send({ id: request.id, result: { data: [thread] } });
      },
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
    await vi.waitFor(async () => {
      expect((await index.list({})).sessions[0]?.fallbackName).toBe(after || undefined);
    });
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
