import { fileURLToPath } from "node:url";
import type { AcpProcessStarted } from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { AcpxRuntime, createAgentRegistry, createFileSessionStore } from "./runtime.js";

const script = fileURLToPath(new URL("../test/fixtures/model-catalog-agent.mjs", import.meta.url));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withRuntime(
  run: (
    runtime: AcpxRuntime,
    spawned: AcpProcessStarted[],
    restart: () => AcpxRuntime,
  ) => Promise<void>,
) {
  await withOpenClawTestState({ label: "acpx-advertised-model" }, async (state) => {
    const spawned: AcpProcessStarted[] = [];
    const runtimes: AcpxRuntime[] = [];
    const create = () => {
      const created = new AcpxRuntime({
        cwd: state.root,
        sessionStore: createFileSessionStore({ stateDir: state.root }),
        agentRegistry: createAgentRegistry({ overrides: { catalog: [process.execPath, script] } }),
        permissionMode: "deny-all",
        timeoutMs: 10_000,
        processLifecycle: { onSpawned: (started) => void spawned.push(started) },
      });
      runtimes.push(created);
      return created;
    };
    try {
      await run(create(), spawned, create);
    } finally {
      for (const runtime of runtimes) {
        await runtime.shutdown();
      }
    }
  });
}

it("selects the unique advertised id for an explicit model ref", async () => {
  await withRuntime(async (runtime) => {
    const handle = await runtime.ensureSession({
      sessionKey: "agent:main:acp:catalog-explicit",
      agent: "catalog",
      mode: "persistent",
      model: "cursor/composer-2.5",
      modelExplicit: true,
    });
    // Session metadata keeps the OpenClaw ref; the harness reports the advertised id.
    expect(handle.appliedModel).toBeUndefined();
    expect(await runtime.getStatus({ handle })).toMatchObject({
      models: { currentModelId: "composer-2.5[fast=true]" },
    });
    // Control sync and /acp model send the advertised id, not the raw selector.
    await runtime.setConfigOption({ handle, key: "model", value: "grok-4.5" });
    expect(await runtime.getStatus({ handle })).toMatchObject({
      models: { currentModelId: "grok-4.5[effort=high,fast=true]" },
    });
  });
});

it("matches a derived provider-prefixed model ref to the advertised id", async () => {
  await withRuntime(async (runtime) => {
    const handle = await runtime.ensureSession({
      sessionKey: "agent:main:acp:catalog-derived",
      agent: "catalog",
      mode: "persistent",
      model: "xai/grok-4.5",
    });
    expect(handle.appliedModel).toBeUndefined();
    expect(await runtime.getStatus({ handle })).toMatchObject({
      models: { currentModelId: "grok-4.5[effort=high,fast=true]" },
    });
  });
});

it("still fails an explicit model the harness does not advertise", async () => {
  await withRuntime(async (runtime) => {
    await expect(
      runtime.ensureSession({
        sessionKey: "agent:main:acp:catalog-missing",
        agent: "catalog",
        mode: "persistent",
        model: "gpt-5.5",
        modelExplicit: true,
      }),
    ).rejects.toThrow(/did not advertise that model/);
  });
});

it("releases the reopened session when the advertised model cannot be selected", async () => {
  await withRuntime(async (runtime, spawned) => {
    await expect(
      runtime.ensureSession({
        sessionKey: "agent:main:acp:catalog-locked",
        agent: "catalog",
        mode: "persistent",
        model: "locked-1",
        modelExplicit: true,
      }),
    ).rejects.toThrow(/not available on this plan/);
    // The rejected startup and the model-less reopen both spawned; neither may stay alive.
    expect(spawned).toHaveLength(2);
    await expect.poll(() => spawned.filter(({ pid }) => isAlive(pid))).toEqual([]);
  });
});

it("does not reuse the model-less fallback session on a same-key retry or after restart", async () => {
  await withRuntime(async (runtime, _spawned, restart) => {
    const input = {
      sessionKey: "agent:main:acp:catalog-retry",
      agent: "catalog",
      mode: "persistent" as const,
      model: "locked-1",
      modelExplicit: true,
    };
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    // A reusable fallback record would make these succeed without the requested model.
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    await runtime.shutdown();
    await expect(restart().ensureSession(input)).rejects.toThrow(/not available on this plan/);
  });
});
