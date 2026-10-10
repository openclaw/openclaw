// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import {
  acquireAgentRunPreparedModelRuntime,
  beginPreparedModelRuntimePluginDrain,
  loadPublishedGatewayReplyDispatchRuntime,
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
  type PreparedModelRuntimeInput,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "prepared-runtime-plugin-drain" });

async function publishConfigured(config: PreparedModelRuntimeInput["config"]) {
  fixture.mocks.authStorage.getAll.mockReturnValue({});
  fixture.mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, { gatewayLifecycle: true });
}

it.each([
  {
    name: "model acquisition",
    acquire: async (input: PreparedModelRuntimeInput) => {
      await using lease = await acquireAgentRunPreparedModelRuntime(input);
      return lease.snapshot.config;
    },
  },
  {
    name: "channel reply dispatch",
    acquire: async (_input: PreparedModelRuntimeInput) =>
      (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))?.config,
  },
])("lets unrelated admitted $name wait for a plugin drain", async ({ acquire }) => {
  const config = {};
  await publishConfigured(config);
  const input = fixture.agentInput("default", config);
  const unrelated = new PluginInstance("unrelated-channel");
  const drain = beginPreparedModelRuntimePluginDrain();
  let settled = false;
  const acquisition = unrelated
    .run(() => acquire(input))
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  try {
    const metadata = await prepareModelRuntimeSnapshot(input, { readPublished: true });
    expect(metadata.config).toBe(config);
    expect(settled).toBe(false);
    drain.release();
    expect(await acquisition).toEqual({ value: config });
  } finally {
    drain.release();
    await acquisition;
    await unrelated.dispose();
  }
});

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
  const first = acquireAgentRunPreparedModelRuntime(input);
  await started.promise;
  const admitted = instance.run(() => acquireAgentRunPreparedModelRuntime(input));
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
