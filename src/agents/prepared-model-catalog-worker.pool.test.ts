import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CatalogWorkerTaskPool } from "./prepared-model-catalog-worker.pool.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDefaultRetainedNativeWorkerSource();
});

it.for(["close", "deadline"] as const)(
  "joins catalog root preparation after %s without invoking the cancelled input",
  async (mode, { signal }) => {
    await withOpenClawTestState({ label: "catalog-root-preparation" }, async (state) => {
      const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      const create = source.captureIndependentResource.bind(source);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      vi.spyOn(source, "captureIndependentResource").mockImplementation(async (...args) => {
        entered.resolve();
        await resume.promise;
        return create(...args);
      });
      const closed = vi.fn();
      const pool = new CatalogWorkerTaskPool<unknown, unknown>(
        state.env,
        () => {},
        undefined,
        closed,
      );
      const input = vi.fn(() => ({}));
      const running = pool.run(input, { timeoutMs: mode === "deadline" ? 50 : 30_000 });
      const settled = Promise.allSettled([running]);
      try {
        await withinTest(entered.promise, signal);
        if (mode === "close") {
          void pool.close(new Error("synthetic close during preparation")).catch(() => {});
        }
        const [outcome] = await withinTest(settled, signal);
        expect(outcome.status).toBe("rejected");
        expect(closed).toHaveBeenCalledTimes(1);
        expect(pool.isClosed).toBe(true);
      } finally {
        resume.resolve();
        await pool.close();
      }
      expect(input).not.toHaveBeenCalled();
      const roots = await fs.readdir(path.join(state.stateDir, "tmp", "plugin-captures"));
      expect(roots).toEqual([]);
      expect(await source.retireIdleBroker()).toBe(true);
    });
  },
);

it("closes catalog admission once when the real capture resource factory refuses creation", async () => {
  await withOpenClawTestState({ label: "catalog-root-failure" }, async (state) => {
    const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    const create = source.captureIndependentResource.bind(source);
    vi.spyOn(source, "captureIndependentResource").mockImplementation(() =>
      create(
        new URL(
          `data:text/javascript,${encodeURIComponent(
            'export function createNativeWorkerResource() { throw new Error("synthetic catalog capture refusal"); }',
          )}`,
        ),
      ),
    );
    const closed = vi.fn();
    const pool = new CatalogWorkerTaskPool<unknown, unknown>(
      state.env,
      () => {},
      undefined,
      closed,
    );
    const input = vi.fn(() => ({}));
    await expect(pool.run(input, { timeoutMs: 30_000 })).rejects.toThrow(
      "synthetic catalog capture refusal",
    );
    await expect(pool.close()).rejects.toThrow("synthetic catalog capture refusal");
    expect(closed).toHaveBeenCalledTimes(1);
    expect(input).not.toHaveBeenCalled();
    expect(pool.isClosed).toBe(true);
    expect(await source.retireIdleBroker()).toBe(true);
  });
});
