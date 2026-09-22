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
import { refreshPreparedModelRuntimeSnapshots } from "./prepared-model-runtime.js";

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "prepared-model-runtime" });
  await resetPreparedModelRuntimeHarness(state);
});
afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});

describe("prepared model runtime owner selection", () => {
  it("stops a superseded same-directory batch before another catalog write", async () => {
    mocks.configuredAgentIds = ["agent-a", "agent-b"];
    for (const agentId of mocks.configuredAgentIds) {
      mocks.configuredAgentDirs.set(agentId, state.agentDir("shared-catalog-agent-dir"));
      mocks.configuredWorkspaces.set(agentId, `/tmp/catalog-workspace-${agentId}`);
    }
    const staleConfig = { agents: { defaults: { model: "openai/gpt-5.5" } } };
    const latestConfig = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const releaseStaleWriteGate = createDeferred();
    const staleWriteStarted = createDeferred();
    mocks.ensureOpenClawModelsJson.mockImplementation(async (config) => {
      if (isDeepStrictEqual(config, staleConfig)) {
        staleWriteStarted.resolve();
        await releaseStaleWriteGate.promise;
      }
      return { agentDir: state.agentDir("shared-catalog-agent-dir"), wrote: false };
    });

    let stale: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    let latest: ReturnType<typeof refreshPreparedModelRuntimeSnapshots> | undefined;
    try {
      stale = refreshPreparedModelRuntimeSnapshots(staleConfig);
      await staleWriteStarted.promise;
      latest = refreshPreparedModelRuntimeSnapshots(latestConfig);
      releaseStaleWriteGate.resolve();

      await expect(stale).rejects.toThrow("superseded");
      await latest;
      expect(
        mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) =>
          isDeepStrictEqual(config, staleConfig),
        ),
      ).toHaveLength(1);
      expect(
        mocks.ensureOpenClawModelsJson.mock.calls.filter(([config]) =>
          isDeepStrictEqual(config, latestConfig),
        ),
      ).toHaveLength(2);
    } finally {
      releaseStaleWriteGate.resolve();
      await Promise.allSettled([stale, latest]);
    }
  });
});
