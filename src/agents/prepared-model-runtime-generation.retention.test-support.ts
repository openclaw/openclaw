import assert from "node:assert/strict";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import {
  capturePreparedModelRuntimeGeneration,
  retirePreparedModelRuntimeGeneration,
} from "./prepared-model-runtime.lifecycle.js";

const owner: { generationRetirement?: AbortController } = {};
const signals: AbortSignal[] = [];
const bytesPerRun = 64 * 1024;

function completeRun(): WeakRef<Uint8Array> {
  const history = new Uint8Array(bytesPerRun);
  const signal = capturePreparedModelRuntimeGeneration(owner);
  let notified = false;
  signal.addEventListener(
    "abort",
    () => {
      assert.equal(owner.generationRetirement, undefined);
      notified = true;
    },
    { once: true },
  );
  // The retiring stack frame closes over run state, as the real run cleanup does.
  const finish = () => {
    retirePreparedModelRuntimeGeneration(owner);
    return history.byteLength;
  };
  assert.equal(finish(), bytesPerRun);
  assert.equal(notified, true);
  signals.push(signal);
  return new WeakRef(history);
}

const histories = Array.from({ length: 128 }, completeRun);
const successor = capturePreparedModelRuntimeGeneration(owner);
assert.equal(successor.aborted, false);
await collectForRetentionCheck("model-generation-retirement");
const retainedBytes =
  histories.filter((history) => history.deref() !== undefined).length * bytesPerRun;
assert.equal(retainedBytes, 0, "Retired generation signals must release completed run history");
for (const signal of signals) {
  assert.equal(signal.aborted, true);
  assert.ok(signal.reason instanceof DOMException);
  assert.equal(signal.reason.name, "AbortError");
  assert.equal(signal.reason.message, "This operation was aborted");
}
process.stdout.write(JSON.stringify({ generations: signals.length, retainedBytes }));
