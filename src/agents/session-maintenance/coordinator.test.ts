import { afterEach, describe, expect, it } from "vitest";
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
  createSessionMaintenanceOwner as createOwner,
  waitForSessionMaintenance,
} from "./coordinator.js";

function createTrackedOwner(...args: Parameters<typeof createOwner>) {
  const owner = createOwner(...args);
  return {
    ...owner,
    run: <T>(...work: Parameters<typeof owner.run<T>>) => owner.track(owner.run<T>(...work)),
  };
}

const drainContinuations = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

afterEach(async () => {
  await drainGlobalSingletonLifecycleState("close");
});

describe("session maintenance ownership", () => {
  it.each([false, true])(
    "runs without retired caller or operator authority (preemptible=%s)",
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
            const owner = createTrackedOwner({
              sessionKey: "session:detached",
              preemptible,
            });
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
    const started = createDeferred();
    const aborted = createDeferred();
    const cleanupStarted = createDeferred();
    const finishCleanup = createDeferred();
    const events: string[] = [];
    const owner = createTrackedOwner({
      sessionKey: "session:cancel",
      preemptible: true,
    });
    owner.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    const work = owner.run(async () => {
      started.resolve();
      try {
        await aborted.promise;
        owner.assertCurrent();
      } finally {
        events.push("cleanup:start");
        cleanupStarted.resolve();
        await finishCleanup.promise;
        events.push("cleanup:finish");
      }
    });
    const rejection = expect(work).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;

    const admission = beginForegroundSessionMaintenance("session:cancel").then((release) => {
      events.push("foreground:admit");
      return release;
    });
    try {
      await cleanupStarted.promise;
      expect(owner.signal.aborted).toBe(true);
      expect(events).toEqual(["cleanup:start"]);
    } finally {
      finishCleanup.resolve();
      (await admission)();
      await rejection;
    }
    expect(events).toEqual(["cleanup:start", "cleanup:finish", "foreground:admit"]);
    await owner.done;
  });

  it("keeps optional work pending until every foreground reservation releases without blocking reads", async () => {
    const releaseFirst = await beginForegroundSessionMaintenance("session:pending");
    const releaseSecond = await beginForegroundSessionMaintenance("session:pending");
    const owner = createTrackedOwner({
      sessionKey: "session:pending",
      preemptible: true,
    });
    let ran = false;
    let admitted = false;
    const work = owner.run({
      admit: (run) =>
        withSessionTurn(
          {
            sessionKey: "session:pending",
            sessionId: "pending",
            storePath: "/maintenance/pending",
          },
          () => {
            admitted = true;
            return run(async () => {
              owner.assertCurrent();
              ran = true;
            });
          },
        ),
    });
    try {
      await waitForSessionMaintenance("session:pending");
      expect(admitted).toBe(false);
      expect(ran).toBe(false);

      releaseFirst();
      releaseFirst();
      await waitForSessionMaintenance("session:pending");
      expect(admitted).toBe(false);
      expect(ran).toBe(false);
      expect(owner.signal.aborted).toBe(false);
    } finally {
      releaseFirst();
      releaseSecond();
      await work;
    }
    expect(ran).toBe(true);
  });

  it("admits another session while non-preemptible maintenance keeps its own session waiting", async () => {
    const started = createDeferred();
    const finish = createDeferred();
    const owner = createTrackedOwner({ sessionKey: "session:busy" });
    const work = owner.run(async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    let busyAdmitted = false;
    const busyAdmission = beginForegroundSessionMaintenance("session:busy").then((release) => {
      busyAdmitted = true;
      return release;
    });
    try {
      const releaseOther = await beginForegroundSessionMaintenance("session:other");
      releaseOther();
      await waitForSessionMaintenance("session:other");
      expect(busyAdmitted).toBe(false);
      expect(owner.signal.aborted).toBe(false);
    } finally {
      finish.resolve();
      await work;
      (await busyAdmission)();
    }
    expect(busyAdmitted).toBe(true);
  });

  it.each(["pending-other-store", "running-writer", "non-preemptible"] as const)(
    "keeps the admitted read checkpoint waiting for %s maintenance",
    async (mode) => {
      const sessionKey = `session:checkpoint:${mode}`;
      const target = captureSessionTarget({
        storeScope: "/maintenance/current",
        sessionKey,
        incarnation: mode,
      });
      const owner = createOwner({
        sessionKey,
        target:
          mode === "pending-other-store"
            ? captureSessionTarget({ ...target, storeScope: "/maintenance/other" })
            : target,
        preemptible: mode !== "non-preemptible",
      });
      const release = createDeferred();
      const started = createDeferred();
      const work = owner.track(
        mode === "running-writer"
          ? owner.run(async () => {
              started.resolve();
              await release.promise;
            })
          : release.promise,
      );
      if (mode === "running-writer") {
        await started.promise;
      }
      try {
        await withSessionTurn({ sessionKey, sessionId: mode, target }, async () => {
          let readCompleted = false;
          const checkpoint = waitForSessionMaintenance(sessionKey).then(() => {
            readCompleted = true;
          });
          await drainContinuations();
          expect(readCompleted).toBe(false);
          release.resolve();
          await checkpoint;
          expect(readCompleted).toBe(true);
        });
      } finally {
        release.resolve();
        await work;
      }
    },
  );

  it("does not await a maintenance dependency chain queued behind the admitted turn", async () => {
    const sessionKey = "session:pending-dependency";
    const target = captureSessionTarget({
      storeScope: "/maintenance/dependency",
      sessionKey,
      incarnation: "dependency",
    });
    const finishOptional = createDeferred();
    const optionalStarted = createDeferred();
    const events: string[] = [];
    let optionalWork = Promise.resolve();
    let dependentWork = Promise.resolve();
    try {
      await withSessionTurn({ sessionKey, sessionId: "dependency", target }, async () => {
        const optional = createOwner({ sessionKey, target, preemptible: true });
        optionalWork = optional.track(
          runWithSessionControllerCleanup(() =>
            optional.run<void>({
              admit: (run) =>
                withSessionTurn({ sessionKey, sessionId: "dependency", target }, () =>
                  run(async () => {
                    events.push("optional");
                    optionalStarted.resolve();
                    await finishOptional.promise;
                  }),
                ),
            }),
          ),
        );
        // Outbox replay can register nonpreemptible engine maintenance for another active session.
        const dependent = createTrackedOwner({ sessionKey });
        dependentWork = dependent.run(async () => {
          events.push("dependent");
        });
        const checkpoint = waitForSessionMaintenance(sessionKey).then(() => events.push("read"));
        await drainContinuations();
        expect(events).toEqual(["read"]);
        await checkpoint;
      });
      await optionalStarted.promise;
      expect(events).toEqual(["read", "optional"]);
      finishOptional.resolve();
      await Promise.all([optionalWork, dependentWork]);
      expect(events).toEqual(["read", "optional", "dependent"]);
    } finally {
      finishOptional.resolve();
      await Promise.allSettled([optionalWork, dependentWork]);
    }
  });

  it.each([true, false])(
    "serializes independent siblings and lets the older owner read with preemptible=%s",
    async (preemptible) => {
      const sessionKey = `session:siblings:${preemptible}`;
      const started = createDeferred();
      const allowRead = createDeferred();
      const readCompleted = createDeferred();
      const finishOlder = createDeferred();
      const stop = createDeferred();
      const events: string[] = [];
      const older = createTrackedOwner({ sessionKey, preemptible });
      const olderWork = older.run(async () => {
        events.push("older:start");
        started.resolve();
        await allowRead.promise;
        await Promise.race([waitForSessionMaintenance(sessionKey), stop.promise]);
        events.push("older:read");
        readCompleted.resolve();
        await finishOlder.promise;
        events.push("older:finish");
      });
      await started.promise;
      const younger = createTrackedOwner({ sessionKey, preemptible: !preemptible });
      const youngerWork = younger.run(async () => {
        events.push("younger:start");
        await Promise.race([waitForSessionMaintenance(sessionKey), stop.promise]);
        events.push("younger:read");
      });
      try {
        expect(events).toEqual(["older:start"]);
        allowRead.resolve();
        await readCompleted.promise;
        expect(events).toEqual(["older:start", "older:read"]);
        finishOlder.resolve();
        await Promise.all([olderWork, youngerWork]);
        expect(events).toEqual([
          "older:start",
          "older:read",
          "older:finish",
          "younger:start",
          "younger:read",
        ]);
      } finally {
        // Unblock fixture reads after an ordering failure so real owner cleanup still runs.
        stop.resolve();
        allowRead.resolve();
        finishOlder.resolve();
        await Promise.allSettled([olderWork, youngerWork]);
      }
    },
  );

  it.each(
    (["external dependent", "nested independent", "released parent"] as const).flatMap(
      (placement) => (["read", "foreground"] as const).map((action) => ({ placement, action })),
    ),
  )("orders child $action with $placement sibling", async ({ placement, action }) => {
    const sessionKey = `session:combined:${placement}:${action}`;
    const parentStarted = createDeferred();
    const allowChild = createDeferred();
    const childCreated = createDeferred();
    const childCompleted = createDeferred();
    const siblingStarted = createDeferred();
    const finishSibling = createDeferred();
    const finishParent = createDeferred();
    const events: string[] = [];
    const parent = createTrackedOwner({ sessionKey });
    let child: ReturnType<typeof createTrackedOwner> | undefined;
    let childWork: Promise<void> = Promise.resolve();
    let siblingWork: Promise<void> = Promise.resolve();
    const startSibling = () => {
      const sibling = createTrackedOwner({ sessionKey });
      siblingWork = sibling.run(async () => {
        events.push("sibling:start");
        siblingStarted.resolve();
        await finishSibling.promise;
        events.push("sibling:done");
      });
    };
    const parentWork = parent.run(async () => {
      events.push("parent:start");
      parentStarted.resolve();
      await allowChild.promise;
      if (placement === "nested independent") {
        startSibling();
        await siblingStarted.promise;
      } else if (placement === "released parent") {
        parent.releaseWrites();
        await siblingStarted.promise;
      }
      const childOwner = createTrackedOwner({ sessionKey });
      child = childOwner;
      childWork = childOwner.run(async () => {
        events.push("child:start");
        if (action === "read") {
          await waitForSessionMaintenance(sessionKey);
        } else {
          const release = await beginForegroundSessionMaintenance(sessionKey);
          release();
        }
        childOwner.assertCurrent();
        if (placement !== "released parent") {
          parent.assertCurrent();
        }
        events.push("child:done");
        childCompleted.resolve();
      });
      childCreated.resolve();
      await childWork;
      await waitForSessionMaintenance(sessionKey);
      events.push("parent:resume");
      await finishParent.promise;
      events.push("parent:done");
    });
    try {
      await parentStarted.promise;
      if (placement !== "nested independent") {
        startSibling();
      }
      allowChild.resolve();
      await childCreated.promise;
      // These owner waits have no I/O: drain the scheduled continuations without
      // relying on a test timeout to discover a circular dependency.
      await drainContinuations();
      if (placement === "external dependent") {
        expect([...events]).toEqual(["parent:start", "child:start", "child:done", "parent:resume"]);
      } else {
        expect([...events]).toEqual(["parent:start", "sibling:start"]);
        finishSibling.resolve();
        await childCompleted.promise;
      }
      finishParent.resolve();
      await parentWork;
      await siblingStarted.promise;
      finishSibling.resolve();
      await siblingWork;
      const ordered =
        placement === "external dependent"
          ? ["child:done", "parent:done", "sibling:start"]
          : ["sibling:done", "child:start", "parent:done"];
      expect(events.filter((event) => ordered.includes(event))).toEqual(ordered);
    } finally {
      // Break a failed fixture's dependency cycle only after its ordering assertion;
      // actual tracked completion still settles every owner before teardown.
      allowChild.resolve();
      finishParent.resolve();
      finishSibling.resolve();
      parent.releaseWrites();
      child?.releaseWrites();
      await Promise.allSettled([parentWork, siblingWork, childWork]);
    }
    await waitForSessionMaintenance(sessionKey);
  });

  it("releases writes after disposal while retaining completion ownership of an external rerun", async () => {
    const sessionKey = "session:external-rerun";
    const disposing = createDeferred();
    const finishDisposal = createDeferred();
    const childRead = createDeferred();
    const finishChild = createDeferred();
    const stop = createDeferred();
    const events: string[] = [];
    const parent = createTrackedOwner({ sessionKey });
    let childWork: Promise<void> = Promise.resolve();
    const parentWork = parent.run(async () => {
      events.push("parent:dispose");
      disposing.resolve();
      await finishDisposal.promise;
      parent.releaseWrites();
      expect(parent.assertCurrent).toThrow();
      events.push("parent:released");
      await childWork;
      events.push("parent:done");
    });
    await disposing.promise;
    const child = createTrackedOwner({ sessionKey });
    childWork = child.run(async () => {
      events.push("child:start");
      await Promise.race([waitForSessionMaintenance(sessionKey), stop.promise]);
      events.push("child:read");
      childRead.resolve();
      await finishChild.promise;
      events.push("child:done");
    });
    let parentDone = false;
    void parent.done.then(() => {
      parentDone = true;
    });
    try {
      expect(events).toEqual(["parent:dispose"]);
      finishDisposal.resolve();
      await childRead.promise;
      expect(events).toEqual(["parent:dispose", "parent:released", "child:start", "child:read"]);
      expect(parentDone).toBe(false);
      finishChild.resolve();
      await Promise.all([parentWork, childWork, parent.done]);
      expect(events.slice(-2)).toEqual(["child:done", "parent:done"]);
      expect(parentDone).toBe(true);
    } finally {
      stop.resolve();
      finishDisposal.resolve();
      finishChild.resolve();
      await Promise.allSettled([parentWork, childWork]);
    }
  });

  it.each(["fulfilled", "rejected"] as const)(
    "fences a retained assertion after tracked work is %s",
    async (outcome) => {
      const owner = createOwner({ sessionKey: `session:settled:${outcome}` });
      const assertCurrent = owner.assertCurrent;
      const completion = createDeferred<string>();
      const work = owner.track(completion.promise);
      expect(assertCurrent).not.toThrow();
      if (outcome === "fulfilled") {
        completion.resolve("completed");
        await expect(work).resolves.toBe("completed");
      } else {
        const error = new Error("maintenance failed");
        const rejection = expect(work).rejects.toBe(error);
        completion.reject(error);
        await rejection;
      }

      await owner.done;
      expect(assertCurrent).toThrow();
      await waitForSessionMaintenance(`session:settled:${outcome}`);
    },
  );

  it.each(["close", "restart"] as const)(
    "aborts active maintenance and fences retained authority on process %s",
    async (event) => {
      const finish = createDeferred();
      const owner = createOwner({ sessionKey: `session:lifecycle:${event}` });
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
      const successor = createTrackedOwner({ sessionKey: `session:lifecycle:${event}` });
      await successor.run(async () => {
        successor.assertCurrent();
      });
      expect(assertCurrent).toThrow();
    },
  );
});
