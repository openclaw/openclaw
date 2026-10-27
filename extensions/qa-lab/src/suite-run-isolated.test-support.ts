import { afterEach, beforeEach, vi } from "vitest";
import { mocks } from "./suite-run-isolated.test-mocks.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import type { QaSuiteResolvedRunContext } from "./suite-types.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

export { mocks } from "./suite-run-isolated.test-mocks.js";

const tempDirs = createTempDirHarness();
let testOutputDir: string;

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
