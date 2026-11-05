import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { assert, expect, it, vi } from "vitest";
import { serviceContext } from "./lifecycle-sync-fixtures.test-support.js";
import { createWorkboardLifecycleService } from "./lifecycle-sync.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

function setup(hook?: "beforeCardWrite" | "beforeCardLookup", keepOpen = false) {
  const entered = createDeferred<void>();
  const resume = createDeferred<void>();
  const wait = async () => {
    entered.resolve();
    await resume.promise;
  };
  const pause = vi.fn(async () => {});
  const close = vi.fn((): void | Promise<void> => (keepOpen ? undefined : harness.stores.close()));
  const harness = createWorkboardSqliteTestHarness({
    onStoreClose: close,
    ...(hook ? { [hook]: pause } : {}),
  });
  const hold = () => pause.mockImplementationOnce(wait);
  return { ...harness, close, entered, resume, wait, hold };
}
const expectClosed = (work: Promise<unknown>) =>
  expect(work).rejects.toThrow("workboard store is closed.");

it("joins queued mutations before closing and rejects new work", async () => {
  const { entered, resume, close, store, stores, hold } = setup("beforeCardWrite", true);
  hold();
  const first = store.create({ title: "First" });
  await entered.promise;
  const queued = store.create({ title: "Queued" });
  const closing = store.close();
  try {
    await expectClosed(store.create({ title: "Late" }));
    expect(close).not.toHaveBeenCalled();
    resume.resolve();
    const cards = await Promise.all([first, queued]);
    expect(cards.map(({ title }) => title)).toEqual(["First", "Queued"]);
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(await stores.cards.entries()).toHaveLength(2);
  } finally {
    resume.resolve();
  }
});

it("keeps a whole admitted tool call alive across its reads", async () => {
  const { entered, resume, store, hold } = setup("beforeCardLookup");
  const notes = "Keep the full result.";
  const card = await store.create({ title: "Read context", notes });
  const tool = createWorkboardTools({ store }).find((entry) => entry.name === "workboard_read");
  assert(tool, "Workboard read tool is unavailable");
  hold();
  const reading = tool.execute("read", { id: card.id });
  await entered.promise;
  const closing = store.close();
  resume.resolve();
  await expect(reading).resolves.toMatchObject({
    details: { card: { id: card.id, notes }, workerContext: expect.stringContaining(notes) },
  });
  await closing;
  await expectClosed(tool.execute("late", { id: card.id }));
});

it("does not let another store or a detached continuation revive a closed owner", async () => {
  const first = setup().store;
  const second = setup().store;
  const resume = createDeferred<void>();
  const { detached } = await first.runOperation(() => ({
    detached: resume.promise.then(() => first.create({ title: "Detached" })),
  }));
  await first.close();
  const rejected = expectClosed(detached);
  resume.resolve();
  await rejected;
  await second.runOperation(async () => {
    await expectClosed(first.create({ title: "Wrong owner" }));
    await expect(second.create({ title: "Own" })).resolves.toMatchObject({ title: "Own" });
  });
});

it("joins a stopped background sweep without reviving its lifecycle generation", async () => {
  const { entered, resume, close, store, stores, wait } = setup(undefined, true);
  const sessionKey = "agent:main:background-sweep";
  const card = await store.create({ title: "Running session", status: "running", sessionKey });
  const service = createWorkboardLifecycleService({
    store,
    readSessions: async () => {
      await wait();
      return { complete: true, sessions: [{ key: sessionKey, status: "done" }] };
    },
  });
  const context = serviceContext();
  service.onGatewayStop();
  try {
    await service.start(context);
    service.onGatewayStart();
    await entered.promise;
    await service.stop?.(context);
    const closing = store.close();
    expect(close).not.toHaveBeenCalled();
    resume.resolve();
    await closing;
    expect(close).toHaveBeenCalledOnce();
    expect(await stores.cards.lookup(card.id)).toMatchObject({ card: { status: "running" } });
    expect(context.logger.warn).not.toHaveBeenCalled();
  } finally {
    resume.resolve();
    service.onGatewayStop();
    await service.stop?.(context);
    await store.close();
  }
});

it("coalesces pending close and retries failed cleanup while admission stays sealed", async () => {
  const firstClose = createDeferred<void>();
  const failure = new Error("native close failed");
  const { store, close: closePersistence } = setup(undefined, true);
  closePersistence.mockImplementationOnce(() => firstClose.promise);
  await store.ready();
  const closing = store.close();
  const rejected = expect(closing).rejects.toBe(failure);
  expect(store.close()).toBe(closing);
  firstClose.reject(failure);
  await rejected;
  expect(closePersistence).toHaveBeenCalledOnce();
  await expectClosed(store.list());

  const retry = store.close();
  expect(store.close()).toBe(retry);
  await retry;
  await store.close();
  expect(closePersistence).toHaveBeenCalledTimes(2);
  await expectClosed(store.list());
});
