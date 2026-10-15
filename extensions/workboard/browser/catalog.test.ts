/* @vitest-environment jsdom */

import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "./api/gateway.ts";
import { WorkboardCatalog } from "./catalog.ts";
import { createWorkboardCapability } from "./lib/workboard/capability.ts";
import { loadWorkboard } from "./lib/workboard/loading.ts";
import { moveWorkboardCard } from "./lib/workboard/mutations.ts";
import { getWorkboardState } from "./lib/workboard/runtime.ts";
import { createWorkboardCard } from "./lib/workboard/test/index-helpers.ts";
type WorkboardCatalogSnapshot = Parameters<ConstructorParameters<typeof WorkboardCatalog>[0]>[0];

const board = (id: string) => ({
  id,
  total: 0,
  active: 0,
  archived: 0,
  byStatus: {},
});

const createHost = () => createWorkboardCapability();

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("Workboard catalog", () => {
  it.each([false, true])(
    "loads the full page after catalog hydration (failed=%s)",
    async (failed) => {
      const pending = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
      const request = vi.fn(async (method: string) =>
        method === "workboard.boards.list" ? pending.promise : { cards: [] },
      );
      const host = createHost();
      const runtime = new WorkboardCatalog(() => {}, host);
      const client = { request } as unknown as GatewayBrowserClient;
      try {
        runtime.sync(client, true);
        const fullLoad = loadWorkboard({ host, client });
        if (failed) {
          pending.reject(new Error("Catalog unavailable"));
        } else {
          pending.resolve({ cards: [], boards: [board("ops")] });
        }
        await expect(fullLoad).resolves.toBe(true);
        expect(request).toHaveBeenCalledTimes(2);
        expect(host.state.loaded).toBe(true);
        expect(host.state.loadAttempted).toBe(true);
      } finally {
        runtime.dispose();
        host.dispose();
      }
    },
  );

  it("does not overwrite a completed mutation with an older catalog response", async () => {
    const card = createWorkboardCard();
    const moved = { ...card, status: "review" as const, updatedAt: 2 };
    const pending = createDeferred<unknown>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [card], boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ card: moved });
    const host = createHost();
    const runtime = new WorkboardCatalog(() => {}, host);
    const client = { request } as unknown as GatewayBrowserClient;
    try {
      runtime.sync(client, true);
      await vi.waitFor(() => expect(host.boardsReady).toBe(true));
      host.state.cards = [card];
      runtime.handleGatewayEvent("plugin.workboard.changed");
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await moveWorkboardCard({ host, client, cardId: card.id, status: "review", position: 1000 });
      pending.resolve({ cards: [card], boards: [board("ops")] });
      await pending.promise;
      expect(host.state.cards).toEqual([moved]);
    } finally {
      runtime.dispose();
      host.dispose();
    }
  });

  it("loads only summaries on connect and changes without hydrating card history", async () => {
    vi.useFakeTimers();
    const historical = createWorkboardCard({ notes: "history".repeat(10_000) });
    const host = createHost();
    let name = "Operations";
    let responseBytes = 0;
    const request = vi.fn(async (method: string) => {
      const response =
        method === "workboard.boards.list"
          ? { boards: [{ ...board("ops"), name }] }
          : { boards: [board("ops")], cards: [historical] };
      responseBytes += JSON.stringify(response).length;
      return response;
    });
    const runtime = new WorkboardCatalog(() => {}, host);
    try {
      runtime.sync({ request } as unknown as GatewayBrowserClient, true);
      await vi.advanceTimersByTimeAsync(0);
      name = "Renamed";
      runtime.handleGatewayEvent("plugin.workboard.changed", {
        epoch: "test",
        revision: 2,
        cardsRevision: 2,
      });
      await vi.advanceTimersByTimeAsync(0);
      runtime.handleGatewayEvent("plugin.workboard.changed", {
        epoch: "test",
        revision: 3,
        cardsRevision: 2,
        sessionsRevision: 3,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(request.mock.calls).toEqual([
        ["workboard.boards.list", {}],
        ["workboard.boards.list", {}],
      ]);
      expect(responseBytes).toBeLessThan(512);
      expect(host.state.boards[0]?.name).toBe("Renamed");
      runtime.handleGatewayEvent("plugin.workboard.changed", { epoch: "test", revision: 4 });
      await vi.advanceTimersByTimeAsync(0);
      runtime.handleGatewayEvent("plugin.workboard.changed", {
        epoch: "restarted",
        revision: 1,
        cardsRevision: 2,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(request).toHaveBeenCalledTimes(4);
      expect(host.state.cards).toEqual([]);
      expect(host.state.loaded).toBe(false);
    } finally {
      runtime.dispose();
      host.dispose();
    }
  });

  it("queues a forced refresh behind the current client load", async () => {
    const first = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = new WorkboardCatalog((snapshot) => snapshots.push(snapshot), createHost());
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    runtime.handleGatewayEvent("plugin.workboard.changed");
    first.resolve({ cards: [], boards: [board("default")] });

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.dispose();
  });

  it("does not let an old client repopulate a replacement catalog", async () => {
    const first = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const second = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const firstRequest = vi.fn(() => first.promise);
    const secondRequest = vi.fn(() => second.promise);
    const firstClient = { request: firstRequest } as unknown as GatewayBrowserClient;
    const secondClient = { request: secondRequest } as unknown as GatewayBrowserClient;
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = new WorkboardCatalog((snapshot) => snapshots.push(snapshot), createHost());

    runtime.sync(firstClient, true);
    runtime.handleGatewayEvent("plugin.workboard.changed");
    runtime.sync(secondClient, true);
    first.resolve({ cards: [], boards: [board("stale")] });
    second.resolve({ cards: [], boards: [board("current")] });

    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("current"));
    expect(firstRequest).toHaveBeenCalledOnce();
    expect(secondRequest).toHaveBeenCalledOnce();
    runtime.dispose();
  });

  it("preserves the cached catalog when an in-flight refresh resolves after disconnect", async () => {
    const pending = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ cards: [], boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const host = createHost();
    const runtime = new WorkboardCatalog((snapshot) => snapshots.push(snapshot), host);
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.handleGatewayEvent("plugin.workboard.changed");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    runtime.sync(client, false);
    pending.resolve({ cards: [], boards: [board("stale")] });
    await pending.promise;

    expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops");
    expect(getWorkboardState(host).boards[0]?.id).toBe("ops");
    expect(host.boardsReady).toBe(true);

    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform"));
    expect(getWorkboardState(host).boards[0]?.id).toBe("platform");
    runtime.dispose();
  });

  it("does not let a pre-disconnect response overwrite a reconnected catalog", async () => {
    vi.useFakeTimers();
    const pending = createDeferred<{ cards: []; boards: ReturnType<typeof board>[] }>();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] })
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ cards: [], boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const host = createHost();
    const runtime = new WorkboardCatalog((snapshot) => snapshots.push(snapshot), host);
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.handleGatewayEvent("plugin.workboard.changed");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));

    runtime.sync(client, false);
    runtime.sync(client, true);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform"));

    pending.resolve({ cards: [], boards: [board("stale")] });
    await pending.promise;

    await vi.advanceTimersByTimeAsync(2_000);

    expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform");
    expect(getWorkboardState(host).boards[0]?.id).toBe("platform");
    expect(host.boardsReady).toBe(true);
    runtime.dispose();
  });

  it("preserves catalog data and retries a malformed forced refresh", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockResolvedValueOnce({ cards: [], boards: [board("ops")] })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ cards: [], boards: [board("platform")] });
    const snapshots: WorkboardCatalogSnapshot[] = [];
    const runtime = new WorkboardCatalog((snapshot) => snapshots.push(snapshot), createHost());
    const client = { request } as unknown as GatewayBrowserClient;

    runtime.sync(client, true);
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("ops"));
    runtime.handleGatewayEvent("plugin.workboard.changed");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    runtime.sync(client, true);
    await vi.advanceTimersByTimeAsync(2_000);

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(snapshots.at(-1)?.boards[0]?.id).toBe("platform"));
    runtime.dispose();
  });
});
