/**
 * Synthetic missing-completion fault injection through the real dispatcher.
 * Standalone: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/dispatcher-retention-measure.mjs
 * Shipped Gateway: preload this file with --import; set OPENCLAW_RETENTION_ENTRY
 * to the absolute dist/plugin-sdk/reply-runtime.js path and set
 * OPENCLAW_RETENTION_READY_URL to the isolated loopback /readyz endpoint.
 * PROBE_EXPECT=0 asserts collection; use the identical command on base (red).
 * PROBE_SNAPSHOT optionally writes a heap snapshot. Snapshots may contain
 * process data: publish only inspected synthetic-marker summaries.
 * This does not identify a natural producer missing markComplete().
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { setImmediate as waitImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { writeHeapSnapshot } from "node:v8";
import { isMainThread, threadId } from "node:worker_threads";
async function measure() {
  const root = process.cwd();
  const entry =
    process.env.OPENCLAW_RETENTION_ENTRY ?? root + "/src/auto-reply/reply/reply-dispatcher.ts";
  const { createReplyDispatcher } = await import(pathToFileURL(entry));
  // Observe the production registry shared by the Gateway and SDK bundle.
  const getTotalPendingReplies = () => {
    const registry = globalThis[Symbol.for("openclaw.activeReplyDispatchers")];
    return [...(registry ?? [])].reduce(
      (sum, item) => sum + (typeof item.pending === "function" ? item.pending() : item.pending),
      0,
    );
  };
  assert.equal(typeof global.gc, "function");
  class DispatcherRetentionProbeContext {
    constructor(id) {
      this.id = id;
      this.payload = Array(65536).fill(id);
    }
    firstPayloadValue() {
      return this.payload[0];
    }
  }
  function abandon(id) {
    const context = new DispatcherRetentionProbeContext(id);
    const dispatcher = createReplyDispatcher({ deliver: async () => context.firstPayloadValue() });
    return { context: new WeakRef(context), dispatcher: new WeakRef(dispatcher) };
  }
  async function gc() {
    for (let i = 0; i < 12; i++) {
      await waitImmediate();
      global.gc();
    }
    await waitImmediate();
  }
  const before = getTotalPendingReplies();
  const refs = Array.from({ length: 16 }, (_, i) => abandon(i));
  await gc();
  const alive = refs.filter((r) => r.context.deref() !== undefined).length;
  const dispatchersAlive = refs.filter((r) => r.dispatcher.deref() !== undefined).length;
  const pendingAfterGc = getTotalPendingReplies() - before;
  assert.equal(pendingAfterGc, 16);
  let release, started;
  const hold = new Promise((r) => {
    release = r;
  });
  const ready = new Promise((r) => {
    started = r;
  });
  const live = createReplyDispatcher({
    deliver: async () => {
      started();
      await hold;
    },
  });
  assert.equal(getTotalPendingReplies() - before, 17);
  assert.equal(live.sendFinalReply({ text: "synthetic delivery" }), true);
  await ready;
  const during = getTotalPendingReplies() - before;
  assert.equal(during, 18);
  live.markComplete();
  await gc();
  const completedButBlocked = getTotalPendingReplies() - before;
  assert.equal(completedButBlocked, 18);
  release();
  const receipt = await live.waitForIdle();
  assert.equal(receipt.counts.final.delivered, 1);
  const after = getTotalPendingReplies() - before;
  assert.equal(after, 16);
  if (process.env.PROBE_SNAPSHOT) {
    writeHeapSnapshot(process.env.PROBE_SNAPSHOT);
  }
  const result = {
    node: process.version,
    pid: process.pid,
    threadId,
    isMainThread,
    entry: process.argv[1],
    dispatcherModule: entry,
    gatewayReadyUrl: process.env.OPENCLAW_RETENTION_READY_URL ?? null,
    contexts: 16,
    alive,
    dispatchersAlive,
    pendingAfterGc,
    during,
    completedButBlocked,
    after,
    finalDelivered: receipt.counts.final.delivered,
  };
  console.log(JSON.stringify(result));
  if (process.env.PROBE_EXPECT) {
    assert.equal(alive, Number(process.env.PROBE_EXPECT));
  }
  if (process.env.OPENCLAW_RETENTION_OUTPUT) {
    writeFileSync(process.env.OPENCLAW_RETENTION_OUTPUT, JSON.stringify(result) + "\n");
  }
}

async function measureAfterGatewayReady() {
  try {
    const deadline = Date.now() + 120000;
    for (;;) {
      try {
        const response = await fetch(process.env.OPENCLAW_RETENTION_READY_URL, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok && (await response.json()).ready === true) {
          break;
        }
      } catch {}
      assert.ok(Date.now() < deadline, "isolated Gateway never became ready");
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
    await measure();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
    if (process.env.OPENCLAW_RETENTION_OUTPUT) {
      writeFileSync(
        process.env.OPENCLAW_RETENTION_OUTPUT,
        JSON.stringify({ error: String(error), pid: process.pid }) + "\n",
      );
    }
  }
}

if (!isMainThread) {
  // Node workers inherit execArgv preloads; only the Gateway owner measures.
} else if (process.env.OPENCLAW_RETENTION_READY_URL) {
  // A preload must return before the CLI can start its listener.
  globalThis.setImmediate(() => {
    void measureAfterGatewayReady();
  });
} else {
  await measure();
}
