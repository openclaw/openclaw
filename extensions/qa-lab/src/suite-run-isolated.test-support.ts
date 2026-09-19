import { afterEach, beforeEach, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import type { QaLabServerHandle } from "./lab-server.types.js";
import { mocks } from "./suite-run-isolated.test-mocks.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResolvedRunContext } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

export { mocks } from "./suite-run-isolated.test-mocks.js";

export const tempDirs = createTempDirHarness();
let testOutputDir: string;

export function createCleanupTestLab(): QaLabServerHandle {
  return {
    baseUrl: "http://127.0.0.1:43123",
    listenUrl: "http://127.0.0.1:43123",
    state: createQaBusState(),
    setControlUi: vi.fn(),
    setScenarioRun: vi.fn(),
    setLatestReport: vi.fn(),
    runSelfCheck: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

export function createCleanupTestContext(): QaSuiteResolvedRunContext {
  return {
    startedAt: new Date("2026-08-04T00:00:00.000Z"),
    repoRoot: testOutputDir,
    outputDir: testOutputDir,
    transportId: "qa-channel",
    selectedScenarios: [makeQaSuiteTestScenario("leased-channel-scenario")],
    providerMode: "mock-openai",
    primaryModel: "mock-openai/test-model",
    alternateModel: "mock-openai/test-model-alt",
    fastMode: true,
    channelDriver: "live",
    enabledPluginIds: [],
    gatewayConfigPatches: [],
    gatewayRuntimeOptions: undefined,
    concurrency: 1,
    progressEnabled: false,
    gatewayHeapCheckpointsEnabled: false,
  };
}

beforeEach(async () => {
  testOutputDir = await tempDirs.makeTempDir("qa-isolated-lifecycle-");
  vi.clearAllMocks();
  mocks.disposeRegisteredAgentHarnesses.mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await tempDirs.cleanup();
});
