import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createLineImageSetIngressBuffer } from "./inbound-image-set.js";

let buffer: ReturnType<typeof createLineImageSetIngressBuffer<string, string>>;

beforeEach(() => {
  vi.useFakeTimers();
  buffer = createLineImageSetIngressBuffer<string, string>();
});

afterEach(() => {
  vi.useRealTimers();
});

const arrive = (params: Partial<Parameters<typeof buffer.admit>[0]>) =>
  buffer.admit({
    laneKey: "user:U1",
    setId: "set-1",
    senderKey: "user:U1",
    messageId: `m${params.index ?? "unindexed"}`,
    event: `image-${params.index ?? "unindexed"}`,
    lifecycle: `claim-${params.index ?? "unindexed"}`,
    ...params,
  });

async function flush(held: ReturnType<typeof arrive>, delay = 4_000) {
  await vi.advanceTimersByTimeAsync(delay);
  const delivery = await held;
  delivery?.finish();
  return delivery;
}

it.each([false, true])(
  "extends the inter-part wait after lane admission (queued=%s)",
  async (queued) => {
    const occupied = queued ? await buffer.enterLane("user:U1") : undefined;
    const held = arrive({ index: 1 });
    await vi.advanceTimersByTimeAsync(queued ? 2_400 : 3_200);
    const second = arrive({ index: 2 });
    if (occupied) {
      await vi.advanceTimersByTimeAsync(8_000);
      occupied();
    }
    await vi.advanceTimersByTimeAsync(queued ? 1_200 : 3_200);
    const third = arrive({ index: 3 });
    // Release before awaiting followers, including when the set incorrectly closed early.
    const delivery = await flush(held, queued ? 4_800 : 4_000);
    expect(delivery?.events).toEqual(["image-1", "image-2", "image-3"]);
    await expect(second).resolves.toBeNull();
    await expect(third).resolves.toBeNull();
  },
);

it("keeps one order for a set LINE indexed only partly", async () => {
  // Pairwise index/arrival ordering would be intransitive for a partly indexed set.
  const held = arrive({ index: 2, total: 3 });
  await vi.advanceTimersByTimeAsync(1);
  await expect(arrive({ total: 3 })).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  await expect(arrive({ index: 1, total: 3 })).resolves.toBeNull();

  await expect(held).resolves.toMatchObject({
    events: ["image-1", "image-2", "image-unindexed"],
    lifecycles: ["claim-1", "claim-2", "claim-unindexed"],
  });
});

it("keeps two members of one group apart when LINE reuses a set id", async () => {
  // A shared group lane must not admit a denied sender's images under its holder's authority.
  const group = "group:Cshared";
  const member = (sender: string, index: number) =>
    arrive({
      index,
      total: 2,
      laneKey: group,
      senderKey: `user:U${sender}`,
      setId: "shared-id",
      event: sender === "A" ? `image-${index}` : `b-image-${index}`,
    });
  const memberA = member("A", 1);
  const memberB = member("B", 1);
  await expect(member("A", 2)).resolves.toBeNull();
  const deliveredA = await memberA;
  expect(deliveredA).toMatchObject({ events: ["image-1", "image-2"] });
  deliveredA?.finish();

  await expect(member("B", 2)).resolves.toBeNull();
  await expect(memberB).resolves.toMatchObject({ events: ["b-image-1", "b-image-2"] });
});

it("starts a new set for a part arriving after the holder took the last one", async () => {
  const held = arrive({ index: 1, total: 2 });
  await expect(arrive({ index: 2, total: 2 })).resolves.toBeNull();
  const set = expectDefined(await held, "the first part should hold the set");
  expect(set.events).toEqual(["image-1", "image-2"]);

  const late = arrive({ index: 3 });
  let lateResolved = false;
  void late.then(() => {
    lateResolved = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(lateResolved).toBe(false);

  set.finish();
  await vi.advanceTimersByTimeAsync(4_000);
  await expect(late).resolves.toMatchObject({
    events: ["image-3"],
    lifecycles: ["claim-3"],
  });
});

it.each([
  { index: 3, missing: undefined },
  { index: 1, missing: 1 },
])(
  "counts distinct delivered parts across partial sets (next=$index)",
  async ({ index, missing }) => {
    const first = arrive({ index: 1, total: 3 });
    void arrive({ index: 2, total: 3 });
    expect((await flush(first))?.missing).toBe(1);
    const retry = arrive({ index, total: 3 });
    if (index === 1) {
      void arrive({ index: 2, total: 3 });
    }
    const retrySet = await flush(retry);
    expect(retrySet?.missing).toBe(missing);
  },
);

it("lets an unrelated lane through while a set is still forming", async () => {
  const held = arrive({ index: 1, total: 3 });

  const release = await buffer.enterLane("user:UOTHER");
  expect(buffer.isBusy("user:UOTHER")).toBe(true);
  release();
  // Drain the queue's cleanup continuation before checking lane release.
  await vi.advanceTimersByTimeAsync(0);
  expect(buffer.isBusy("user:UOTHER")).toBe(false);

  await flush(held);
});
import { expectDefined } from "@openclaw/normalization-core";
