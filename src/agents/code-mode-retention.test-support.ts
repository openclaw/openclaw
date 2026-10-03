import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { promiseHooks } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { createDeferredCore } from "../shared/deferred.js";
import {
  activeRuns,
  disposeAllCodeModeRuns,
  waitForPendingBridgeSettlement,
  type PendingBridgeState,
} from "./code-mode-state.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { clearToolSearchCatalog, createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const started = { done: createDeferredCore(), pending: createDeferredCore() };
const release = { done: createDeferredCore(), pending: createDeferredCore() };
const inputs = new Map<string, WeakRef<object>>();
const calls: string[] = [];
const target: AnyAgentTool = {
  name: "retain_input",
  label: "Retain input",
  description: "A controlled input lifetime fixture.",
  parameters: Type.Object({ kind: Type.String() }),
  execute: async (_id, input) => {
    assert.ok(isRecord(input));
    const kind = input.kind;
    assert.ok(kind === "done" || kind === "pending" || kind === "fast");
    inputs.set(kind, new WeakRef(input));
    calls.push(kind);
    if (kind === "fast") {
      return jsonResult({ kind });
    }
    started[kind].resolve();
    await release[kind].promise;
    return jsonResult({ kind: input.kind });
  },
};
const config = { tools: { codeMode: { enabled: true, timeoutMs: 30_000 } } };
const ctx = {
  config,
  runtimeConfig: config,
  catalogRef: createToolSearchCatalogRef(),
  sessionId: "retention-session",
  sessionKey: "agent:main:retention",
  runId: "retention-run",
};
const tools = createCodeModeTools(ctx);
applyCodeModeCatalog({ ...ctx, tools: [...tools, target] });
const exec = tools.find((tool) => tool.name === "exec");
const wait = tools.find((tool) => tool.name === "wait");
assert.ok(exec && wait);
function unownedControl() {
  return new WeakRef({ unowned: true });
}
const control = unownedControl();
let pending: PendingBridgeState[] = [];
try {
  const response = await exec.execute("park-inputs", {
    code: `const done = retain_input({ kind: "done" });
      const pending = retain_input({ kind: "pending" });
      await yield_control();
      await done;
      for (const count of [100, 1_900]) {
        for (let index = 0; index < count; index++) await retain_input({ kind: "fast" });
        await yield_control();
      }
      return await Promise.all([done, pending]);`,
  });
  assert.ok(isRecord(response.details));
  assert.equal(response.details.status, "waiting");
  const runId = response.details.runId;
  assert.ok(typeof runId === "string");
  const state = activeRuns.get(runId);
  assert.ok(state);
  pending = state.pending;
  await Promise.all([started.done.promise, started.pending.promise]);
  const completed = state.pending.find(
    (entry) => isRecord(entry.args[1]) && entry.args[1].kind === "done",
  );
  assert.ok(completed);
  release.done.resolve();
  await waitForPendingBridgeSettlement([completed], { kind: "awaiting" });
  // A parked cell still owns responses; completed inputs must not ride along.
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  assert.equal(inputs.get("done")?.deref(), undefined, "Settled input must be released");
  assert.ok(inputs.get("pending")?.deref(), "Pending input must remain usable");
  const retainedPromises: number[] = [];
  for (const count of [100, 2_000]) {
    const promises: WeakRef<Promise<unknown>>[] = [];
    const stopObserving = promiseHooks.createHook({
      init(promise) {
        promises.push(new WeakRef(promise));
      },
    });
    try {
      const frontier = await wait.execute(`drain-fast-inputs-${count}`, { runId });
      assert.ok(isRecord(frontier.details));
      assert.equal(frontier.details.status, "waiting");
      assert.equal(calls.filter((kind) => kind === "fast").length, count);
    } finally {
      stopObserving();
    }
    for (let pass = 0; pass < 8; pass += 1) {
      await setImmediate();
      gc();
    }
    retainedPromises.push(promises.filter((reference) => reference.deref() !== undefined).length);
    assert.equal(inputs.get("fast")?.deref(), undefined, "Completed tool inputs must collect");
    assert.ok(inputs.get("pending")?.deref(), "The original pending input must remain usable");
  }
  assert.ok(
    retainedPromises[1]! <= retainedPromises[0]! + 64,
    `A pending sibling retained promises from completed guest frontiers: ${retainedPromises.join(" -> ")}`,
  );
  release.pending.resolve();
  const resumed = await wait.execute("resume-inputs", { runId });
  assert.ok(isRecord(resumed.details));
  assert.equal(resumed.details.status, "completed");
  assert.deepEqual(resumed.details.value, [{ kind: "done" }, { kind: "pending" }]);
  assert.deepEqual(calls.slice(0, 2), ["done", "pending"]);
  assert.equal(calls.length, 2_002);
  assert.equal(activeRuns.size, 0);
  process.stdout.write(
    JSON.stringify({
      completedInputReleased: true,
      pendingInputPreserved: true,
      frontierReactionsBounded: true,
    }),
  );
} finally {
  release.done.resolve();
  release.pending.resolve();
  await disposeAllCodeModeRuns();
  await waitForPendingBridgeSettlement(pending, {
    kind: "draining",
    requiredRequestIds: pending.map((entry) => entry.id),
  });
  clearToolSearchCatalog(ctx);
}
