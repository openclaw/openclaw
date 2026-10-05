import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CODE_MODE_OUTPUT } from "./code-mode-json.js";
import { bindCodeModeSessionStore } from "./code-mode-session-store.js";
import { applyCodeModeCatalog, runCodeModeScriptHeadless } from "./code-mode.js";
import {
  createCodeModeHarness,
  createHeadlessCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  resultDetails,
  testing,
} from "./code-mode.test-support.js";
import { SessionManager } from "./sessions/session-manager.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const catalogs: Array<ReturnType<typeof createCodeModeHarness>["ctx"]> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const ctx of catalogs.splice(0)) {
    clearToolSearchCatalog(ctx);
  }
  await resetCodeModeTestState();
});

function harness(
  executor: "node" | "quickjs",
  manager = SessionManager.inMemory(),
  targets: AnyAgentTool[] = [],
) {
  const h = createCodeModeHarness({ codeMode: { executor } });
  h.ctx.sessionId = manager.getSessionId();
  catalogs.push(h.ctx);
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, ...targets] });
  bindCodeModeSessionStore(h.catalogRef, manager);
  return {
    ...h,
    manager,
    exec: async (code: string, restartSafe = false) =>
      h.tools[0]!.execute("store-cell", { code, restartSafe }),
    wait: async (runId: unknown) => h.tools[1]!.execute("store-wait", { runId }),
  };
}

describe.each(["node", "quickjs"] as const)("%s session store bridge", (executor) => {
  it("keeps detached JSON across cells, deletes keys, and rejects invalid keys", async () => {
    const h = harness(executor);
    const saved = resultDetails(
      await h.exec(`
      const original = { nested: [1], ["__proto__"]: "data" };
      const saved = await store("key", original);
      original.nested.push(2);
      const loaded = await load("key"); loaded.nested.push(3);
      await store("nullable", null);
      const errors = [];
      for (const key of ["", 2, null, "x".repeat(257), { toJSON() { return "coerced"; } }]) {
        try { await store(key, true); } catch (error) { errors.push(error instanceof TypeError); }
        try { await load(key); } catch (error) { errors.push(error instanceof TypeError); }
      }
      return { saved: saved === undefined, missing: (await load("missing")) === undefined,
        value: await load("key"), nullable: await load("nullable"), errors };
    `),
    );
    expect(saved, JSON.stringify(saved)).toMatchObject({
      status: "completed",
      value: {
        saved: true,
        missing: true,
        value: JSON.parse('{"nested":[1],"__proto__":"data"}'),
        nullable: null,
        errors: Array(10).fill(true),
      },
    });
    expect(
      resultDetails(
        await h.exec(`
      const value = await load("key");
      await store("key", undefined);
      return { value, deleted: (await load("key")) === undefined };
    `),
      ),
    ).toMatchObject({
      status: "completed",
      value: {
        value: JSON.parse('{"nested":[1],"__proto__":"data"}'),
        deleted: true,
      },
    });
    expect(resultDetails(await h.exec('return (await load("key")) === undefined;'))).toMatchObject({
      status: "completed",
      value: true,
    });
  });

  it("enforces encoded value and total limits atomically with guest RangeErrors", async () => {
    const h = harness(executor);
    const result = resultDetails(
      await h.exec(`
      const max = "x".repeat(256 * 1024 - 2);
      for (const key of ["a", "b", "c", "d"]) await store(key, max);
      const errors = [];
      for (const [key, value] of [["a", max + "x"], ["a", "é".repeat(128 * 1024)], ["e", 1]]) {
        try { await store(key, value); } catch (error) { errors.push(error instanceof RangeError); }
      }
      const unchanged = (await load("a")).length;
      await store("b", undefined);
      await store("e", 1);
      return { errors, unchanged, deleted: (await load("b")) === undefined, added: await load("e") };
    `),
    );
    expect(result).toMatchObject({
      status: "completed",
      value: {
        errors: [true, true, true],
        unchanged: 256 * 1024 - 2,
        deleted: true,
        added: 1,
      },
    });
  });

  it("keeps bridge provenance for uncaught typed store errors", async () => {
    const h = harness(executor);
    const result = resultDetails(await h.exec('await store("a", "x".repeat(256 * 1024));'));
    expect(result).toMatchObject({
      status: "failed",
      code: "internal_error",
      failurePhase: "bridge",
      bridgeDispatchStarted: true,
    });
    expect(String(result.error)).toMatch(/^RangeError/);
  });

  it("retains writes across wait, hides them from sibling cells, and commits once", async () => {
    const h = harness(executor);
    const first = resultDetails(
      await h.exec(`
      await store("key", 7); await yield_control();
      const before = await load("key"); await store("key", before + 1); return before;
    `),
    );
    expect(first.status).toBe("waiting");
    expect(h.manager.getBranch()).toEqual([]);
    expect(resultDetails(await h.exec('return (await load("key")) === undefined;'))).toMatchObject({
      status: "completed",
      value: true,
    });
    expect(resultDetails(await h.wait(first.runId))).toMatchObject({
      status: "completed",
      value: 7,
    });
    expect(h.manager.getBranch().filter((entry) => entry.type === "custom")).toHaveLength(1);
    expect(resultDetails(await h.exec('return await load("key");'))).toMatchObject({
      status: "completed",
      value: 8,
    });
  });

  it("discards writes from a failed cell", async () => {
    const h = harness(executor);
    expect(
      resultDetails(await h.exec('await store("key", 1); throw new Error("failed cell");')),
    ).toMatchObject({ status: "failed", error: expect.stringContaining("failed cell") });
    expect(h.manager.getBranch()).toEqual([]);
    expect(resultDetails(await h.exec('return (await load("key")) === undefined;'))).toMatchObject({
      status: "completed",
      value: true,
    });
  });

  it("carries network provenance through a persisted key into a later reply", async () => {
    const network = pluginToolWithExecute("network_fixture", "Read network fixture", async () =>
      jsonResult({ text: "untrusted fixture" }),
    );
    network.resultContentSource = "network";
    const h = harness(executor, undefined, [network]);
    expect(
      resultDetails(
        await h.exec('await store("network", await network_fixture({})); return true;'),
      ),
    ).toMatchObject({ status: "completed", value: true });
    clearToolSearchCatalog(h.ctx);
    const next = harness(executor, h.manager);
    const loaded = await next.exec('return (await load("network")).text;');
    expect(resultDetails(loaded)).toMatchObject({
      status: "completed",
      value: "untrusted fixture",
    });
    expect(loaded.content[0]).toMatchObject({
      text: expect.stringContaining("EXTERNAL_UNTRUSTED_CONTENT"),
    });
  });

  it("preserves the completed value and warns when transcript append fails", async () => {
    const h = harness(executor);
    vi.spyOn(h.manager, "appendCustomEntryAsync").mockRejectedValueOnce(
      new Error("fixture disk failure"),
    );
    expect(
      resultDetails(await h.exec('await store("key", 1); return { done: true };')),
    ).toMatchObject({
      status: "completed",
      value: { done: true },
      warnings: [expect.stringContaining("persistence could not be confirmed")],
    });
    expect(h.manager.getBranch()).toEqual([]);
    expect(resultDetails(await h.exec('return (await load("key")) === undefined;'))).toMatchObject({
      status: "completed",
      value: true,
    });
  });

  it("rejects unbound, restartSafe, and headless session-store access", async () => {
    const h = harness(executor);
    const safe = resultDetails(await h.exec('return await load("key");', true));
    expect(safe).toMatchObject({
      status: "failed",
      error: expect.stringContaining("restart-safe"),
    });
    const unbound = createCodeModeHarness({ codeMode: { executor } });
    catalogs.push(unbound.ctx);
    applyCodeModeCatalog({ ...unbound.ctx, tools: unbound.tools });
    expect(
      resultDetails(
        await unbound.tools[0]!.execute("unbound", { code: 'return await load("key");' }),
      ),
    ).toMatchObject({ status: "failed", error: expect.stringContaining("session") });
    const result = await runCodeModeScriptHeadless({
      ctx: createHeadlessCodeModeHarness([], { codeMode: { executor } }),
      code: 'await store("key", 1);',
    });
    expect(result).toMatchObject({ status: "failed", error: expect.stringContaining("headless") });
  });
});

