import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "../../../test/vitest/vitest.shared.config.ts";

// Temporary migration evidence owns a private source server. Retain the normal
// Chromium transport preflight and isolated-fork cleanup contract.
export default defineConfig({
  ...sharedVitestConfig,
  cacheDir: ".artifacts/panel-parity-vitest",
  test: {
    ...sharedVitestConfig.test,
    name: "panel-parity",
    environment: "node",
    include: ["scripts/fixtures/control-ui-panel-proof/panel-parity.e2e.test.ts"],
    exclude: (sharedVitestConfig.test?.exclude ?? []).filter(
      (pattern) => pattern !== "**/*.e2e.test.ts",
    ),
    pool: "forks",
    isolate: true,
    runner: undefined,
    maxWorkers: 1,
    fileParallelism: false,
    setupFiles: [],
    globalSetup: ["test/vitest/vitest.ui-e2e.global-setup.ts"],
    expect: { poll: { interval: 100, timeout: 15_000 } },
  },
});
