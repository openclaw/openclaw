import "../../test/host.setup.ts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForFast } from "../../test/wait-for.ts";
import { normalizeWorkboardChange } from "./change-payload.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  resumeWorkboardLiveRefresh,
} from "./live-refresh.ts";
import { loadWorkboard } from "./loading.ts";
import { stopWorkboardLiveRefresh, getWorkboardState } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";

function cardsResponse(title?: string) {
  return {
    cards: title ? [createWorkboardCard({ title })] : [],
    statuses: ["todo", "done"],
  };
}

function setup(read: () => unknown = cardsResponse, requestUpdate?: () => void) {
  const host = {};
  const client = createWorkboardTestClient((method) =>
    method === "workboard.cards.list" ? read() : { tasks: [] },
  );
  configureWorkboardLiveRefresh({ host, client, requestUpdate });
  const listCalls = () =>
    client.request.mock.calls.filter(([method]) => method === "workboard.cards.list").length;
  return { host, client, state: getWorkboardState(host), listCalls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Workboard live refresh", () => {
  it("validates the bounded invalidation payload", () => {
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: 1 })).toEqual({
      epoch: "epoch-a",
      revision: 1,
    });
    expect(normalizeWorkboardChange({ epoch: "", revision: 1 })).toBeNull();
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: 0 })).toBeNull();
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: Number.NaN })).toBeNull();
    expect(normalizeWorkboardChange({ epoch: "epoch-a", revision: 1, cards: [] })).toBeNull();
    expect(
      normalizeWorkboardChange({ epoch: "epoch-a", revision: 1, sessionsRevision: -1 }),
    ).toBeNull();
  });

  it("rereads canonical cards and ignores stale revisions", async () => {
    const { host, client, listCalls } = setup(() => cardsResponse("Updated elsewhere"));

    expect(handleWorkboardChanged(host, { epoch: "epoch-a", revision: 2 })).toBe(true);
    await waitForFast(() =>
      expect(getWorkboardState(host).cards[0]?.title).toBe("Updated elsewhere"),
    );
    expect(handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 })).toBe(false);
    expect(listCalls()).toBe(1);
    expect(client.request).not.toHaveBeenCalledWith(
      "workboard.cards.diagnostics.refresh",
      expect.anything(),
    );
  });

  it("coalesces revisions that arrive during a canonical read", async () => {
    const firstList = createDeferred<unknown>();
    let reads = 0;
    const { host, listCalls } = setup(() => (++reads === 1 ? firstList.promise : cardsResponse()));

    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
    await waitForFast(() => expect(listCalls()).toBe(1));
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 2 });
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 3 });
    firstList.resolve(cardsResponse());

    await waitForFast(() => expect(listCalls()).toBe(2));
    await Promise.resolve();
    expect(listCalls()).toBe(2);
  });

  it("defers during edits and resumes after the local draft closes", async () => {
    const requestUpdate = vi.fn();
    const { host, client, state } = setup(cardsResponse, requestUpdate);
    state.draftOpen = true;
    state.editingCardId = "card-1";

    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
    await Promise.resolve();
    expect(client.request).not.toHaveBeenCalled();
    expect(requestUpdate).not.toHaveBeenCalled();

    state.draftOpen = false;
    state.editingCardId = null;
    resumeWorkboardLiveRefresh(host);
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );
  });

  it("retries transient failures and treats a new epoch as authoritative", async () => {
    vi.useFakeTimers();
    let fail = true;
    const { host, client, listCalls } = setup(() => {
      if (fail) {
        throw new Error("temporarily unavailable");
      }
      return cardsResponse();
    });

    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 9 });
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );
    resumeWorkboardLiveRefresh(host);
    configureWorkboardLiveRefresh({ host, client });
    await Promise.resolve();
    expect(listCalls()).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(listCalls()).toBe(2);

    expect(handleWorkboardChanged(host, { epoch: "epoch-b", revision: 1 })).toBe(true);
    await waitForFast(() => expect(listCalls()).toBe(3));
    stopWorkboardLiveRefresh(host);
  });

  it("discards a live read that completes after teardown", async () => {
    const list = createDeferred<unknown>();
    const { host, client } = setup(() => list.promise);
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );

    stopWorkboardLiveRefresh(host);
    list.resolve(cardsResponse("Must not apply"));
    await list.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(getWorkboardState(host).cards).toEqual([]);
  });

  it("discards a direct canonical read that completes after teardown", async () => {
    const list = createDeferred<unknown>();
    const { host, client } = setup(() => list.promise);
    const loading = loadWorkboard({ host, client, force: true });
    await waitForFast(() =>
      expect(client.request).toHaveBeenCalledWith("workboard.cards.list", {}),
    );

    stopWorkboardLiveRefresh(host);
    list.resolve(cardsResponse("Must not apply"));

    await expect(loading).resolves.toBe(false);
    expect(getWorkboardState(host).cards).toEqual([]);
    expect(getWorkboardState(host).loading).toBe(false);
  });
});

it("retains cards on unchanged responses and still refreshes caller-scoped Sessions boards", async () => {
  const host = {};
  const revision = { epoch: "cards", revision: 1 };
  const card = createWorkboardCard();
  const request = vi
    .fn()
    .mockResolvedValueOnce({ cards: [card], boards: [], revision })
    .mockResolvedValue({ unchanged: true, revision });
  const client = { request } as never;
  await loadWorkboard({ host, client });
  expect(getWorkboardState(host).loaded).toBe(true);
  await loadWorkboard({ host, client, force: true });
  expect(getWorkboardState(host).loaded).toBe(true);
  expect(getWorkboardState(host).cards).toEqual([card]);
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", { sinceRevision: revision });
  configureWorkboardLiveRefresh({ host, client });
  expect(handleWorkboardChanged(host, { epoch: "cards", revision: 2, cardsRevision: 1 })).toBe(
    false,
  );
  const refresh = vi.fn(async () => true);
  configureWorkboardLiveRefresh({ host, client, refresh });
  expect(handleWorkboardChanged(host, { epoch: "cards", revision: 3, cardsRevision: 1 })).toBe(
    true,
  );
  expect(refresh).toHaveBeenCalledOnce();
  stopWorkboardLiveRefresh(host);
});
