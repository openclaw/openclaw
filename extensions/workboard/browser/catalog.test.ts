/* @vitest-environment jsdom */

import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "./api/gateway.ts";
import { WorkboardCatalog } from "./catalog.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { moveWorkboardCard } from "./lib/workboard/mutations.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";

const board = (id: string) => ({ id, total: 0, active: 0, archived: 0, byStatus: {} });
const catalog = (id: string) => ({ cards: [], boards: [board(id)] });
let host: ReturnType<typeof createWorkboardCapability>;
let runtime: WorkboardCatalog;
let request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>;
let client: GatewayBrowserClient;
const publish = vi.fn();

beforeEach(() => {
  host = createWorkboardCapability();
  publish.mockClear();
  runtime = new WorkboardCatalog(publish, host);
  request = vi.fn();
  client = { request } as unknown as GatewayBrowserClient;
});

const expectBoard = (id: string) => vi.waitFor(() => expectCachedBoard(id));
const expectRequests = (count: number) =>
  vi.waitFor(() => expect(request).toHaveBeenCalledTimes(count));
const change = (payload?: unknown) =>
  runtime.handleGatewayEvent("plugin.workboard.changed", payload);
async function tickChange(payload: unknown) {
  change(payload);
  await vi.advanceTimersByTimeAsync(0);
}
function expectCachedBoard(id: string) {
  expect(host.state.boards[0]?.id).toBe(id);
  expect(publish).toHaveBeenLastCalledWith(host.state.boards);
  expect(host.boardsReady).toBe(true);
}
async function startRefresh(response: unknown) {
  request
    .mockResolvedValueOnce(catalog("ops"))
    .mockImplementationOnce(() => {
      if (response instanceof Error) {
        throw response;
      }
      return Promise.resolve(response);
    })
    .mockResolvedValueOnce(catalog("platform"));
  runtime.sync(client, true);
  await expectBoard("ops");
  change();
  await expectRequests(2);
}

afterEach(() => {
  runtime.dispose();
  host.dispose();
  vi.useRealTimers();
});

it("refreshes only summaries without overwriting completed card mutations", async () => {
  vi.useFakeTimers();
  const card = createWorkboardCard();
  const moved = { ...card, status: "review" as const, updatedAt: 2 };
  const pending = createDeferred<unknown>();
  const response = { cards: [card], boards: [{ ...board("ops"), name: "Renamed" }] };
  request
    .mockImplementation(async (method: string) =>
      method === "workboard.boards.list" ? response : catalog("ops"),
    )
    .mockResolvedValueOnce({ cards: [card], boards: [board("ops")] })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ card: moved });
  runtime.sync(client, true);
  await expectBoard("ops");
  expect(host.state.cards).toEqual([]);
  host.state.cards = [card];
  change({ epoch: "test", revision: 2, cardsRevision: 2 });
  await expectRequests(2);
  await moveWorkboardCard({ host, client, cardId: card.id, status: "review", position: 1000 });
  pending.resolve(response);
  await tickChange({ epoch: "test", revision: 3, cardsRevision: 2, sessionsRevision: 3 });
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    "workboard.boards.list",
    "workboard.boards.list",
    "workboard.cards.move",
  ]);
  expect(host.state.boards[0]?.name).toBe("Renamed");
  await tickChange({ epoch: "test", revision: 4 });
  await tickChange({ epoch: "restarted", revision: 1, cardsRevision: 2 });
  expect(request).toHaveBeenCalledTimes(5);
  expect(host.state.cards).toEqual([moved]);
  expect(host.state.loaded).toBe(false);
});

it("queues a forced refresh behind the current client load", async () => {
  const first = createDeferred<ReturnType<typeof catalog>>();
  request.mockReturnValueOnce(first.promise).mockResolvedValueOnce(catalog("ops"));

  runtime.sync(client, true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  change();
  first.resolve(catalog("default"));

  await expectBoard("ops");
});

it.each(["client", "disconnect", "reconnect"])("rejects stale %s", async (mode) => {
  vi.useFakeTimers();
  const pending = createDeferred<ReturnType<typeof catalog>>();
  await startRefresh(pending.promise);
  if (mode === "client") {
    change();
    runtime.sync({ ...client }, true);
  } else {
    runtime.sync(client, false);
    if (mode === "disconnect") {
      pending.resolve(catalog("stale"));
      await pending.promise;
      expectCachedBoard("ops");
    }
    runtime.sync(client, true);
  }
  await expectBoard("platform");
  if (mode !== "disconnect") {
    pending.resolve(catalog("stale"));
    await pending.promise;
    await vi.advanceTimersByTimeAsync(2_000);
  }
  expectCachedBoard("platform");
  expect(request).toHaveBeenCalledTimes(3);
});

it.each([false, true])("retries failed refresh (throw=%s)", async (reject) => {
  vi.useFakeTimers();
  await startRefresh(reject ? new Error("Catalog unavailable") : { ok: true });
  runtime.sync(client, true);
  await vi.advanceTimersByTimeAsync(2_000);

  await expectBoard("platform");
});
