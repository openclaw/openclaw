#!/usr/bin/env node
/**
 * Launches the gateway (normal mode, control UI disabled) on port 18789,
 * then starts the Vite dev server with HMR proxying API/avatar calls
 * back to that gateway.
 *
 * Usage:
 *   pnpm ui:dev:full          # default: port 18789
 *   pnpm ui:dev:full -- 9999  # custom port
 *
 * Ctrl-C kills both processes.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

const port = Number(process.argv[2]) || 18789;
const DEV_FALLBACK = "1234";
const password = process.env.CLAWDBRAIN_GATEWAY_PASSWORD || process.env.PASSWORD || DEV_FALLBACK;
const token = process.env.CLAWDBRAIN_GATEWAY_TOKEN || DEV_FALLBACK;

const children = [];

function cleanup() {
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      // already dead
    }
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

// Wait for the gateway HTTP server to respond on the given port.
function waitForGateway(targetPort, { timeoutMs = 30_000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function probe() {
      if (Date.now() > deadline) {
        reject(new Error(`Gateway did not start within ${timeoutMs}ms`));
        return;
      }
      const req = http.get(`http://127.0.0.1:${targetPort}/`, (res) => {
        res.resume();
        // Any response (even 404) means the server is listening
        resolve();
      });
      req.on("error", () => {
        setTimeout(probe, intervalMs);
      });
      req.setTimeout(1000, () => {
        req.destroy();
        setTimeout(probe, intervalMs);
      });
    }
    probe();
  });
}

// --- 1. Start the gateway ---
console.log(`\x1b[36m[dev-ui]\x1b[0m Starting gateway on port ${port} (control UI disabled)...`);

const gatewayArgs = [
  "scripts/run-node.mjs",
  "gateway",
  "run",
  "--port", String(port),
  "--force",
  "--no-ui",
  "--auth", "password",
  "--password", password,
  "--token", token,
];

// Skip channels by default for faster dev startup, but allow override via env var.
// Set CLAWDBRAIN_SKIP_CHANNELS=0 to enable channels for e2e testing.
const skipChannels = process.env.CLAWDBRAIN_SKIP_CHANNELS !== "0";

const gateway = spawn(process.execPath, gatewayArgs, {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    ...(skipChannels ? { CLAWDBRAIN_SKIP_CHANNELS: "1" } : {}),
  },
});
children.push(gateway);

gateway.on("exit", (code, signal) => {
  console.log(`\x1b[36m[dev-ui]\x1b[0m Gateway exited (code=${code}, signal=${signal}).`);
  cleanup();
  process.exit(code ?? 1);
});

// --- 2. Wait for gateway, then start Vite ---
try {
  await waitForGateway(port);
} catch (err) {
  console.error(`\x1b[31m[dev-ui]\x1b[0m ${err.message}`);
  cleanup();
  process.exit(1);
}

console.log(`\x1b[36m[dev-ui]\x1b[0m Gateway is up. Starting Vite dev server...`);

const viteEnv = { ...process.env };
viteEnv.CLAWDBRAIN_CONTROL_UI_PROXY_TARGET = `http://127.0.0.1:${port}`;
viteEnv.VITE_CLAWDBRAIN_CONTROL_UI_DEFAULT_GATEWAY_URL = `ws://127.0.0.1:${port}`;
viteEnv.VITE_CLAWDBRAIN_CONTROL_UI_DEFAULT_GATEWAY_PASSWORD = password;

const vite = spawn("pnpm", ["dev"], {
  cwd: uiDir,
  stdio: "inherit",
  env: viteEnv,
});
children.push(vite);

vite.on("exit", (code, signal) => {
  console.log(`\x1b[36m[dev-ui]\x1b[0m Vite exited (code=${code}, signal=${signal}).`);
  cleanup();
  process.exit(code ?? 1);
});
