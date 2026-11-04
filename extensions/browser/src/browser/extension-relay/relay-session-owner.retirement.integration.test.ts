import { expect, it } from "vitest";
import { RelaySessionOwner, type RelaySessionClient } from "./relay-session-owner.js";

const params = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };

it.each(["root", "child", "sole-child"])(
  "joins %s cleanup to successful native retirement",
  async (scope) => {
    const a: RelaySessionClient = { socket: { send() {} }, sessions: new Map() };
    const b: RelaySessionClient = { socket: { send() {} }, sessions: new Map() };
    const clients = new Set([a, b]);
    const native = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let detaches = 0;
    let attached = true;
    const errors: unknown[] = [];
    const owner = new RelaySessionOwner(
      clients,
      (id) => {
        if (!attached) {
          return Promise.resolve();
        }
        attached = false;
        return owner.retire(id, async () => {
          detaches++;
          entered.resolve();
          await native.promise;
        });
      },
      (error) => errors.push(error),
      () => false,
    );
    owner.registerRoot(1, "target", "root", async () => ({}));
    owner.announce(a, "root", "root", {});
    owner.announce(b, "root", "root", {});
    for (const client of clients) {
      if (scope === "sole-child" && client === b) {
        continue;
      }
      const session = client.sessions.get("root")!;
      await session.physical.target.command(session, params, () => {});
    }
    if (scope !== "root") {
      owner.forward("root", undefined, "Target.attachedToTarget", {
        sessionId: "native-child",
        targetInfo: { targetId: "worker", type: "worker" },
        waitingForDebugger: false,
      });
      const child = [...a.sessions.values()].find((session) => session.parent)!;
      await child.physical.target.command(child, params, () => {});
    }
    clients.delete(a);
    const closeA = owner.close(a);
    let firstSettled = false;
    void closeA.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    clients.delete(b);
    const closeB = owner.close(b);
    const outcomes = Promise.allSettled([closeA, closeB]);
    let settled = false;
    void outcomes.then(() => {
      settled = true;
    });
    await entered.promise;
    // A microtask barrier, not a wall-clock delay: queued cancellation must join ACK.
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }
    const firstSettledBeforeAck = firstSettled;
    const allSettledBeforeAck = settled;
    native.resolve();
    expect(firstSettledBeforeAck).toBe(false);
    expect(allSettledBeforeAck).toBe(false);
    expect((await outcomes).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(detaches).toBe(1);
    expect(a.sessions.size + b.sessions.size).toBe(0);
    expect(errors).toEqual([]);
  },
);

it("preserves failed native retirement for both closing clients", async () => {
  const a: RelaySessionClient = { socket: { send() {} }, sessions: new Map() };
  const b: RelaySessionClient = { socket: { send() {} }, sessions: new Map() };
  const clients = new Set([a, b]);
  const native = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let attached = true;
  const owner = new RelaySessionOwner(
    clients,
    (id) => {
      if (!attached) {
        return Promise.resolve();
      }
      attached = false;
      return owner.retire(id, async () => {
        entered.resolve();
        await native.promise;
      });
    },
    () => {},
    () => false,
  );
  owner.registerRoot(1, "target", "root", async () => ({}));
  owner.announce(a, "root", "root", {});
  owner.announce(b, "root", "root", {});
  const session = a.sessions.get("root")!;
  await session.physical.target.command(session, params, () => {});
  const outcomes = Promise.allSettled([owner.close(a), owner.close(b)]);
  await entered.promise;
  const failure = new Error("native detach failed");
  native.reject(failure);
  const results = await outcomes;
  expect(results).toEqual([
    { status: "rejected", reason: failure },
    { status: "rejected", reason: failure },
  ]);
});

it("does not suppress an unrelated cleanup error with the same message", async () => {
  const a: RelaySessionClient = { socket: { send() {} }, sessions: new Map() };
  const b: RelaySessionClient = { socket: { send() {} }, sessions: new Map() };
  const clients = new Set([a, b]);
  const failure = new Error("Physical session detached");
  let fail = false;
  const owner = new RelaySessionOwner(
    clients,
    (id) => owner.retire(id, async () => {}),
    () => {},
    () => false,
  );
  owner.registerRoot(1, "target", "root", async () => {
    if (fail) {
      throw failure;
    }
    return {};
  });
  owner.announce(a, "root", "root", {});
  owner.announce(b, "root", "root", {});
  const session = a.sessions.get("root")!;
  await session.physical.target.command(session, params, () => {});
  fail = true;
  await expect(owner.close(a)).rejects.toBe(failure);
  await owner.close(b);
});
