import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

afterEach(async () => {
  await resetCodeModeTestState();
  vi.useRealTimers();
});

it("keeps the 64-slot limit on suspensions, including a reserved active resume, not CPU-only exec", async () => {
  const entered = createDeferred();
  const release = createDeferred();
  let aborts = 0;
  const gate = pluginToolWithExecute(
    "capacity_gate",
    "Hold a resumed slot",
    async (_id, _args, signal) => {
      signal?.addEventListener(
        "abort",
        () => {
          aborts += 1;
        },
        { once: true },
      );
      entered.resolve();
      await release.promise;
      return jsonResult(true);
    },
  );
  const owners = Array.from({ length: 64 }, () => {
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, gate] });
    return h;
  });
  const ids: unknown[] = [];
  const extra = createCodeModeHarness();
  applyCodeModeCatalog({ ...extra.ctx, tools: extra.tools });
  let active: Promise<unknown> | undefined;
  try {
    // Four real VM starts at a time; no fabricated map entries or worker-count quota.
    for (let offset = 0; offset < owners.length; offset += 4) {
      await Promise.all(
        owners.slice(offset, offset + 4).map(async (h, index) => {
          const result = resultDetails(
            await h.tools[0]!.execute(`capacity-${offset + index}`, {
              code: "await yield_control(); await yield_control(); await capacity_gate({}); return true;",
            }),
          );
          expect(result.status).toBe("waiting");
          ids[offset + index] = result.runId;
        }),
      );
    }
    expect(new Set(ids).size).toBe(64);
    expect(testing.activeRuns.size).toBe(64);
    expect(
      resultDetails(
        await extra.tools[0]!.execute("cpu-at-capacity", {
          code: "let n=0; for(let i=0;i<1000;i++) n+=i; return n;",
        }),
      ),
    ).toMatchObject({ status: "completed", value: 499500 });
    const rejectSuspension = async () => {
      const result = resultDetails(
        await extra.tools[0]!.execute("overflow", { code: "await yield_control(); return true;" }),
      );
      expect(result).toMatchObject({
        status: "failed",
        code: "invalid_input",
        error: expect.stringContaining("too many suspended"),
      });
    };
    await rejectSuspension();
    const first = owners[0]!;
    const repark = resultDetails(
      await first.tools[1]!.execute("repark-at-capacity", { runId: ids[0] }),
    );
    expect(repark.status).toBe("waiting");
    ids[0] = repark.runId;
    active = first.tools[1]!.execute("active-at-capacity", { runId: ids[0] }).then(resultDetails);
    await entered.promise;
    expect(testing.activeRuns.size).toBe(63);
    await rejectSuspension();
    clearToolSearchCatalog(first.ctx);
    expect(await active).toMatchObject({ status: "failed", code: "aborted" });
    expect(aborts).toBe(1);
    const healthy = resultDetails(
      await extra.tools[0]!.execute("new-slot", {
        code: "await yield_control(); return 'healthy';",
      }),
    );
    expect(healthy.status).toBe("waiting");
    expect(testing.activeRuns.size).toBe(64);
    clearToolSearchCatalog(owners[1]!.ctx);
    expect(
      resultDetails(await extra.tools[1]!.execute("healthy-resume", { runId: healthy.runId })),
    ).toMatchObject({ status: "completed", value: "healthy" });
  } finally {
    release.resolve();
    owners.forEach((h) => clearToolSearchCatalog(h.ctx));
    clearToolSearchCatalog(extra.ctx);
    await active;
  }
  expect(testing.activeRuns.size).toBe(0);
  expect(testing.resumingRunIds.size).toBe(0);
});
