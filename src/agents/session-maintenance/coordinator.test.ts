import { setImmediate as drainContinuations } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  readOperatorToolGatewayAuthority,
  runWithOperatorToolGatewayAuthority,
} from "../../gateway/operator-tool-gateway-authority.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { runWithSessionControllerCleanup } from "../../sessions/session-controller.owner-context.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { drainGlobalSingletonLifecycleState } from "../../shared/global-singleton.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../tools/gateway-caller-context.js";
import {
  beginForegroundSessionMaintenance,
  createSessionMaintenanceOwner as createMaintenanceOwner,
  waitForSessionMaintenance,
} from "./coordinator.js";

const sessionKey = "session:maintenance";
const turn = { sessionKey, sessionId: "maintenance", storePath: "/maintenance/current" };
const target = captureSessionTarget({
  storeScope: turn.storePath,
  sessionKey,
  incarnation: turn.sessionId,
});
type OwnerOptions = Omit<Parameters<typeof createMaintenanceOwner>[0], "sessionKey">;
type MaintenanceWork = (owner: ReturnType<typeof createOwner>) => Promise<void>;

const createOwner = (options: OwnerOptions = {}) =>
  createMaintenanceOwner({ sessionKey, ...options });

function createTrackedOwner(options: OwnerOptions = {}) {
  const owner = createOwner(options);
  return {
    ...owner,
    run: <T>(...work: Parameters<typeof owner.run<T>>) => owner.track(owner.run<T>(...work)),
  };
}

function createScenario() {
  const events: string[] = [];
  const gates = new Map<string, ReturnType<typeof createDeferred<void>>>();
  const jobs: Promise<void>[] = [];
  function gate(name: string) {
    const deferred = gates.get(name) ?? createDeferred();
    gates.set(name, deferred);
    return deferred;
  }
  const release = (...names: string[]) => names.forEach((name) => gate(name).resolve());
  const mark = (name: string) => {
    events.push(name);
    release(name);
  };
  return {
    events,
    mark,
    release,
    wait: (name: string) => gate(name).promise,
    check(expected: string) {
      expect(events).toEqual(expected.split(" "));
    },
    start(name: string, work: MaintenanceWork, options: OwnerOptions = {}) {
      const owner = createTrackedOwner(options);
      const job = owner.run(async () => {
        mark(`${name}:start`);
        await work(owner);
        mark(`${name}:done`);
      });
      jobs.push(job);
      return { ...owner, work: job };
    },
    async settle(...names: string[]) {
      release(...names);
      await Promise.allSettled(jobs);
    },
  };
}

afterEach(() => drainGlobalSingletonLifecycleState("close"));

it.each([false, true])(
  "drops retired caller/operator authority (optional=%s)",
  async (preemptible) => {
    const source = new AbortController();
    const operator = {
      scopes: ["operator.admin"],
      signal: source.signal,
      assertCurrent: () => source.signal.throwIfAborted(),
    };
    await runWithOperatorToolGatewayAuthority(operator, () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "session:source",
          receiptAuthority: () => !source.signal.aborted,
        },
        async () => {
          const caller = getGatewayToolCallerIdentity();
          expect(caller?.receiptAuthority?.()).toBe(true);
          const owner = createTrackedOwner({ preemptible });
          const work = owner.run(async () => {
            expect(getGatewayToolCallerIdentity()).toBeUndefined();
            expect(readOperatorToolGatewayAuthority()).toBeUndefined();
            await Promise.resolve();
            owner.assertCurrent();
            expect(getGatewayToolCallerIdentity()).toBeUndefined();
            expect(readOperatorToolGatewayAuthority()).toBeUndefined();
            return "maintenance completed";
          });
          source.abort();
          await expect(work).resolves.toBe("maintenance completed");
          expect(getGatewayToolCallerIdentity()).toBe(caller);
          expect(caller?.receiptAuthority?.()).toBe(false);
          expect(readOperatorToolGatewayAuthority()).toBe(operator);
          expect(operator.assertCurrent).toThrow();
        },
      ),
    );
  },
);

it("aborts optional work before admitting foreground and waits for its actual cleanup", async () => {
  const s = createScenario();
  const owner = s.start(
    "optional",
    async (current) => {
      try {
        await s.wait("aborted");
        current.assertCurrent();
      } finally {
        s.mark("cleanup:start");
        await s.wait("finishCleanup");
        s.mark("cleanup:finish");
      }
    },
    { preemptible: true },
  );
  owner.signal.addEventListener("abort", () => s.release("aborted"), { once: true });
  const rejection = expect(owner.work).rejects.toMatchObject({ name: "AbortError" });
  await s.wait("optional:start");
  const admission = beginForegroundSessionMaintenance(sessionKey).then((release) => {
    s.mark("foreground:admit");
    return release;
  });
  try {
    await s.wait("cleanup:start");
    expect(owner.signal.aborted).toBe(true);
    s.check("optional:start cleanup:start");
  } finally {
    s.release("finishCleanup");
    (await admission)();
    await rejection;
  }
  s.check("optional:start cleanup:start cleanup:finish foreground:admit");
});

