import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "openclaw/plugin-sdk": path.join(repoRoot, "..", "..", "src", "plugin-sdk", "index.ts"),
    },
  },
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    maxWorkers: 4,
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    // Use absolute path for setup file to avoid path resolution issues
    setupFiles: [path.join(repoRoot, "..", "..", "test", "setup.ts")],
  },
});
