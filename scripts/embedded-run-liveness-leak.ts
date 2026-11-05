/**
 * Checks that a completed liveness join releases its caller while delivery is
 * still pending. Run with:
 * pnpm leak:embedded-run:liveness
 */
import { mkdirSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { writeHeapSnapshot } from "node:v8";
import { joinWithRunLivenessDeadline } from "../src/agents/embedded-agent-runner/run/abortable.js";

class AttemptContext {
  payload = Array.from({ length: 10_000 }, (_, index) => index);
  timedOut = false;
}

const snapshotDirectory = ".tmp/embedded-run-liveness-leak";
const attemptsPerMode = 100;

async function countRetained(tracked: WeakRef<AttemptContext>[]): Promise<number> {
  for (let index = 0; index < 10; index++) {
    await nextTurn();
    global.gc?.();
  }
  return tracked.filter((reference) => reference.deref()).length;
}

function joinPendingDelivery(
  mode: "timeout" | "abort",
  tracked: WeakRef<AttemptContext>[],
  releases: (() => void)[],
): Promise<void> {
  const attempt = new AttemptContext();
  const controller = new AbortController();
  const delivery = new Promise<void>((resolve) => {
    releases.push(resolve);
  });
  tracked.push(new WeakRef(attempt));
  // The two callbacks share a lexical scope, as they do in stream settlement.
  return joinWithRunLivenessDeadline({
    joinWork: () => {
      if (mode === "abort") {
        queueMicrotask(() => controller.abort());
      }
      return delivery;
    },
    runAbortSignal: controller.signal,
    timeoutMs: mode === "timeout" ? 1 : undefined,
    onTimeout: () => {
      attempt.timedOut = true;
    },
  });
}

if (!global.gc) {
  throw new Error("Run this harness with node --expose-gc.");
}
mkdirSync(snapshotDirectory, { recursive: true });
let failed = false;
// The production liveness timers are unref'd; keep their deadlines observable.
const keepAlive = setInterval(() => {}, 1_000);
try {
  for (const mode of ["timeout", "abort"] as const) {
    const tracked: WeakRef<AttemptContext>[] = [];
    const releases: (() => void)[] = [];
    const startedAt = performance.now();
    const rssBefore = process.memoryUsage().rss;
    await Promise.all(
      Array.from({ length: attemptsPerMode }, () => joinPendingDelivery(mode, tracked, releases)),
    );
    const retainedAfterJoin = await countRetained(tracked);
    await nextTurn();
    writeHeapSnapshot(`${snapshotDirectory}/${mode}-${process.pid}.heapsnapshot`);
    for (const release of releases) {
      release();
    }
    releases.length = 0;
    const retainedAfterDelivery = await countRetained(tracked);
    const passed = retainedAfterJoin === 0 && retainedAfterDelivery === 0;
    failed ||= !passed;
    console.log(
      JSON.stringify({
        mode,
        attempts: attemptsPerMode,
        retainedAfterJoin,
        retainedAfterDelivery,
        durationMs: performance.now() - startedAt,
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        passed,
      }),
    );
  }
} finally {
  clearInterval(keepAlive);
}
process.exitCode = failed ? 1 : 0;
