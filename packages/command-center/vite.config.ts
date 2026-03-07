import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    proxy: {
      "/admin": {
        target: "http://localhost:8000",
        changeOrigin: true,
      },
    },
  },
});
