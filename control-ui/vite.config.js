import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

function normalizeApiTarget(value) {
  return value.replace(/\/+$/u, "").replace(/\/api$/u, "");
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = normalizeApiTarget(env.VITE_API_URL || "http://alpa-engine:8080");

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  };
});
