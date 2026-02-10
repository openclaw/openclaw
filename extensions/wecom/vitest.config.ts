import { defineConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

const baseTest = (baseConfig as { test?: { exclude?: string[] } }).test ?? {};
const exclude = baseTest.exclude ?? [];

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseTest,
    include: ["extensions/wecom/src/**/*.test.ts"],
    exclude,
  },
});