it.each(["aborted", "expired", "disposed", "timeout"] as const)(
  "discards a parked cell's writes when %s",
  async (outcome) => {
    const h = harness("node");
    const parked = resultDetails(
      await h.exec('await store("key", 1); await yield_control(); return true;'),
    );
    expect(parked.status).toBe("waiting");
    const state = testing.activeRuns.get(String(parked.runId))!;
    if (outcome === "timeout") {
      vi.spyOn(state.continuation, "resume").mockResolvedValueOnce({
        status: "failed",
        code: "timeout",
        error: "fixture execution timeout",
        failurePhase: "host",
        bridgeDispatchStarted: false,
        output: EMPTY_CODE_MODE_OUTPUT,
      });
      expect(resultDetails(await h.wait(parked.runId))).toMatchObject({
        status: "failed",
        code: "timeout",
      });
    } else if (outcome === "expired") {
      testing.removeExpiredRuns(state.expiresAt + 1);
    } else if (outcome === "disposed") {
      clearToolSearchCatalog(h.ctx);
    } else {
      const controller = new AbortController();
      controller.abort();
      expect(
        resultDetails(
          await h.tools[1]!.execute("abort", { runId: parked.runId }, controller.signal),
        ),
      ).toMatchObject({ status: "failed", code: "aborted" });
    }
    await resetCodeModeTestState();
    expect(h.manager.getBranch()).toEqual([]);
    const next = harness("node", h.manager);
    expect(
      resultDetails(await next.exec('return (await load("key")) === undefined;')),
    ).toMatchObject({ status: "completed", value: true });
  },
);
