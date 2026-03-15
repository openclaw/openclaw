import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  publicDir: path.resolve(here, "public"),
  build: {
    outDir: path.resolve(here, "dist"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: ["@noble/ed25519"],
    },
  },
  server: {
    host: true,
    port: 5180,
    strictPort: true,
  },
});