it("keeps optional work pending until every foreground reservation releases without blocking reads", async () => {
  const releaseFirst = await beginForegroundSessionMaintenance(sessionKey);
  const releaseSecond = await beginForegroundSessionMaintenance(sessionKey);
  const owner = createTrackedOwner({ preemptible: true });
  const state = { admitted: false, ran: false };
  const work = owner.run({
    admit: (run) =>
      withSessionTurn(turn, () => {
        state.admitted = true;
        return run(async () => {
          owner.assertCurrent();
          state.ran = true;
        });
      }),
  });
  try {
    await waitForSessionMaintenance(sessionKey);
    expect(state).toEqual({ admitted: false, ran: false });

    releaseFirst();
    releaseFirst();
    await waitForSessionMaintenance(sessionKey);
    expect(state).toEqual({ admitted: false, ran: false });
    expect(owner.signal.aborted).toBe(false);
  } finally {
    releaseFirst();
    releaseSecond();
    await work;
  }
  expect(state.ran).toBe(true);
});

it.each(["pending-other-store", "running-writer", "non-preemptible"] as const)(
  "waits for %s maintenance before reads and foreground admission",
  async (mode) => {
    const owner = createOwner({
      target:
        mode === "pending-other-store"
          ? captureSessionTarget({ ...target, storeScope: "/maintenance/other" })
          : target,
      preemptible: mode !== "non-preemptible",
    });
    const release = createDeferred();
    const started = createDeferred();
    const work = owner.track(
      mode !== "pending-other-store"
        ? owner.run(async () => {
            started.resolve();
            await release.promise;
          })
        : release.promise,
    );
    if (mode !== "pending-other-store") {
      await started.promise;
    }
    const observed = { read: false, foreground: false };
    const admission =
      mode === "non-preemptible"
        ? beginForegroundSessionMaintenance(sessionKey).then((releaseForeground) => {
            observed.foreground = true;
            return releaseForeground;
          })
        : undefined;
    try {
      (await beginForegroundSessionMaintenance("session:other"))();
      await waitForSessionMaintenance("session:other");
      await withSessionTurn({ ...turn, target }, async () => {
        const checkpoint = waitForSessionMaintenance(sessionKey).then(() => {
          observed.read = true;
        });
        await drainContinuations();
        expect(observed).toEqual({ read: false, foreground: false });
        expect(owner.signal.aborted).toBe(false);
        release.resolve();
        await checkpoint;
        expect(observed.read).toBe(true);
      });
    } finally {
      release.resolve();
      await work;
      (await admission)?.();
    }
    expect(observed.foreground).toBe(mode === "non-preemptible");
  },
);

