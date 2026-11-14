import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getSession, waitForExecSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { nodeCommand } from "./bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import {
  createCatalogCodeModeHarness,
  pluginToolWithExecute,
  resetCodeModeTestState,
  testing,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult } from "./tools/common.js";

afterEach(resetCodeModeTestState);

it("keeps the suspension limit while required observers collect existing process results", async ({
  onTestFinished,
}) => {
  const state = await createOpenClawTestState({ label: "capacity-observer" });
  const scopeKey = "capacity-observer";
  const closeScope = getProcessSupervisor().acquireScopeCleanup(scopeKey, {
    processTree: "required-all",
  });
  onTestFinished(async () => {
    await closeScope();
    resetProcessRegistryForTests();
    await state.cleanup();
  });
  const shell = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    scopeKey,
    cwd: state.workspaceDir,
    notifyOnExit: false,
  });
  const observer = createProcessTool({ scopeKey });
  const launched = vi.spyOn(shell, "execute");
  const observed = vi.spyOn(observer, "execute");
  const entered = createDeferred();
  const release = createDeferred();
  const aborted = vi.fn();
  const gate = pluginToolWithExecute(
    "capacity_gate",
    "Hold a resumed slot",
    async (_id, _args, signal) => {
      signal?.addEventListener("abort", aborted, { once: true });
      entered.resolve();
      await release.promise;
      return jsonResult(true);
    },
  );
  const owners = Array.from({ length: 64 }, () => createCatalogCodeModeHarness([gate]));
  const ids: unknown[] = [];
  const extra = createCatalogCodeModeHarness([shell, observer]);
  let active: Promise<unknown> | undefined;
  try {
    const started = await extra.run(
      `return await exec(${JSON.stringify({ command: nodeCommand('process.stdout.write("benchmark-result")'), background: true })});`,
      "launch-once",
    );
    expect(started, JSON.stringify(started)).toMatchObject({
      status: "completed",
      value: { status: "running" },
    });
    const value = started.value;
    assert(value && typeof value === "object" && "sessionId" in value);
    assert(typeof value.sessionId === "string");
    const sessionId = value.sessionId;
    const session = getSession(sessionId);
    assert(session);
    await waitForExecSession(session);
    // Bound concurrent VM starts without fabricating capacity slots.
    for (let offset = 0; offset < owners.length; offset += 4) {
      const batch = await Promise.all(
        owners.slice(offset, offset + 4).map(async (h, index) => {
          const result = await h.run(
            "await yield_control(); await yield_control(); await capacity_gate({}); return true;",
            `capacity-${offset + index}`,
          );
          expect(result.status).toBe("waiting");
          return result.runId;
        }),
      );
      ids.push(...batch);
    }
    expect(new Set(ids).size).toBe(64);
    expect(testing.activeRuns.size).toBe(64);
    expect(
      await extra.run("let n=0; for(let i=0;i<1000;i++) n+=i; return n;", "cpu-at-capacity"),
    ).toMatchObject({ status: "completed", value: 499500 });
    const rejectSuspension = async () =>
      expect(await extra.run("await yield_control(); return true;", "overflow")).toMatchObject({
        status: "failed",
        code: "invalid_input",
        error: expect.stringContaining("too many suspended"),
      });
    await rejectSuspension();
    const collect = `return await process({ action: "poll", sessionId: ${JSON.stringify(sessionId)}, timeout: 0 });`;
    expect(await extra.run(collect, "observer-at-capacity")).toMatchObject({
      status: "failed",
      bridgeDispatchStarted: false,
      error: expect.stringContaining("too many suspended"),
    });
    expect(observed).not.toHaveBeenCalled();
    expect(await extra.run(collect, "required-observer", { awaitResults: true })).toMatchObject({
      status: "completed",
      value: { sessionId, status: "completed", exitCode: 0, aggregated: "benchmark-result" },
    });
    expect(launched).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(64);
    const first = owners[0]!;
    const repark = await first.resume({ runId: ids[0] }, "repark-at-capacity");
    expect(repark.status).toBe("waiting");
    ids[0] = repark.runId;
    active = first.resume({ runId: ids[0] }, "active-at-capacity");
    await entered.promise;
    expect(testing.activeRuns.size).toBe(63);
    await rejectSuspension();
    clearToolSearchCatalog(first.ctx);
    expect(await active).toMatchObject({ status: "failed", code: "aborted" });
    expect(aborted).toHaveBeenCalledOnce();
    const healthy = await extra.run("await yield_control(); return 'healthy';", "new-slot");
    expect(healthy.status).toBe("waiting");
    expect(testing.activeRuns.size).toBe(64);
    clearToolSearchCatalog(owners[1]!.ctx);
    expect(await extra.resume(healthy, "healthy-resume")).toMatchObject({
      status: "completed",
      value: "healthy",
    });
  } finally {
    release.resolve();
    [...owners, extra].forEach((h) => clearToolSearchCatalog(h.ctx));
    await active;
  }
  expect(testing.activeRuns.size).toBe(0);
  expect(testing.resumingRunIds.size).toBe(0);
});
