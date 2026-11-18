import { defineConfig } from "vitest/config";
import { sharedVitestConfig } from "../../test/vitest/vitest.shared.config.ts";

// Opt-in artifact generation: never adds a screenshot matrix to routine CI.
export default defineConfig({
  ...sharedVitestConfig,
  cacheDir: ".artifacts/control-ui-parity-vite",
  test: {
    ...sharedVitestConfig.test,
    name: "control-ui-parity",
    include: ["scripts/control-ui-parity/capture-suite.ts"],
    exclude: ["node_modules/**"],
    environment: "node",
    pool: "forks",
    isolate: true,
    runner: undefined,
    globalSetup: [
      "test/vitest/vitest.ui-e2e.global-setup.ts",
      "test/vitest/vitest.ui-e2e.bundled.global-setup.ts",
    ],
    setupFiles: ["test/vitest/vitest.ui-e2e.setup.ts"],
    expect: { poll: { interval: 100, timeout: 15_000 } },
  },
});
