import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { resetPreparedModelCatalogStateForTest } from "./prepared-model-runtime.test-support.js";

// mock-isolation: Resetting unloaded owners must never initialize the catalog runtime.
vi.mock("./model-catalog.js", () => {
  throw new Error("model catalog initialized during fixture reset");
});

const runtimeKey = Symbol.for("openclaw.preparedModelRuntimeTestApi");
const catalogKey = Symbol.for("openclaw.modelCatalogTestApi");
const globals = globalThis as Record<PropertyKey, unknown>;
let previousRuntime: unknown;
let previousCatalog: unknown;

beforeEach(() => {
  previousRuntime = globals[runtimeKey];
  previousCatalog = globals[catalogKey];
  delete globals[runtimeKey];
  delete globals[catalogKey];
});

afterEach(() => {
  if (previousRuntime === undefined) {
    delete globals[runtimeKey];
  } else {
    globals[runtimeKey] = previousRuntime;
  }
  if (previousCatalog === undefined) {
    delete globals[catalogKey];
  } else {
    globals[catalogKey] = previousCatalog;
  }
});

it("leaves unloaded model owners unloaded during fixture reset", async () => {
  await expect(resetPreparedModelCatalogStateForTest()).resolves.toBeUndefined();
});

it("joins the loaded runtime before clearing the catalog builder", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  const cleared: string[] = [];
  globals[runtimeKey] = {
    resetPreparedModelRuntimeSnapshotsForTest: async () => {
      entered.resolve();
      await release.promise;
      cleared.push("runtime");
    },
  };
  globals[catalogKey] = {
    resetModelCatalogBuilderCacheForTest: () => cleared.push("catalog"),
  };
  const resetting = resetPreparedModelCatalogStateForTest();
  try {
    await awaitGateBeforeSettlement(
      entered.promise,
      resetting,
      "fixture reset settled before joining the loaded runtime",
    );
    expect(cleared).toEqual([]);
  } finally {
    release.resolve();
    await resetting;
  }
  expect(cleared).toEqual(["runtime", "catalog"]);
});
