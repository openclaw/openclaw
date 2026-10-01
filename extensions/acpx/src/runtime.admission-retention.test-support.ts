import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore } from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { acpxOperationScope } from "./runtime-session-store.js";
import { AcpxRuntime } from "./runtime.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const scenario = process.argv[2];
assert.ok(scenario === "initial" || scenario === "after-reset");
const peer = fileURLToPath(new URL("../../../test/fixtures/acp/owner-agent.mjs", import.meta.url));

function unownedControl() {
  return new WeakRef({ unowned: true });
}

await withOpenClawTestState({ label: `acpx-admission-${scenario}` }, async (state) => {
  const directory = path.join(state.root, "peer");
  await fs.mkdir(directory);
  const references: Array<{ label: string; value: WeakRef<object> }> = [];
  const ids: number[] = [];
  let failLaunch = true;
  const runtime = new AcpxRuntime({
    cwd: state.root,
    sessionStore: createFileSessionStore({ stateDir: state.root }),
    agentRegistry: createAgentRegistry({
      overrides: { fixture: [process.execPath, peer, directory] },
    }),
    openclawToolsMcpBridgeEnabled: true,
    mcpServers: [{ name: "openclaw-tools", command: process.execPath, args: [], env: [] }],
    permissionMode: "deny-all",
    timeoutMs: 5000,
    processLifecycle: {
      onBeforeSpawn: async () => {
        const generation = acpxOperationScope.getStore()?.generation;
        assert.ok(generation, "Admission must retain its current owner through the SDK");
        assert.equal(generation.afterReset, scenario === "after-reset");
        ids.push(generation.id);
        if (failLaunch) {
          references.push({ label: `generation:${generation.id}`, value: new WeakRef(generation) });
          if (scenario === "after-reset") {
            assert.ok(generation.delegate);
            references.push({
              label: `delegate:${generation.id}`,
              value: new WeakRef(generation.delegate),
            });
          }
          throw new Error("synthetic admission launch failure");
        }
      },
    },
  });
  const target = (index: number) => ({ sessionKey: `failed-admission-${index}`, agentId: "main" });
  const ensure = (index: number) =>
    runtime.ensureSession({ ...target(index), agent: "fixture", mode: "persistent" });
  try {
    for (let index = 0; index < 8; index++) {
      if (scenario === "after-reset") {
        await runtime.prepareFreshSession(target(index));
      }
      await assert.rejects(ensure(index), /synthetic admission launch failure/);
    }
    const failedIds = [...ids];
    const control = unownedControl();
    // Cross task boundaries so completed admission frames no longer keep WeakRefs alive.
    // Fixed full collections allow GC convergence; the broken registry retains every owner.
    for (let pass = 0; pass < 32; pass++) {
      await setImmediate();
      gc();
    }
    assert.equal(control.deref(), undefined, "Unowned GC control must collect");
    const retained = references
      .filter(({ value }) => value.deref() !== undefined)
      .map(({ label }) => label);
    console.log(
      JSON.stringify({ scenario, observed: references.length, retained, controlCollected: true }),
    );
    assert.deepEqual(retained, [], "Failed first admissions retained unreachable lifecycle owners");

    failLaunch = false;
    const handle = await ensure(0);
    const retryId = ids.at(-1);
    assert.ok(retryId !== undefined);
    assert.ok(!failedIds.includes(retryId), "Sequential retry needs a fresh admission owner");
    const turn = runtime.startTurn({
      handle,
      text: "show context",
      mode: "prompt",
      requestId: "retry",
    });
    let text = "";
    for await (const event of turn.events) {
      if (event.type === "text_delta") {
        text += event.text;
      }
    }
    assert.equal((await turn.result).status, "completed");
    assert.deepEqual(JSON.parse(text).mcpServers, [
      {
        name: "openclaw-tools",
        command: process.execPath,
        args: ["--openclaw-agent-id", "main"],
        env: [{ name: "OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY", value: target(0).sessionKey }],
      },
    ]);
    await runtime.close({ handle, reason: "test-complete", discardPersistentState: true });
  } finally {
    await runtime.shutdown();
  }
});
