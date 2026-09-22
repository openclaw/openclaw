import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentRegistry, createFileSessionStore, type AcpProcessStarted } from "acpx/runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it } from "vitest";
import { AcpxRuntime } from "./runtime.js";

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
  cursor = true,
) {
  await withOpenClawTestState({ label: "acpx-advertised-model" }, async (state) => {
    let executable = process.execPath;
    if (cursor) {
      executable = path.join(
        state.root,
        process.platform === "win32" ? "cursor-agent.exe" : "cursor-agent",
      );
      if (process.platform === "win32") {
        await fs.copyFile(process.execPath, executable);
      } else {
        // Preserve Node's executable-relative libraries while exercising ACPX's Cursor contract.
        await fs.symlink(process.execPath, executable);
      }
    }
    const spawned: AcpProcessStarted[] = [];
    const runtimes: AcpxRuntime[] = [];
    const create = () => {
      const created = new AcpxRuntime({
        cwd: state.root,
        sessionStore: createFileSessionStore({ stateDir: state.root }),
        agentRegistry: createAgentRegistry({ overrides: { catalog: [executable, script] } }),
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

async function prompt(
  runtime: AcpxRuntime,
  handle: Awaited<ReturnType<AcpxRuntime["ensureSession"]>>,
  text: string,
) {
  const turn = runtime.startTurn({ handle, text, mode: "prompt", requestId: text });
  const chunks: string[] = [];
  for await (const event of turn.events) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    }
  }
  expect(await turn.result).toMatchObject({ status: "completed" });
  return JSON.parse(chunks.join(""));
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
    // Replay the original OpenClaw ref before the first useful turn.
    await runtime.setConfigOption({ handle, key: "model", value: "cursor/composer-2.5" });
    expect(await prompt(runtime, handle, "first")).toMatchObject({
      model: "composer-2.5[fast=true]",
    });
    const accepted = await runtime.setConfigOption({
      handle,
      key: "model",
      value: "xai/grok-4.5",
    });
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

it.each(["gpt-5.5", "missing-model", "vendor/ambiguous"])(
  "rejects an ambiguous or unknown model %s",
  async (model) => {
    await withRuntime(async (runtime) => {
      await expect(
        runtime.ensureSession({
          sessionKey: "agent:main:acp:catalog-missing",
          agent: "catalog",
          mode: "persistent",
          model,
          modelExplicit: true,
        }),
      ).rejects.toMatchObject({ code: "ACP_MODEL_UNSUPPORTED" });
    });
  },
);

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
    await expect(
      resumed.setConfigOption({ handle, key: "model", value: "composer-2.5" }),
    ).rejects.toMatchObject({ code: "ACP_MODEL_UNSUPPORTED" });
    await resumed.setConfigOption({ handle, key: "model", value: "composer-2.5[fast=false]" });
    expect(await prompt(resumed, handle, "after")).toEqual({
      model: "composer-2.5[fast=false]",
      history: ["before", "after"],
    });
  });
});

it("releases rejected startup attempts when an advertised model cannot be selected", async () => {
  await withRuntime(async (runtime, spawned) => {
    await expect(
      runtime.ensureSession({
        sessionKey: "agent:main:acp:catalog-locked",
        agent: "catalog",
        mode: "persistent",
        model: "provider/locked-1",
        modelExplicit: true,
      }),
    ).rejects.toThrow(/not available on this plan/);
    // The original reference and stripped retry both failed before session publication.
    expect(spawned).toHaveLength(2);
    await expect.poll(() => spawned.filter(({ pid }) => isAlive(pid))).toEqual([]);
  });
});

it("keeps rejecting a failed selection on a same-key retry or after restart", async () => {
  await withRuntime(async (runtime, _spawned, restart) => {
    const input = {
      sessionKey: "agent:main:acp:catalog-retry",
      agent: "catalog",
      mode: "persistent" as const,
      model: "provider/locked-1",
      modelExplicit: true,
    };
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    // A published incomplete record would make these succeed without the requested model.
    await expect(runtime.ensureSession(input)).rejects.toThrow(/not available on this plan/);
    await runtime.shutdown();
    await expect(restart().ensureSession(input)).rejects.toThrow(/not available on this plan/);
  });
});

it("preserves an advertised slash id before considering a provider-stripped reference", async () => {
  await withRuntime(async (runtime) => {
    const handle = await runtime.ensureSession({
      sessionKey: "agent:main:acp:catalog-native-id",
      agent: "catalog",
      mode: "persistent",
      model: "vendor/native-model",
      modelExplicit: true,
    });
    expect(await prompt(runtime, handle, "startup")).toMatchObject({
      model: "vendor/native-model",
    });
    await runtime.setConfigOption({ handle, key: "model", value: "native-model" });
    await runtime.setConfigOption({ handle, key: "model", value: "vendor/native-model" });
    expect(await prompt(runtime, handle, "control")).toMatchObject({
      model: "vendor/native-model",
    });
  });
});

it("does not interpret another harness's opaque ids as Cursor aliases", async () => {
  await withRuntime(async (runtime) => {
    await expect(
      runtime.ensureSession({
        sessionKey: "agent:main:acp:generic-alias",
        agent: "catalog",
        mode: "persistent",
        model: "composer-2.5",
        modelExplicit: true,
      }),
    ).rejects.toMatchObject({ reason: "unadvertised-model" });
    const handle = await runtime.ensureSession({
      sessionKey: "agent:main:acp:generic-exact",
      agent: "catalog",
      mode: "persistent",
      model: "composer-2.5[fast=true]",
      modelExplicit: true,
    });
    await expect(
      runtime.setConfigOption({ handle, key: "model", value: "grok-4.5" }),
    ).rejects.toMatchObject({ reason: "unadvertised-model" });
    expect(await prompt(runtime, handle, "exact")).toMatchObject({
      model: "composer-2.5[fast=true]",
    });
  }, false);
});
