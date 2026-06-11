import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@openclaw/snes-studio-core": new URL(
        "../../packages/snes-studio-core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