it("does not await a maintenance dependency chain queued behind the admitted turn", async () => {
  const s = createScenario();
  let optionalWork = Promise.resolve();
  let dependentWork = Promise.resolve();
  try {
    await withSessionTurn({ ...turn, target }, async () => {
      const optional = createOwner({ target, preemptible: true });
      optionalWork = optional.track(
        runWithSessionControllerCleanup(() =>
          optional.run<void>({
            admit: (run) =>
              withSessionTurn({ ...turn, target }, () =>
                run(async () => {
                  s.mark("optional");
                  await s.wait("finishOptional");
                }),
              ),
          }),
        ),
      );
      // Outbox replay can register nonpreemptible engine maintenance for another active session.
      const dependent = createTrackedOwner();
      dependentWork = dependent.run(async () => s.mark("dependent"));
      const checkpoint = waitForSessionMaintenance(sessionKey).then(() => s.mark("read"));
      await drainContinuations();
      s.check("read");
      await checkpoint;
    });
    await s.wait("optional");
    s.check("read optional");
    s.release("finishOptional");
    await Promise.all([optionalWork, dependentWork]);
    s.check("read optional dependent");
  } finally {
    s.release("finishOptional");
    await Promise.allSettled([optionalWork, dependentWork]);
  }
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
    const s = createScenario();
    let child: ReturnType<typeof s.start> | undefined;
    let sibling: ReturnType<typeof s.start> | undefined;
    const startSibling = () => {
      sibling = s.start(
        "sibling",
        async () => {
          await Promise.race([waitForSessionMaintenance(sessionKey), s.wait("stop")]);
          await s.wait("finishSibling");
        },
        { preemptible: placement === "external dependent" && !preemptible },
      );
    };
    const parent = s.start(
      "parent",
      async (owner) => {
        await s.wait("allowChild");
        if (placement === "nested independent") {
          startSibling();
          await s.wait("sibling:start");
        } else if (placement === "released parent") {
          owner.releaseWrites();
          await s.wait("sibling:start");
        }
        child = s.start("child", async (childOwner) => {
          if (action === "read") {
            await waitForSessionMaintenance(sessionKey);
          } else {
            (await beginForegroundSessionMaintenance(sessionKey))();
          }
          childOwner.assertCurrent();
          if (placement !== "released parent") {
            owner.assertCurrent();
          }
        });
        s.release("child:created");
        await child.work;
        await waitForSessionMaintenance(sessionKey);
        s.mark("parent:resume");
        await s.wait("finishParent");
      },
      { preemptible },
    );
    try {
      await s.wait("parent:start");
      if (placement !== "nested independent") {
        startSibling();
      }
      s.release("allowChild");
      await s.wait("child:created");
      // Drain non-I/O continuations so a dependency cycle fails the ordering assertion.
      await drainContinuations();
      if (placement === "external dependent") {
        s.check("parent:start child:start child:done parent:resume");
      } else {
        s.check("parent:start sibling:start");
        s.release("finishSibling");
        await s.wait("child:done");
      }
      s.release("finishParent");
      await parent.work;
      await s.wait("sibling:start");
      s.release("finishSibling");
      await sibling?.work;
      const ordered =
        placement === "external dependent"
          ? ["child:done", "parent:done", "sibling:start"]
          : ["sibling:done", "child:start", "parent:done"];
      expect(s.events.filter((event) => ordered.includes(event))).toEqual(ordered);
    } finally {
      // Release the failed fixture's cycle, then await real tracked completion.
      s.release("stop", "allowChild", "finishParent", "finishSibling");
      parent.releaseWrites();
      child?.releaseWrites();
      await s.settle();
    }
    await waitForSessionMaintenance(sessionKey);
  },
);

it("releases writes after disposal while retaining completion ownership of an external rerun", async () => {
  const s = createScenario();
  const parent = s.start("parent", async (owner) => {
    await s.wait("finishDisposal");
    owner.releaseWrites();
    expect(owner.assertCurrent).toThrow();
    s.mark("parent:released");
    await child.work;
  });
  await s.wait("parent:start");
  const child = s.start("child", async () => {
    await Promise.race([waitForSessionMaintenance(sessionKey), s.wait("stop")]);
    s.mark("child:read");
    await s.wait("finishChild");
  });
  let parentDone = false;
  void parent.done.then(() => {
    parentDone = true;
  });
  try {
    s.check("parent:start");
    s.release("finishDisposal");
    await s.wait("child:read");
    s.check("parent:start parent:released child:start child:read");
    expect(parentDone).toBe(false);
    s.release("finishChild");
    await Promise.all([parent.work, child.work, parent.done]);
    expect(s.events.slice(-2)).toEqual(["child:done", "parent:done"]);
    expect(parentDone).toBe(true);
  } finally {
    await s.settle("stop", "finishDisposal", "finishChild");
  }
});

it.each(["fulfilled", "rejected"] as const)("fences after %s completion", async (outcome) => {
  const owner = createOwner();
  const assertCurrent = owner.assertCurrent;
  const error = new Error("maintenance failed");
  const work = owner.track(
    outcome === "fulfilled" ? Promise.resolve("completed") : Promise.reject(error),
  );
  expect(assertCurrent).not.toThrow();
  if (outcome === "fulfilled") {
    await expect(work).resolves.toBe("completed");
  } else {
    await expect(work).rejects.toBe(error);
  }

  expect(assertCurrent).toThrow();
  await waitForSessionMaintenance(sessionKey);
});

it.each(["close", "restart"] as const)("aborts and fences on %s", async (event) => {
  const finish = createDeferred();
  const owner = createOwner();
  const assertCurrent = owner.assertCurrent;
  const work = owner.track(finish.promise);
  const rotation = drainGlobalSingletonLifecycleState(event);
  try {
    expect(owner.signal.aborted).toBe(true);
    expect(assertCurrent).toThrow();
  } finally {
    finish.resolve();
    await Promise.all([work, rotation]);
  }
  const successor = createTrackedOwner();
  await successor.run(async () => successor.assertCurrent());
  expect(assertCurrent).toThrow();
});
