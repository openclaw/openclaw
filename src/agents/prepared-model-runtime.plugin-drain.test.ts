// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { PluginInvocationScope } from "../plugins/plugin-invocation-scope.js";
import { createTestPluginRegistry } from "../plugins/registry-runtime.test-helpers.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { scopePreparedModelRuntimeLease as scopeLease } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime as acquire,
  beginPreparedModelRuntimePluginDrain as beginDrain,
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  markPreparedModelRuntimeSnapshotsStale as invalidate,
  prepareModelRuntimeSnapshot as prepare,
  refreshPreparedModelRuntimeSnapshots as refresh,
  type PreparedModelRuntimeInput as RuntimeInput,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-runtime-plugin-drain" });

async function publishConfigured(config: RuntimeInput["config"] = {}) {
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.configuredAgentIds = ["default"];
  await refresh(config, { gatewayLifecycle: true });
  return fixture.agentInput("default", config);
}

it.each(["draining", "replacing"] as const)(
  "keeps an admitted turn on its own generation while plugins are %s",
  async (phase) => {
    const { registry } = createTestPluginRegistry();
    const record = createPluginRecord({ id: "retained-model", status: "loaded" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    fixture.mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
    const configured = await publishConfigured();
    const published = (await loadDispatch({ agentId: "default" }))!;
    const input = {
      ...configured,
      workspaceDir: published.workspaceDir,
    };
    await using parent = scopeLease(await acquire(input));
    const start = createDeferred();
    const pending = instance.run(() =>
      parent.run(async () => {
        await start.promise;
        await using nested = await acquire(input, {
          pluginGeneration: parent.pluginGeneration,
          deriveRuntimePluginSelections: () => [],
        });
        expect(nested.snapshot).toBe(parent.snapshot);
        expect(nested.pluginGeneration).toBe(parent.pluginGeneration);
        expect(instance.run(() => "reply completed")).toBe("reply completed");
        await expect(
          acquire(
            { ...input, config: { agents: { defaults: { model: "other/model" } } } },
            { pluginGeneration: parent.pluginGeneration },
          ),
        ).rejects.toMatchObject({ admissionBlocked: true });
        await parent[Symbol.asyncDispose]();
        await expect(
          acquire(input, { pluginGeneration: parent.pluginGeneration }),
        ).rejects.toMatchObject({ admissionBlocked: true });
      }),
    );
    const release = instance.reserveReplacement();
    const drain = beginDrain();
    try {
      if (phase === "replacing") {
        invalidate(undefined, { waitForReplacement: true });
      }
      start.resolve();
      await pending;
    } finally {
      drain.release();
      release();
      await instance.dispose();
    }
  },
);

it.each(["call", "consumer"] as const)(
  "refuses a model wait from the %s an external reload is draining",
  async (kind) => {
    const input = await publishConfigured();
    const instance = new PluginInstance("reloading-plugin");
    const scope = new PluginInvocationScope(createTestPluginRegistry().registry, [instance], {
      retained: true,
    });
    const start = createDeferred();
    const abort = new AbortController();
    const acquireAfterStart = async () => {
      await start.promise;
      const pending = acquire(input, { abortSignal: abort.signal });
      // An immediate refusal must win; entering the reload wait produces this abort instead.
      abort.abort(new Error("Model acquisition waited on its own reload"));
      await using lease = await pending;
      return lease.snapshot;
    };
    const pending = (
      kind === "call" ? instance.run(acquireAfterStart) : scope.run(acquireAfterStart)
    ).catch((error: unknown) => error);
    const release = instance.reserveReplacement();
    const drain = beginDrain();
    try {
      start.resolve();
      expect(await pending).toMatchObject({ admissionBlocked: true });
    } finally {
      drain.release();
      release();
      start.resolve();
      await pending;
      scope.release();
      await instance.dispose();
    }
  },
);

it.each(["model acquisition", "channel reply dispatch"])(
  "lets unrelated admitted %s wait for a plugin drain",
  async (kind) => {
    const input = await publishConfigured();
    const { config } = input;
    const runAcquisition = async () => {
      if (kind === "channel reply dispatch") {
        return (await loadDispatch({ agentId: "default" }))?.config;
      }
      await using lease = await acquire(input);
      return lease.snapshot.config;
    };
    const unrelated = new PluginInstance("unrelated-channel");
    const drain = beginDrain();
    let settled = false;
    const acquisition = unrelated
      .run(runAcquisition)
      .then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    try {
      const metadata = await prepare(input, { readPublished: true });
      expect(metadata.config).toBe(config);
      expect(settled).toBe(false);
      drain.release();
      expect(await acquisition).toEqual({ value: config });
    } finally {
      drain.release();
      await acquisition;
      await unrelated.dispose();
    }
  },
);

it("lets admitted plugin work join initial model-owner construction", async () => {
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  const input = fixture.agentInput("default", {});
  const started = createDeferred();
  const finish = createDeferred();
  fixture.mocks.prepareStaticCatalog.mockImplementationOnce(async () => {
    started.resolve();
    await finish.promise;
    return { entries: [] };
  });
  const instance = new PluginInstance("fixture");
  const first = acquire(input);
  await started.promise;
  const admitted = instance.run(() => acquire(input));
  try {
    finish.resolve();
    await using firstLease = await first;
    await using admittedLease = await admitted;
    expect(admittedLease.snapshot.pluginRegistry).toBe(firstLease.snapshot.pluginRegistry);
  } finally {
    finish.resolve();
    await instance.dispose();
  }
});
