import { afterEach, assert, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getSession, waitForExecSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";
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
  applyCodeModeCatalog({ ...extra.ctx, tools: [...extra.tools, shell, observer] });
  let active: Promise<unknown> | undefined;
  try {
    const started = resultDetails(
      await extra.tools[0]!.execute("launch-once", {
        code: `return await exec(${JSON.stringify({ command: nodeCommand('process.stdout.write("benchmark-result")'), background: true })});`,
      }),
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
    const collect = `return await process({ action: "poll", sessionId: ${JSON.stringify(sessionId)}, timeout: 0 });`;
    expect(
      resultDetails(await extra.tools[0]!.execute("observer-at-capacity", { code: collect })),
    ).toMatchObject({
      status: "failed",
      bridgeDispatchStarted: false,
      error: expect.stringContaining("too many suspended"),
    });
    expect(observed).not.toHaveBeenCalled();
    expect(
      resultDetails(
        await extra.tools[0]!.execute("required-observer", { code: collect, awaitResults: true }),
      ),
    ).toMatchObject({
      status: "completed",
      value: { sessionId, status: "completed", exitCode: 0, aggregated: "benchmark-result" },
    });
    expect(launched).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledOnce();
    expect(testing.activeRuns.size).toBe(64);
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

function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}
