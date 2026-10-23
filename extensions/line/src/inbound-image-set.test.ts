import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLineImageSetIngressBuffer } from "./inbound-image-set.js";

describe("createLineImageSetIngressBuffer", () => {
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
      messageId: `m${params.index}`,
      event: `image-${params.index}`,
      lifecycle: `claim-${params.index}`,
      ...params,
    });

  async function partialSet() {
    const first = arrive({ index: 1, total: 3 });
    void arrive({ index: 2, total: 3 });
    await vi.advanceTimersByTimeAsync(4_000);
    const set = await first;
    expect(set?.missing).toBe(1);
    set?.finish();
  }

  it("extends the wait on every arrival so a slow part joins the same set", async () => {
    const held = arrive({ index: 1 });
    await vi.advanceTimersByTimeAsync(3_200);
    const second = arrive({ index: 2 });
    await vi.advanceTimersByTimeAsync(3_200);
    const third = arrive({ index: 3 });
    await vi.advanceTimersByTimeAsync(4_000);

    const delivery = await held;
    // Release before awaiting followers, including when the set incorrectly closed early.
    delivery?.finish();
    expect(delivery?.events).toEqual(["image-1", "image-2", "image-3"]);
    await expect(second).resolves.toBeNull();
    await expect(third).resolves.toBeNull();
  });

  it("does not spend the wait while the set is still queued for its lane", async () => {
    const occupied = await buffer.enterLane("user:U1");
    const held = arrive({ index: 1 });
    await vi.advanceTimersByTimeAsync(2_400);
    const second = arrive({ index: 2 });
    await vi.advanceTimersByTimeAsync(8_000);
    occupied();
    await vi.advanceTimersByTimeAsync(1_200);
    const third = arrive({ index: 3 });
    await vi.advanceTimersByTimeAsync(4_800);

    const delivery = await held;
    delivery?.finish();
    expect(delivery?.events).toEqual(["image-1", "image-2", "image-3"]);
    await expect(second).resolves.toBeNull();
    await expect(third).resolves.toBeNull();
  });

  it("keeps one order for a set LINE indexed only partly", async () => {
    // Pairwise index/arrival ordering would be intransitive for a partly indexed set.
    const held = arrive({ index: 2, total: 3 });
    await vi.advanceTimersByTimeAsync(1);
    await expect(
      arrive({
        messageId: "m-unindexed",
        event: "image-unindexed",
        lifecycle: "claim-unindexed",
        total: 3,
      }),
    ).resolves.toBeNull();
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
    const set = await held;
    if (!set) {
      throw new Error("the first part should hold the set");
    }
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

  it("does not report parts an earlier piece of the same set already delivered", async () => {
    await partialSet();
    const second = arrive({ index: 3, total: 3 });
    await vi.advanceTimersByTimeAsync(4_000);
    const secondSet = await second;
    expect(secondSet?.missing).toBeUndefined();
    secondSet?.finish();
  });

  it("does not count a redelivered part as one more image of the same set", async () => {
    await partialSet();
    const retry = arrive({ index: 1, total: 3 });
    void arrive({ index: 2, total: 3 });
    await vi.advanceTimersByTimeAsync(4_000);
    const retrySet = await retry;
    expect(retrySet?.missing).toBe(1);
    retrySet?.finish();
  });

  it("lets an unrelated lane through while a set is still forming", async () => {
    const held = arrive({ index: 1, total: 3 });

    const release = await buffer.enterLane("user:UOTHER");
    expect(buffer.isBusy("user:UOTHER")).toBe(true);
    release();
    // Drain the queue's cleanup continuation before checking lane release.
    await vi.advanceTimersByTimeAsync(0);
    expect(buffer.isBusy("user:UOTHER")).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    (await held)?.finish();
  });
});
