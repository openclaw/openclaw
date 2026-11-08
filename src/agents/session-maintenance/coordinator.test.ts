import { setImmediate as drainContinuations } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readOperatorToolGatewayAuthority as operatorAuthority,
  runWithOperatorToolGatewayAuthority as withOperatorAuthority,
} from "../../gateway/operator-tool-gateway-authority.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.owner-context.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  getGatewayToolCallerIdentity as callerIdentity,
  withGatewayToolCallerIdentity as withCaller,
} from "../tools/gateway-caller-context.js";
import {
  beginForegroundSessionMaintenance,
  createSessionMaintenanceOwner,
  waitForSessionMaintenance,
} from "./coordinator.js";

const sessionKey = "session:maintenance";
const turn = { sessionKey, sessionId: "maintenance", storePath: "/maintenance/current" };
const target = captureSessionTarget({
  storeScope: turn.storePath,
  sessionKey,
  incarnation: turn.sessionId,
});
type OwnerOptions = Omit<Parameters<typeof createSessionMaintenanceOwner>[0], "sessionKey">;

const events: string[] = [];
const gates = new Map<string, ReturnType<typeof createDeferred<void>>>();
const owners: ReturnType<typeof createSessionMaintenanceOwner>[] = [];
const reservations: (() => void)[] = [];
let closing = false;
function gate(name: string) {
  const deferred = gates.get(name) ?? createDeferred();
  gates.set(name, deferred);
  if (closing) {
    deferred.resolve();
  }
  return deferred;
}
const wait = (name: string) => gate(name).promise;
const release = (name: string) => gate(name).resolve();
function mark(name: string) {
  events.push(name);
  release(name);
}
const check = (expected: string) => expect(events).toEqual(expected ? expected.split(" ") : []);
const read = () => waitForSessionMaintenance(sessionKey);
function makeOwner(options: OwnerOptions = {}) {
  const current = createSessionMaintenanceOwner({ sessionKey, ...options });
  owners.push(current);
  return {
    ...current,
    run: <T>(...work: Parameters<typeof current.run<T>>) => current.track(current.run<T>(...work)),
  };
}
type Work = (current: ReturnType<typeof makeOwner>) => Promise<void>;
function start(name: string, options: OwnerOptions, work: Work, admitted?: () => void) {
  const current = makeOwner(options);
  const execute = async () => {
    mark(`${name}:start`);
    await work(current);
    mark(`${name}:done`);
  };
  const job = admitted
    ? runWithSessionControllerCleanup(() =>
        current.run({
          admit: (run) =>
            withSessionTurn({ ...turn, target }, () => {
              admitted();
              return run(execute);
            }),
        }),
      )
    : current.run(execute);
  return { ...current, work: job };
}
async function foreground(key = sessionKey, event?: string) {
  const done = await beginForegroundSessionMaintenance(key);
  reservations.push(done);
  if (event) {
    mark(event);
  }
  if (closing) {
    done();
  }
  return done;
}
afterEach(async () => {
  // Only teardown releases failed-fixture cycles; assertions observe real owner ordering.
  closing = true;
  gates.forEach((deferred) => deferred.resolve());
  reservations.forEach((done) => done());
  owners.forEach((current) => current.releaseWrites());
  await Promise.all(owners.map((current) => current.done));
  await drainGlobalSingletonLifecycleState("close");
  events.length = owners.length = reservations.length = 0;
  gates.clear();
  closing = false;
});

it.each([false, true])("detaches retired authority (optional=%s)", async (preemptible) => {
  const source = new AbortController();
  const operator = {
    scopes: ["operator.admin"],
    signal: source.signal,
    assertCurrent: () => source.signal.throwIfAborted(),
  };
  const identity = {
    agentId: "main",
    sessionKey: "session:source",
    receiptAuthority: () => !source.signal.aborted,
  };
  await withOperatorAuthority(operator, () =>
    withCaller(identity, async () => {
      const caller = callerIdentity();
      expect(caller?.receiptAuthority?.()).toBe(true);
      const owner = makeOwner({ preemptible });
      const assertDetached = () =>
        expect([callerIdentity(), operatorAuthority()]).toEqual([undefined, undefined]);
      const work = owner.run(async () => {
        assertDetached();
        await Promise.resolve();
        owner.assertCurrent();
        assertDetached();
        return "maintenance completed";
      });
      source.abort();
      await expect(work).resolves.toBe("maintenance completed");
      expect(owner.assertCurrent).toThrow();
      expect(callerIdentity()).toBe(caller);
      expect(caller?.receiptAuthority?.()).toBe(false);
      expect(operatorAuthority()).toBe(operator);
      expect(operator.assertCurrent).toThrow();
    }),
  );
});

