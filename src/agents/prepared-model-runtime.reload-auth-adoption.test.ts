// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  await resetPreparedModelRuntimeHarness(state);
});
afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("prepared model runtime reload auth adoption", () => {
  it("adopts remaining auth work after another owner already published", async () => {
    mocks.configuredAgentIds = ["default", "worker", "research"];
    const initialConfig = {};
    const replacementConfig = { plugins: {} };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, { gatewayLifecycle: true });
    const workerAuthBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const researchAuthBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const replacementWorkerBuild = createDeferred<{ agentDir: string; wrote: false }>();
    const workerAuthStarted = createDeferred();
    const researchAuthStarted = createDeferred();
    const replacementWorkerStarted = createDeferred();
    const events: string[] = [];
    const unregister = registerPreparedModelRuntimePublicationListener((event) => {
      events.push(event.phase);
    });
    mocks.ensureOpenClawModelsJson.mockImplementation(async (config, agentDir) => {
      if (isDeepStrictEqual(config, initialConfig) && agentDir === state.agentDir("worker")) {
        workerAuthStarted.resolve();
        return await workerAuthBuild.promise;
      }
      if (isDeepStrictEqual(config, initialConfig) && agentDir === state.agentDir("research")) {
        researchAuthStarted.resolve();
        return await researchAuthBuild.promise;
      }
      if (isDeepStrictEqual(config, replacementConfig) && agentDir === state.agentDir("worker")) {
        replacementWorkerStarted.resolve();
        return await replacementWorkerBuild.promise;
      }
      return { agentDir: String(agentDir), wrote: false };
    });

    let firstWorkerRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let adoptedWorkerRead: ReturnType<typeof loadPublishedGatewayReplyDispatchRuntime> | undefined;
    let reload: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      mocks.mutationListener?.({
        agentDir: state.agentDir("worker"),
        affectsInheritedStores: false,
      });
      await workerAuthStarted.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(4);
      firstWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      mocks.mutationListener?.({
        agentDir: state.agentDir("research"),
        affectsInheritedStores: false,
      });
      workerAuthBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      await researchAuthStarted.promise;
      expect(mocks.ensureOpenClawModelsJson).toHaveBeenCalledTimes(5);
      await expect(firstWorkerRead).resolves.toMatchObject({ config: initialConfig });

      reload = refreshPreparedModelRuntimeSnapshots(replacementConfig, {
        gatewayLifecycle: true,
      });
      adoptedWorkerRead = loadPublishedGatewayReplyDispatchRuntime({ agentId: "worker" });
      let adoptedWorkerSettled = false;
      void adoptedWorkerRead.then(
        () => {
          adoptedWorkerSettled = true;
        },
        () => undefined,
      );
      await Promise.resolve();
      expect(adoptedWorkerSettled).toBe(false);

      researchAuthBuild.resolve({ agentDir: state.agentDir("research"), wrote: false });
      await replacementWorkerStarted.promise;
      expect(adoptedWorkerSettled).toBe(false);
      replacementWorkerBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      await expect(reload).resolves.toBeUndefined();
      await expect(adoptedWorkerRead).resolves.toMatchObject({ config: replacementConfig });
      unregister();

      expect(events.filter((phase) => phase === "published")).toHaveLength(1);
      expect(events).not.toContain("failed");
    } finally {
      workerAuthBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      researchAuthBuild.resolve({ agentDir: state.agentDir("research"), wrote: false });
      replacementWorkerBuild.resolve({ agentDir: state.agentDir("worker"), wrote: false });
      await Promise.allSettled([firstWorkerRead, adoptedWorkerRead, reload]);
      unregister();
    }
  });
});
