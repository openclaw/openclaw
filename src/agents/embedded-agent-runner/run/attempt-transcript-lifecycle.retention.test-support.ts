/** Retention child: disposed attempts collect while deliberately retained controls stay live. */
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import {
  createEmbeddedAttemptTranscriptLifecycle,
  type EmbeddedAttemptTranscriptLifecycle,
} from "./attempt-transcript-lifecycle.js";

const gc = globalThis.gc as () => void;
assert.ok(globalThis.gc, "The retention child requires --expose-gc");
const retainedAttempts: EmbeddedAttemptTranscriptLifecycle[] = [];

async function runLifecycle(retain: boolean) {
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
    runId: "retention",
    sessionId: "retention",
  });
  await lifecycle.withTranscriptWrite(async () => {
    await Promise.resolve();
  });
  await lifecycle.dispose();
  if (retain) {
    retainedAttempts.push(lifecycle);
  }
  return new WeakRef(lifecycle);
}

const disposed = await Promise.all(Array.from({ length: 40 }, () => runLifecycle(false)));
const retained = await Promise.all(Array.from({ length: 40 }, () => runLifecycle(true)));
for (let pass = 0; pass < 8; pass += 1) {
  await setImmediate();
  gc();
}
const collectedDisposed = disposed.filter((reference) => reference.deref() === undefined).length;
assert.ok(
  collectedDisposed >= 30,
  `disposed attempts must be collectable, collected=${collectedDisposed}/40`,
);
for (const [index, lifecycle] of retainedAttempts.entries()) {
  assert.equal(retained[index]?.deref(), lifecycle);
}
console.log(`retention ok: disposed collected=${collectedDisposed}/40 retained live=40/40`);
