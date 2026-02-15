import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(__dirname),
  base: "/plugins/telegram-files/",
  build: {
    outDir: path.resolve(__dirname, "..", "dist", "webapp"),
    emptyOutDir: true,
    target: "es2020",
  },
  server: {
    port: 5173,
  },
});