it.each(["foreground", "close", "restart"] as const)(
  "aborts optional work on %s and retains ownership through cleanup",
  async (event) => {
    const owner = start("optional", { preemptible: true }, async (current) => {
      try {
        await wait("aborted");
        current.assertCurrent();
      } finally {
        mark("cleanup:start");
        await wait("finishCleanup");
        mark("cleanup:finish");
      }
    });
    owner.signal.addEventListener("abort", () => release("aborted"), { once: true });
    const rejection = expect(owner.work).rejects.toMatchObject({ name: "AbortError" });
    await wait("optional:start");
    const admission =
      event === "foreground"
        ? foreground(sessionKey, "foreground:admit").then((done) => done())
        : drainGlobalSingletonLifecycleState(event);
    await wait("cleanup:start");
    expect(owner.signal.aborted).toBe(true);
    expect(owner.assertCurrent).toThrow();
    check("optional:start cleanup:start");
    release("finishCleanup");
    await admission;
    await rejection;
    check(
      "optional:start cleanup:start cleanup:finish" +
        (event === "foreground" ? " foreground:admit" : ""),
    );
    const successor = makeOwner();
    await successor.run(async () => successor.assertCurrent());
    expect(owner.assertCurrent).toThrow();
  },
);

it("keeps optional work pending until every foreground reservation releases without blocking reads", async () => {
  const releaseFirst = await foreground();
  const releaseSecond = await foreground();
  const optional = start(
    "optional",
    { preemptible: true },
    async (current) => current.assertCurrent(),
    () => mark("admitted"),
  );
  await read();
  check("");
  releaseFirst();
  releaseFirst();
  await read();
  check("");
  expect(optional.signal.aborted).toBe(false);
  releaseSecond();
  await optional.work;
  check("admitted optional:start optional:done");
});

it.each(["pending-other-store", "running-writer", "non-preemptible"] as const)(
  "waits for %s maintenance before reads and foreground admission",
  async (mode) => {
    const pending = mode === "pending-other-store";
    const owner = makeOwner({
      target: pending
        ? captureSessionTarget({ ...target, storeScope: "/maintenance/other" })
        : target,
      preemptible: mode !== "non-preemptible",
    });
    const work = pending
      ? owner.track(wait("finish"))
      : owner.run(async () => {
          mark("started");
          await wait("finish");
        });
    if (!pending) {
      await wait("started");
    }
    const admission = mode === "non-preemptible" ? foreground(sessionKey, "foreground") : undefined;
    (await foreground("session:other"))();
    await waitForSessionMaintenance("session:other");
    await withSessionTurn({ ...turn, target }, async () => {
      const checkpoint = read().then(() => mark("read"));
      await drainContinuations();
      check(pending ? "" : "started");
      expect(owner.signal.aborted).toBe(false);
      release("finish");
      await checkpoint;
    });
    await work;
    (await admission)?.();
  },
);

it("does not await a maintenance dependency chain queued behind the admitted turn", async () => {
  await withSessionTurn({ ...turn, target }, async () => {
    start(
      "optional",
      { target, preemptible: true },
      () => wait("finishOptional"),
      () => {},
    );
    // Outbox replay can register nonpreemptible maintenance for another active session.
    start("dependent", {}, async () => {});
    const checkpoint = read().then(() => mark("read"));
    await drainContinuations();
    check("read");
    await checkpoint;
  });
  await wait("optional:start");
  check("read optional:start");
  release("finishOptional");
  await read();
  check("read optional:start optional:done dependent:start dependent:done");
});

it.each(
  [
    { placement: "external dependent", preemptible: false },
    { placement: "external dependent", preemptible: true },
    { placement: "nested independent", preemptible: false },
    { placement: "released parent", preemptible: false },
  ].flatMap(({ placement, preemptible }) =>
    (["read", "foreground"] as const).map((action) => ({ placement, preemptible, action })),
  ),
)(
  "orders child $action with $placement sibling (preemptible=$preemptible)",
  async ({ placement, action, preemptible }) => {
    const external = placement === "external dependent";
    let sibling: ReturnType<typeof start> | undefined;
    const startSibling = () => {
      sibling = start("sibling", { preemptible: external && !preemptible }, async () => {
        await read();
        await wait("finishSibling");
      });
    };
    const parent = start("parent", { preemptible }, async (owner) => {
      await wait("allowChild");
      if (!external) {
        if (placement === "nested independent") {
          startSibling();
        } else {
          owner.releaseWrites();
          expect(owner.assertCurrent).toThrow();
        }
        await wait("sibling:start");
      }
      const child = start("child", {}, async (childOwner) => {
        if (action === "read") {
          await read();
        } else {
          (await foreground())();
        }
        childOwner.assertCurrent();
        if (placement !== "released parent") {
          owner.assertCurrent();
        }
      });
      release("child:created");
      await child.work;
      await read();
      mark("parent:resume");
      await wait("finishParent");
    });
    let parentDone = false;
    void parent.done.then(() => {
      parentDone = true;
    });
    await wait("parent:start");
    if (placement !== "nested independent") {
      startSibling();
    }
    release("allowChild");
    await wait("child:created");
    // Drain non-I/O continuations so a dependency cycle fails the ordering assertion.
    await drainContinuations();
    check(
      external ? "parent:start child:start child:done parent:resume" : "parent:start sibling:start",
    );
    expect(parentDone).toBe(false);
    release("finishSibling");
    await wait("child:done");
    release("finishParent");
    await parent.work;
    await sibling?.work;
    const ordered = external
      ? ["child:done", "parent:done", "sibling:start"]
      : ["sibling:done", "child:start", "parent:done"];
    expect(events.filter((event) => ordered.includes(event))).toEqual(ordered);
    expect(parentDone).toBe(true);
  },
);
