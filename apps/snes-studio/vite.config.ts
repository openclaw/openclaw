import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    sourcemap: true,
    target: "es2022",
  },
  resolve: {
    alias: {
      "@openclaw/snes-studio-core": new URL(
        "../../packages/snes-studio-core/src/index.ts",
        import.meta.url,
      ).pathname,
    },
  },
});
