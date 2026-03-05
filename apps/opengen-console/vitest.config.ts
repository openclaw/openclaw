import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    jsx: "automatic",
  },
  test: {
    include: ["app/**/*.test.ts", "lib/**/*.test.ts", "components/**/*.test.tsx"],
  },
});
