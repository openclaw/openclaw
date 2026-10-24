import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { EventHub } from "./event-hub.js";

type Mode = "return" | "filter-error" | "reentrant-return" | "hub-close";
type Payload = { kind: "backlog" | "trigger" };
type Held = {
  mode: Mode;
  hub: EventHub<Payload>;
  iterator: AsyncIterator<Payload>;
  refs: WeakRef<Payload>[];
};
const held: Held[] = [];
const cleanupErrors: string[] = [];
function publishWeak(hub: EventHub<Payload>, kind: Payload["kind"]) {
  // This activation owns the only temporary strong payload reference.
  const payload: Payload = { kind };
  const value = new WeakRef(payload);
  hub.publish(payload);
  return value;
}

async function prepare(mode: Mode) {
  const hub = new EventHub<Payload>();
  let returned: Promise<IteratorResult<Payload>> | undefined;
  const stream = hub.stream((event) => {
    if (event.kind === "trigger" && mode === "filter-error") {
      throw new Error("synthetic filter retirement");
    }
    if (event.kind === "trigger" && mode === "reentrant-return") {
      returned = iterator.return?.();
    }
    return true;
  });
  const iterator: AsyncIterator<Payload> = stream[Symbol.asyncIterator]();
  const item: Held = { mode, hub, iterator, refs: [publishWeak(hub, "backlog")] };
  held.push(item);
  if (mode === "return") {
    await iterator.return?.();
  } else if (mode === "hub-close") {
    hub.close();
  } else {
    item.refs.push(publishWeak(hub, "trigger"));
    if (mode === "reentrant-return") {
      assert.ok(returned, "The filter must actually return the entered iterator");
      await returned;
    }
  }
}

let passed = false;
try {
  const gc = globalThis.gc;
  assert.ok(gc, "The retirement probe requires --expose-gc");
  const control = new WeakRef({ uncached: true });
  for (const mode of ["return", "filter-error", "reentrant-return", "hub-close"] as const) {
    await prepare(mode);
  }
  // WeakRef construction keeps its target alive for the current job.
  await setImmediate();
  for (let pass = 0; pass < 8; pass++) {
    gc();
    await setImmediate();
  }
  assert.equal(control.deref(), undefined, "Uncached control retained; no retention conclusion");
  for (const { mode, iterator, refs } of held) {
    if (mode === "hub-close") {
      const expected = refs[0]?.deref();
      assert.ok(expected, "Hub close must retain its unread event for draining");
      const next = await iterator.next();
      assert.equal(next.done, false);
      assert.equal(next.value, expected);
    } else {
      refs.forEach((ref) => assert.equal(ref.deref(), undefined, mode));
    }
    if (mode === "filter-error") {
      await assert.rejects(iterator.next(), /synthetic filter retirement/);
    } else {
      assert.deepEqual(await iterator.next(), { done: true, value: undefined });
    }
  }
  passed = true;
} finally {
  for (const { hub, iterator } of held) {
    try {
      await iterator.return?.();
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      );
    } finally {
      hub.close();
    }
  }
  process.stdout.write(
    `${JSON.stringify({ verdict: passed && cleanupErrors.length === 0 ? "passed" : "failed", cleanupErrors })}\n`,
  );
  if (passed) {
    assert.deepEqual(cleanupErrors, [], "Iterator cleanup failed");
  }
}
