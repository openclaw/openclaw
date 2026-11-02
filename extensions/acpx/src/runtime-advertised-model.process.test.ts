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

function modelRequest(name: string, model?: string) {
  return {
    sessionKey: `agent:main:acp:catalog-${name}`,
    agent: "catalog",
    mode: "persistent" as const,
    ...(model ? { model, modelExplicit: true } : {}),
  };
}

const select = (runtime: AcpxRuntime, handle: RuntimeHandle, value: string) =>
  runtime.setConfigOption({ handle, key: "model", value });
const expectModel = async (
  runtime: AcpxRuntime,
  handle: RuntimeHandle,
  text: string,
  model: string,
) => expect(await prompt(runtime, handle, text)).toMatchObject({ model });

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
        executable = await copyNodeExecutable(state.root, "cursor-agent");
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

it("selects advertised ids for explicit refs and model changes", async () => {
  await withRuntime(async (runtime) => {
    const handle = await runtime.ensureSession(modelRequest("explicit", "cursor/composer-2.5"));
    expect(handle.appliedModel).toBeUndefined();
    expect(await runtime.getStatus({ handle })).toMatchObject({
      models: { currentModelId: "composer-2.5[fast=true]" },
    });
    await select(runtime, handle, "cursor/composer-2.5");
    await expectModel(runtime, handle, "first", "composer-2.5[fast=true]");
    const accepted = await select(runtime, handle, "xai/grok-4.5");
    expect(accepted?.configOptions).toContainEqual(
      expect.objectContaining({
        id: "model",
        currentValue: "grok-4.5[effort=high,fast=true]",
      }),
    );
    await expectModel(runtime, handle, "changed", "grok-4.5[effort=high,fast=true]");
  });
});

it("rejects ambiguity before stripping the provider", async () => {
  await withRuntime(async (runtime) => {
    await expect(
      runtime.ensureSession(modelRequest("missing", "vendor/ambiguous")),
    ).rejects.toMatchObject({ code: "ACP_MODEL_UNSUPPORTED" });
  });
});

it("preserves history when reconnect makes a model ambiguous", async () => {
  await withRuntime(async (runtime, _spawned, restart) => {
    const input = modelRequest("reconnect");
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

it("cleans failed selections across same-key retries and restart", async ({ signal }) => {
  await withRuntime(async (runtime, spawned, restart) => {
    const input = modelRequest("retry", "provider/locked-1");
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    expect(spawned).toHaveLength(2);
    await withinTest(Promise.all(spawned.map(({ exited }) => exited)), signal);
    for (const { pid } of spawned) {
      expect(() => process.kill(pid, 0)).toThrow();
    }
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    await runtime.shutdown();
    await expect(restart().ensureSession(input)).rejects.toThrow(/not available on this plan/);
  });
});

it("prefers advertised slash ids to provider-stripped refs", async () => {
  await withRuntime(async (runtime) => {
    const handle = await runtime.ensureSession(modelRequest("native-id", "vendor/native-model"));
    await expectModel(runtime, handle, "startup", "vendor/native-model");
    await select(runtime, handle, "native-model");
    await select(runtime, handle, "vendor/native-model");
    await expectModel(runtime, handle, "control", "vendor/native-model");
  });
});

it("keeps non-Cursor harness ids opaque", async () => {
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
    await expectModel(runtime, handle, "exact", "composer-2.5[fast=true]");
  }, false);
});
