import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "../../test/vitest/vitest.shared.config.ts";

// Opt-in production-renderer census; no long-session loops in ordinary CI.
export default defineConfig({
  ...sharedVitestConfig,
  test: {
    ...sharedVitestConfig.test,
    name: "control-ui-retention",
    include: [
      "scripts/control-ui-retention/retention-suite.ts",
      "scripts/control-ui-retention/*.test.ts",
    ],
    environment: "node",
    pool: "forks",
    maxWorkers: 1,
    isolate: true,
    runner: undefined,
    setupFiles: [],
    globalSetup: [],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
