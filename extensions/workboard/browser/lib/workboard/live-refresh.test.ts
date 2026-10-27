import "../../test/host.setup.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { waitForFast } from "../../test/wait-for.ts";
import { createWorkboardCapability } from "./capability.ts";
import { normalizeWorkboardChange } from "./change-payload.ts";
import {
  configureWorkboardLiveRefresh,
  handleWorkboardChanged,
  resumeWorkboardLiveRefresh,
} from "./live-refresh.ts";
import { loadWorkboard } from "./loading.ts";
import { stopWorkboardLiveRefresh, getWorkboardState, subscribeWorkboard } from "./runtime.ts";
import { createWorkboardCard, createWorkboardTestClient } from "./test/index-helpers.ts";

const cardsResponse = (title?: string) => ({
  cards: title ? [createWorkboardCard({ title })] : [],
  statuses: ["todo", "done"],
});

function setup(read: () => unknown = cardsResponse) {
  const host = {};
  const client = createWorkboardTestClient((method) =>
    method === "workboard.cards.list" ? read() : { tasks: [] },
  );
  configureWorkboardLiveRefresh({ host, client });
  const listCalls = () =>
    client.request.mock.calls.filter(([method]) => method === "workboard.cards.list").length;
  const waitForReads = (count = 1) => waitForFast(() => expect(listCalls()).toBe(count));
  return { host, client, state: getWorkboardState(host), listCalls, waitForReads };
}

afterEach(() => vi.useRealTimers());

it("publishes read progress and completion through the owner's subscription", async () => {
  const result = createDeferred<unknown>();
  const host = createWorkboardCapability();
  const state = host.state;
  const client = createWorkboardTestClient(() => result.promise);
  const seen: Array<{ loading: boolean; title: string | undefined }> = [];
  const unsubscribe = host.subscribe(() =>
    seen.push({ loading: state.loading, title: state.cards[0]?.title }),
  );
  const pending = loadWorkboard({ host, client });
  expect(seen).toEqual([{ loading: true, title: undefined }]);
  result.resolve(cardsResponse("Admitted result"));
  await pending;
  expect(seen.at(-1)).toEqual({ loading: false, title: "Admitted result" });
  unsubscribe();
  const count = seen.length;
  await loadWorkboard({ host, client, force: true });
  expect(seen).toHaveLength(count);
});

it("validates the bounded invalidation payload", () => {
  const valid = { epoch: "epoch-a", revision: 1 };
  expect(normalizeWorkboardChange(valid)).toEqual(valid);
  expect(normalizeWorkboardChange({ ...valid, epoch: "" })).toBeNull();
  expect(normalizeWorkboardChange({ ...valid, revision: 0 })).toBeNull();
  expect(normalizeWorkboardChange({ ...valid, revision: Number.NaN })).toBeNull();
  expect(normalizeWorkboardChange({ ...valid, cards: [] })).toBeNull();
  expect(normalizeWorkboardChange({ ...valid, sessionsRevision: -1 })).toBeNull();
});

it("rereads canonical cards and ignores stale revisions", async () => {
  const { host, client, state, listCalls } = setup(() => cardsResponse("Updated elsewhere"));
  expect(handleWorkboardChanged(host, { epoch: "epoch-a", revision: 2 })).toBe(true);
  await waitForFast(() => expect(state.cards[0]?.title).toBe("Updated elsewhere"));
  expect(handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 })).toBe(false);
  expect(listCalls()).toBe(1);
  const diagnostics = "workboard.cards.diagnostics.refresh";
  expect(client.request).not.toHaveBeenCalledWith(diagnostics, expect.anything());
});

it("coalesces revisions that arrive during a canonical read", async () => {
  const firstList = createDeferred<unknown>();
  let reads = 0;
  const { host, listCalls, waitForReads } = setup(() =>
    ++reads === 1 ? firstList.promise : cardsResponse(),
  );
  handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
  await waitForReads();
  handleWorkboardChanged(host, { epoch: "epoch-a", revision: 2 });
  handleWorkboardChanged(host, { epoch: "epoch-a", revision: 3 });
  firstList.resolve(cardsResponse());

  await waitForReads(2);
  await Promise.resolve();
  expect(listCalls()).toBe(2);
});

it("defers during edits and resumes after the local draft closes", async () => {
  const onChange = vi.fn();
  const { host, client, state, waitForReads } = setup();
  subscribeWorkboard(host, onChange);
  Object.assign(state, { draftOpen: true, editingCardId: "card-1" });

  handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
  await Promise.resolve();
  expect(client.request).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();

  Object.assign(state, { draftOpen: false, editingCardId: null });
  resumeWorkboardLiveRefresh(host);
  await waitForReads();
});

it("retries transient failures and treats a new epoch as authoritative", async () => {
  vi.useFakeTimers();
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporarily unavailable"))
    .mockReturnValue(cardsResponse());
  const { host, client, listCalls, waitForReads } = setup(read);

  handleWorkboardChanged(host, { epoch: "epoch-a", revision: 9 });
  await waitForReads();
  resumeWorkboardLiveRefresh(host);
  configureWorkboardLiveRefresh({ host, client });
  await Promise.resolve();
  expect(listCalls()).toBe(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(listCalls()).toBe(2);

  expect(handleWorkboardChanged(host, { epoch: "epoch-b", revision: 1 })).toBe(true);
  await waitForReads(3);
  stopWorkboardLiveRefresh(host);
});

it.each(["live", "direct"])("discards a %s read that completes after teardown", async (source) => {
  const list = createDeferred<unknown>();
  const { host, client, state, waitForReads } = setup(() => list.promise);
  const loading = source === "direct" ? loadWorkboard({ host, client, force: true }) : undefined;
  if (source === "live") {
    handleWorkboardChanged(host, { epoch: "epoch-a", revision: 1 });
  }
  await waitForReads();
  stopWorkboardLiveRefresh(host);
  list.resolve(cardsResponse("Must not apply"));
  await delay(0);
  if (loading) {
    await expect(loading).resolves.toBe(false);
  }
  expect(state.cards).toEqual([]);
  expect(state.loading).toBe(false);
});

it("retains cards on unchanged responses and still refreshes caller-scoped Sessions boards", async () => {
  const host = {};
  const state = getWorkboardState(host);
  const revision = { epoch: "cards", revision: 1 };
  const card = createWorkboardCard();
  const client = createWorkboardTestClient({});
  const { request } = client;
  request.mockResolvedValueOnce({ cards: [card], boards: [], revision });
  request.mockResolvedValue({ unchanged: true, revision });
  await loadWorkboard({ host, client });
  await loadWorkboard({ host, client, force: true });
  expect(state.loaded).toBe(true);
  expect(state.cards).toEqual([card]);
  expect(request).toHaveBeenLastCalledWith("workboard.cards.list", { sinceRevision: revision });
  configureWorkboardLiveRefresh({ host, client });
  const change = { epoch: "cards", revision: 2, cardsRevision: 1 };
  expect(handleWorkboardChanged(host, change)).toBe(false);
  const refresh = vi.fn(async () => true);
  configureWorkboardLiveRefresh({ host, client, refresh });
  expect(handleWorkboardChanged(host, { ...change, revision: 3 })).toBe(true);
  expect(refresh).toHaveBeenCalledOnce();
  stopWorkboardLiveRefresh(host);
});
