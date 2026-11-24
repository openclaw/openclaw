import fs from "node:fs/promises";
import { Socket } from "node:net";
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

it.for([
  { mode: "close", message: /synthetic close/ },
  { mode: "deadline", message: /deadline|timed out/i },
  { mode: "factory", message: /synthetic catalog capture refusal/ },
  { mode: "socket", message: /synthetic catalog socket refusal/ },
])(
  "joins catalog root preparation after %s without invoking the cancelled input",
  async ({ mode, message }, { signal }) => {
    await withOpenClawTestState({ label: "catalog-root-preparation" }, async (state) => {
      const source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
      const create = source.captureIndependentResource.bind(source);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      vi.spyOn(source, "captureIndependentResource").mockImplementation(async (...args) => {
        entered.resolve();
        if (mode === "socket") {
          vi.spyOn(Socket.prototype, "connect").mockImplementationOnce(() => {
            throw new Error("synthetic catalog socket refusal");
          });
          return create(...args);
        }
        if (mode === "factory") {
          return create(
            new URL(
              `data:text/javascript,${encodeURIComponent(
                'export function createNativeWorkerResource() { throw new Error("synthetic catalog capture refusal"); }',
              )}`,
            ),
          );
        }
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
      const settled = expect(
        pool.run(input, { timeoutMs: mode === "deadline" ? 50 : 30_000 }),
      ).rejects.toThrow(message);
      try {
        await withinTest(entered.promise, signal);
        if (mode === "close") {
          void pool.close(new Error("synthetic close during preparation")).catch(() => {});
        }
        await withinTest(settled, signal);
        expect(closed).toHaveBeenCalledTimes(1);
        expect(pool.isClosed).toBe(true);
      } finally {
        resume.resolve();
        await pool.close();
      }
      expect(input).not.toHaveBeenCalled();
      if (mode === "close" || mode === "deadline") {
        expect(await fs.readdir(path.join(state.stateDir, "tmp", "plugin-captures"))).toEqual([]);
      }
      expect(await source.retireIdleBroker()).toBe(true);
    });
  },
);
