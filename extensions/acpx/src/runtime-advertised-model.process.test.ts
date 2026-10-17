import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore, type AcpProcessStarted } from "acpx/runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import {
  copyNodeExecutable,
  promptJson as prompt,
  withProcessRuntime,
  type RuntimeHandle,
} from "./runtime-process.test-support.js";
import { AcpxRuntime } from "./runtime.js";

const script = fileURLToPath(new URL("../test/fixtures/model-catalog-agent.mjs", import.meta.url));

function modelRequest(name: string, model: string) {
  return {
    sessionKey: `agent:main:acp:${name}`,
    agent: "catalog",
    mode: "persistent" as const,
    model,
    modelExplicit: true,
  };
}

const select = (runtime: AcpxRuntime, handle: RuntimeHandle, value: string) =>
  runtime.setConfigOption({ handle, key: "model", value });

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
    spawned: Array<AcpProcessStarted & { exited: Promise<void> }>,
    restart: () => AcpxRuntime,
  ) => Promise<void>,
  cursor = true,
) {
  const spawned: Array<AcpProcessStarted & { exited: Promise<void> }> = [];
  const exits = new Map<string, () => void>();
  await withProcessRuntime(
    "acpx-advertised-model",
    ({ runtime, create, state }) =>
      run(runtime, spawned, () =>
        create({ sessionStore: createFileSessionStore({ stateDir: state.root }) }),
      ),
    async (state) => {
      let executable = process.execPath;
      if (cursor) {
        executable = path.join(
          state.root,
          process.platform === "win32" ? "cursor-agent.exe" : "cursor-agent",
        );
        await copyNodeExecutable(executable);
      }
      return {
        agentRegistry: createAgentRegistry({ overrides: { catalog: [executable, script] } }),
        permissionMode: "deny-all",
        timeoutMs: 10_000,
        processLifecycle: {
          onSpawned: (started) => {
            const exited = createDeferred<void>();
            exits.set(started.launchId, exited.resolve);
            spawned.push({ ...started, exited: exited.promise });
          },
          onExit: ({ launchId }) => {
            exits.get(launchId)?.();
            exits.delete(launchId);
          },
        },
      };
    },
  );
}

it("selects the unique advertised id for an explicit model ref", async () => {
  await withRuntime(async (runtime) => {
    const handle = await runtime.ensureSession(
      modelRequest("catalog-explicit", "cursor/composer-2.5"),
    );
    expect(handle.appliedModel).toBeUndefined();
    expect(await runtime.getStatus({ handle })).toMatchObject({
      models: { currentModelId: "composer-2.5[fast=true]" },
    });
    await select(runtime, handle, "cursor/composer-2.5");
    expect(await prompt(runtime, handle, "first")).toMatchObject({
      model: "composer-2.5[fast=true]",
    });
    const accepted = await select(runtime, handle, "xai/grok-4.5");
    expect(accepted).toMatchObject({
      configOptions: expect.arrayContaining([
        expect.objectContaining({
          id: "model",
          currentValue: "grok-4.5[effort=high,fast=true]",
        }),
      ]),
    });
    expect(await prompt(runtime, handle, "changed")).toMatchObject({
      model: "grok-4.5[effort=high,fast=true]",
    });
  });
});

it("rejects an ambiguous model before trying a provider-stripped reference", async () => {
  await withRuntime(async (runtime) => {
    await expect(
      runtime.ensureSession(modelRequest("catalog-missing", "vendor/ambiguous")),
    ).rejects.toMatchObject({ code: "ACP_MODEL_UNSUPPORTED" });
  });
});

it("rejects a model that becomes ambiguous on reconnect and preserves the conversation", async () => {
  await withRuntime(async (runtime, _spawned, restart) => {
    const input = {
      sessionKey: "agent:main:acp:catalog-reconnect",
      agent: "catalog",
      mode: "persistent" as const,
    };
    const original = await runtime.ensureSession(input);
    expect(await prompt(runtime, original, "before")).toMatchObject({ history: ["before"] });
    await runtime.shutdown();
    const resumed = restart();
    const handle = await resumed.ensureSession(input);
    expect(handle.backendSessionId).toBe(original.backendSessionId);

    // session/new has one variant; session/load advertises a second on the same conversation.
    await expect(select(resumed, handle, "composer-2.5")).rejects.toMatchObject({
      code: "ACP_MODEL_UNSUPPORTED",
    });
    await select(resumed, handle, "composer-2.5[fast=false]");
    expect(await prompt(resumed, handle, "after")).toEqual({
      model: "composer-2.5[fast=false]",
      history: ["before", "after"],
    });
  });
});

it("cleans up failed selections and keeps rejecting same-key retries after restart", async ({
  signal,
}) => {
  await withRuntime(async (runtime, spawned, restart) => {
    const input = modelRequest("catalog-retry", "provider/locked-1");
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    expect(spawned).toHaveLength(2);
    await withinTest(Promise.all(spawned.map(({ exited }) => exited)), signal);
    expect(spawned.filter(({ pid }) => isAlive(pid))).toEqual([]);
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    await runtime.shutdown();
    await expect(restart().ensureSession(input)).rejects.toThrow(/not available on this plan/);
  });
});

it("preserves an advertised slash id before considering a provider-stripped reference", async () => {
  await withRuntime(async (runtime) => {
    const handle = await runtime.ensureSession(
      modelRequest("catalog-native-id", "vendor/native-model"),
    );
    expect(await prompt(runtime, handle, "startup")).toMatchObject({
      model: "vendor/native-model",
    });
    await select(runtime, handle, "native-model");
    await select(runtime, handle, "vendor/native-model");
    expect(await prompt(runtime, handle, "control")).toMatchObject({
      model: "vendor/native-model",
    });
  });
});

it("does not interpret another harness's opaque ids as Cursor aliases", async () => {
  await withRuntime(async (runtime) => {
    await expect(
      runtime.ensureSession(modelRequest("generic-alias", "composer-2.5")),
    ).rejects.toMatchObject({ reason: "unadvertised-model" });
    const handle = await runtime.ensureSession(
      modelRequest("generic-exact", "composer-2.5[fast=true]"),
    );
    await expect(select(runtime, handle, "grok-4.5")).rejects.toMatchObject({
      reason: "unadvertised-model",
    });
    expect(await prompt(runtime, handle, "exact")).toMatchObject({
      model: "composer-2.5[fast=true]",
    });
  }, false);
});
