/** Retention child: disposed attempt stores collect while deliberately retained controls stay live. */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import {
  createEmbeddedAttemptTranscriptLifecycle,
  type LifecycleOwner,
} from "./attempt-transcript-lifecycle.js";

const gc = globalThis.gc as () => void;
assert.ok(globalThis.gc, "The retention child requires --expose-gc");
const retainedStores: AsyncLocalStorage<LifecycleOwner>[] = [];

function runLifecycle(disposeAfter: boolean) {
  const lifecycleStore = new AsyncLocalStorage<LifecycleOwner>();
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle(
    { runId: "retention", sessionId: "retention" },
    { createLifecycleStore: () => lifecycleStore },
  );
  return Promise.resolve().then(async () => {
    await lifecycle.withTranscriptWrite(async () => {
      await Promise.resolve();
    });
    if (disposeAfter) {
      await lifecycle.dispose();
    } else {
      retainedStores.push(lifecycleStore);
    }
    return new WeakRef(lifecycleStore);
  });
}

async function countCollected(instances: WeakRef<AsyncLocalStorage<LifecycleOwner>>[]) {
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  return instances.filter((reference) => reference.deref() === undefined).length;
}

// A disposed lifecycle must let its per-attempt store be collected.
const disposed = await Promise.all(Array.from({ length: 40 }, () => runLifecycle(true)));
const retained = await Promise.all(Array.from({ length: 40 }, () => runLifecycle(false)));

const collectedDisposed = await countCollected(disposed);
const collectedRetained = await countCollected(retained);

// Sanity: with --expose-gc the control path actually collects.
assert.ok(
  collectedDisposed >= 30,
  `disposed stores must be collectable, collected=${collectedDisposed}/40`,
);
assert.equal(
  collectedRetained,
  0,
  `strongly retained controls must stay live, collected=${collectedRetained}/40`,
);
for (const [index, store] of retainedStores.entries()) {
  assert.equal(retained[index]?.deref(), store);
}

console.log(
  `retention ok: disposed collected=${collectedDisposed}/40 retained collected=${collectedRetained}/40`,
);
