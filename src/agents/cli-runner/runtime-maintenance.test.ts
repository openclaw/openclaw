import { expect, it } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { acquireCliRuntimeUse, withCliBackendMaintenance } from "./runtime-maintenance.js";

it("defers busy maintenance without blocking nested turns, then blocks admission during mutation", async ({
  signal,
}) => {
  const backend = "maintenance-order-fixture";
  const events: string[] = [];
  const releaseFirst = await acquireCliRuntimeUse(backend, signal, () => {});
  const finish = createDeferred();
  const pending: Promise<unknown>[] = [];
  let releaseNested: (() => void) | undefined;
  let releaseNext: (() => void) | undefined;
  try {
    const update = async () => {
      events.push("update");
      return "updated";
    };
    expect(await withCliBackendMaintenance(backend, signal, () => {}, update)).toBeUndefined();
    releaseNested = await acquireCliRuntimeUse(backend, signal, () => {});
    expect(events).toEqual([]);
    releaseNested();
    releaseFirst();
    const entered = createDeferred();
    const maintenance = withCliBackendMaintenance(
      backend,
      signal,
      () => {},
      async () => {
        entered.resolve();
        await finish.promise;
        return update();
      },
    );
    pending.push(maintenance);
    await withinTest(entered.promise, signal);
    const next = acquireCliRuntimeUse(backend, signal, () => {}).then((release) => {
      releaseNext = release;
      events.push("next turn");
    });
    pending.push(next);
    expect(events).toEqual([]);
    finish.resolve();
    expect(await maintenance).toBe("updated");
    await next;
    expect(events).toEqual(["update", "next turn"]);
  } finally {
    releaseFirst();
    releaseNested?.();
    finish.resolve();
    await Promise.allSettled(pending);
    releaseNext?.();
  }
});

it("does not let a cancelled queued update release a preceding active update", async ({
  signal,
}) => {
  const backend = "maintenance-cancel-fixture";
  const entered = createDeferred();
  const finish = createDeferred();
  const first = withCliBackendMaintenance(
    backend,
    signal,
    () => {},
    async () => {
      entered.resolve();
      await finish.promise;
    },
  );
  const controller = new AbortController();
  const cancelled = withCliBackendMaintenance(
    backend,
    controller.signal,
    () => {},
    async () => {
      throw new Error("Cancelled maintenance must not run");
    },
  );
  const rejected = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
  let successorEntered = false;
  const successor = withCliBackendMaintenance(
    backend,
    signal,
    () => {},
    async () => {
      successorEntered = true;
    },
  );
  try {
    await withinTest(entered.promise, signal);
    controller.abort();
    await rejected;
    expect(successorEntered).toBe(false);
    finish.resolve();
    await Promise.all([first, successor]);
    expect(successorEntered).toBe(true);
  } finally {
    finish.resolve();
    controller.abort();
    await Promise.allSettled([first, cancelled, successor]);
  }
});
