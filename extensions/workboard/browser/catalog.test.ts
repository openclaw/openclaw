/* @vitest-environment jsdom */

import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "./api/gateway.ts";
import { WorkboardCatalog } from "./catalog.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { loadWorkboard } from "./lib/workboard/loading.ts";
import { moveWorkboardCard } from "./lib/workboard/mutations.ts";
import { getWorkboardState } from "./lib/workboard/runtime.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
type WorkboardCatalogSnapshot = Parameters<ConstructorParameters<typeof WorkboardCatalog>[0]>[0];

const board = (id: string) => ({ id, total: 0, active: 0, archived: 0, byStatus: {} });
const catalog = (id: string) => ({ cards: [], boards: [board(id)] });
let host: ReturnType<typeof createWorkboardCapability>;
let runtime: WorkboardCatalog;
let request: ReturnType<typeof vi.fn<(method: string, params: unknown) => Promise<unknown>>>;
let client: GatewayBrowserClient;
let snapshots: WorkboardCatalogSnapshot[];

beforeEach(() => {
  host = createWorkboardCapability();
  snapshots = [];
  runtime = new WorkboardCatalog((snapshot) => snapshots.push(snapshot), host);
  request = vi.fn();
  client = { request } as unknown as GatewayBrowserClient;
});

const expectBoard = (id: string) => vi.waitFor(() => expect(snapshots.at(-1)?.[0]?.id).toBe(id));
const expectRequests = (count: number) =>
  vi.waitFor(() => expect(request).toHaveBeenCalledTimes(count));
const change = (payload?: unknown) =>
  runtime.handleGatewayEvent("plugin.workboard.changed", payload);
function expectCachedBoard(id: string) {
  expect(snapshots.at(-1)?.[0]?.id).toBe(id);
  expect(getWorkboardState(host).boards[0]?.id).toBe(id);
  expect(host.boardsReady).toBe(true);
}
async function startRefresh(response: unknown) {
  request
    .mockResolvedValueOnce(catalog("ops"))
    .mockResolvedValueOnce(response)
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
  document.body.replaceChildren();
});

it.each([false, true])(
  "loads the full page after catalog hydration (failed=%s)",
  async (failed) => {
    const pending = createDeferred<ReturnType<typeof catalog>>();
    request.mockImplementation(async (method: string) =>
      method === "workboard.boards.list" ? pending.promise : { cards: [] },
    );
    runtime.sync(client, true);
    const fullLoad = loadWorkboard({ host, client });
    if (failed) {
      pending.reject(new Error("Catalog unavailable"));
    } else {
      pending.resolve(catalog("ops"));
    }
    await expect(fullLoad).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(host.state).toMatchObject({ loaded: true, loadAttempted: true });
  },
);

it("does not overwrite a completed mutation with an older catalog response", async () => {
  const card = createWorkboardCard();
  const moved = { ...card, status: "review" as const, updatedAt: 2 };
  const pending = createDeferred<unknown>();
  request
    .mockResolvedValueOnce({ cards: [card], boards: [board("ops")] })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ card: moved });
  runtime.sync(client, true);
  await vi.waitFor(() => expect(host.boardsReady).toBe(true));
  host.state.cards = [card];
  change();
  await expectRequests(2);
  await moveWorkboardCard({ host, client, cardId: card.id, status: "review", position: 1000 });
  pending.resolve({ cards: [card], boards: [board("ops")] });
  await pending.promise;
  expect(host.state.cards).toEqual([moved]);
});

it("loads only summaries on connect and changes without hydrating card history", async () => {
  vi.useFakeTimers();
  const historical = createWorkboardCard({ notes: "history".repeat(10_000) });
  let name = "Operations";
  let responseBytes = 0;
  request.mockImplementation(async (method: string) => {
    const response =
      method === "workboard.boards.list"
        ? { boards: [{ ...board("ops"), name }] }
        : { boards: [board("ops")], cards: [historical] };
    responseBytes += JSON.stringify(response).length;
    return response;
  });
  runtime.sync(client, true);
  await vi.advanceTimersByTimeAsync(0);
  name = "Renamed";
  change({ epoch: "test", revision: 2, cardsRevision: 2 });
  await vi.advanceTimersByTimeAsync(0);
  change({ epoch: "test", revision: 3, cardsRevision: 2, sessionsRevision: 3 });
  await vi.advanceTimersByTimeAsync(0);
  expect(request.mock.calls).toEqual([
    ["workboard.boards.list", {}],
    ["workboard.boards.list", {}],
  ]);
  expect(responseBytes).toBeLessThan(512);
  expect(host.state.boards[0]?.name).toBe("Renamed");
  change({ epoch: "test", revision: 4 });
  await vi.advanceTimersByTimeAsync(0);
  change({ epoch: "restarted", revision: 1, cardsRevision: 2 });
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(4);
  expect(host.state.cards).toEqual([]);
  expect(host.state.loaded).toBe(false);
});

it("queues a forced refresh behind the current client load", async () => {
  const first = createDeferred<ReturnType<typeof catalog>>();
  request.mockReturnValueOnce(first.promise).mockResolvedValueOnce(catalog("ops"));

  runtime.sync(client, true);
  await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
  change();
  first.resolve(catalog("default"));

  await expectRequests(2);
  await expectBoard("ops");
});

it("does not let an old client repopulate a replacement catalog", async () => {
  const first = createDeferred<ReturnType<typeof catalog>>();
  const second = createDeferred<ReturnType<typeof catalog>>();
  const firstRequest = vi.fn(() => first.promise);
  const secondRequest = vi.fn(() => second.promise);
  const firstClient = { request: firstRequest } as unknown as GatewayBrowserClient;
  const secondClient = { request: secondRequest } as unknown as GatewayBrowserClient;

  runtime.sync(firstClient, true);
  change();
  runtime.sync(secondClient, true);
  first.resolve(catalog("stale"));
  second.resolve(catalog("current"));

  await expectBoard("current");
  expect(firstRequest).toHaveBeenCalledOnce();
  expect(secondRequest).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "rejects stale catalog data across reconnect (resolve after=%s)",
  async (afterReconnect) => {
    vi.useFakeTimers();
    const pending = createDeferred<ReturnType<typeof catalog>>();
    await startRefresh(pending.promise);
    runtime.sync(client, false);
    if (!afterReconnect) {
      pending.resolve(catalog("stale"));
      await pending.promise;
      expectCachedBoard("ops");
    }
    runtime.sync(client, true);
    await expectRequests(3);
    await expectBoard("platform");
    if (afterReconnect) {
      pending.resolve(catalog("stale"));
      await pending.promise;
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expectCachedBoard("platform");
  },
);

it("preserves catalog data and retries a malformed forced refresh", async () => {
  vi.useFakeTimers();
  await startRefresh({ ok: true });
  runtime.sync(client, true);
  await vi.advanceTimersByTimeAsync(2_000);

  await expectRequests(3);
  await expectBoard("platform");
});
