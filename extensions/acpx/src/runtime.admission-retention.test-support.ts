import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createFileSessionStore } from "acpx/runtime";
import { withProcessRuntime } from "./runtime-process.test-support.js";
import { acpxOperationScope } from "./runtime-session-store.js";
import type { AcpxRuntime } from "./runtime.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const scenario = process.argv[2];
assert.ok(scenario === "initial" || scenario === "after-reset");

const references: Array<{ label: string; value: WeakRef<object> }> = [];
const track = (label: string, value: object) =>
  references.push({ label, value: new WeakRef(value) });
const ids: number[] = [];
let failLaunch = true;
let lookupResult: "missing" | "error" | undefined;

// Return the frame retaining the last rejected lookup promise before checking GC.
async function exerciseUnusedLookups(runtime: AcpxRuntime) {
  for (let index = 0; index < 8; index++) {
    lookupResult = index % 2 === 0 ? "missing" : "error";
    const lookup = runtime.findSession({
      sessionKey: `lookup-only-${index}`,
      agentId: "main",
      agent: "fixture",
    });
    if (lookupResult === "error") {
      await assert.rejects(lookup, /synthetic lookup failure/);
    } else {
      assert.equal(await lookup, undefined);
    }
  }
  lookupResult = undefined;
}

await withProcessRuntime(
  `acpx-admission-${scenario}`,
  async ({ runtime }) => {
    const target = (id: number) => ({ sessionKey: `failed-admission-${id}`, agentId: "main" });
    const ensure = (index: number) =>
      runtime.ensureSession({ ...target(index), agent: "fixture", mode: "persistent" });
    for (let index = 0; index < 8; index++) {
      if (scenario === "after-reset") {
        await runtime.prepareFreshSession(target(index));
      }
      await assert.rejects(ensure(index), /synthetic admission launch failure/);
    }
    const failedIds = [...ids];
    if (scenario === "initial") {
      await exerciseUnusedLookups(runtime);
    }
    const control = new WeakRef({ unowned: true });
    // Cross task boundaries and allow GC convergence; the broken registry retains every owner.
    for (let pass = 0; pass < 32; pass++) {
      await setImmediate();
      gc();
    }
    assert.equal(control.deref(), undefined, "Unowned GC control must collect");
    const retained = references.flatMap(({ label, value }) => (value.deref() ? [label] : []));
    console.log(
      JSON.stringify({ scenario, observed: references.length, retained, controlCollected: true }),
    );
    assert.deepEqual(retained, [], "Unused admissions or lookups retained lifecycle owners");

    failLaunch = false;
    const handle = await ensure(0);
    const retryId = ids.at(-1);
    assert.ok(retryId !== undefined && !failedIds.includes(retryId), "Retry needs a fresh owner");
    await runtime.close({ handle, reason: "test-complete" });
  },
  async (state) => {
    const store = createFileSessionStore({ stateDir: state.root });
    return {
      sessionStore: {
        load: async (key) => {
          if (lookupResult) {
            const generation = acpxOperationScope.getStore()?.generation;
            assert.ok(generation, "Lookup must retain its owner until the read settles");
            track(`lookup:${generation.id}`, generation);
            if (lookupResult === "error") {
              throw new Error("synthetic lookup failure");
            }
          }
          return store.load(key);
        },
        save: (record) => store.save(record),
      },
      openclawToolsMcpBridgeEnabled: true,
      mcpServers: [{ name: "openclaw-tools", command: process.execPath, args: [], env: [] }],
      processLifecycle: {
        onBeforeSpawn: async () => {
          const generation = acpxOperationScope.getStore()?.generation;
          assert.ok(generation, "Admission must retain its current owner through the SDK");
          assert.equal(generation.afterReset, scenario === "after-reset");
          ids.push(generation.id);
          if (failLaunch) {
            track(`generation:${generation.id}`, generation);
            if (scenario === "after-reset") {
              assert.ok(generation.delegate);
              track(`delegate:${generation.id}`, generation.delegate);
            }
            throw new Error("synthetic admission launch failure");
          }
        },
      },
    };
  },
);
