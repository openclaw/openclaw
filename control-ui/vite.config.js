import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

function normalizeApiTarget(value) {
  return value.replace(/\/+$/u, "").replace(/\/api$/u, "");
}

function healthProbePlugin() {
  const probePaths = new Set(["/health", "/healthz", "/ready", "/readyz"]);

  return {
    name: "alphabet-health-probe",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const method = req.method || "GET";
        const pathname = (req.url || "").split("?")[0];

        if (!probePaths.has(pathname) || (method !== "GET" && method !== "HEAD")) {
          next();
          return;
        }

        const body = JSON.stringify({
          status: "ok",
          service: "alphabet-control-ui",
        });

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(method === "HEAD" ? "" : body);
      });
    },
  };
}

const allowedHosts = [".azurecontainerapps.io"];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = normalizeApiTarget(env.VITE_API_URL || "http://localhost:8080");

  return {
    plugins: [react(), healthProbePlugin()],
    server: {
      allowedHosts,
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
