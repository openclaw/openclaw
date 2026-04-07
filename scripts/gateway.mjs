#!/usr/bin/env node

/**
 * Gateway launcher.
 *
 * Usage:
 *   pnpm run gateway          → start OpenClaw gateway only
 *   pnpm run gateway --local  → start Ollama + OpenClaw gateway
 */

import { spawn, execSync } from "node:child_process";
import { platform } from "node:os";

const isLocal = process.argv.includes("--local");
const isWin = platform() === "win32";
const ollamaPath = isWin
  ? `${process.env.LOCALAPPDATA || "C:\\Users\\User\\AppData\\Local"}\\Programs\\Ollama\\ollama.exe`
  : "ollama";

function startOllama() {
  // Check if Ollama is already running
  try {
    execSync("curl -sf http://127.0.0.1:11434/api/tags", { stdio: "ignore" });
    console.log("🦙 Ollama already running at http://127.0.0.1:11434");
    return null;
  } catch {
    // Not running, start it
  }

  console.log("🦙 Starting Ollama server...");
  const proc = spawn(ollamaPath, ["serve"], {
    stdio: "ignore",
    detached: !isWin,
  });

  proc.on("error", (err) => {
    console.error(`❌ Failed to start Ollama: ${err.message}`);
    console.error("   Install Ollama from https://ollama.com/download");
    process.exit(1);
  });

  // Wait for Ollama to be ready
  return new Promise((resolve) => {
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      try {
        execSync("curl -sf http://127.0.0.1:11434/api/tags", { stdio: "ignore" });
        clearInterval(check);
        console.log("🦙 Ollama ready at http://127.0.0.1:11434");
        resolve(proc);
      } catch {
        if (attempts > 30) {
          clearInterval(check);
          console.error("❌ Ollama failed to start after 15s");
          proc.kill();
          process.exit(1);
        }
      }
    }, 500);
  });
}

function startGateway() {
  console.log("🦞 Starting OpenClaw gateway...");
  const env = { ...process.env };
  if (isLocal) {
    env.OLLAMA_API_KEY = env.OLLAMA_API_KEY || "ollama-local";
  }
  const gw = spawn("node", ["scripts/run-node.mjs", "gateway", "start"], {
    stdio: "inherit",
    cwd: process.cwd(),
    env,
  });

  return gw;
}

async function main() {
  let ollamaProc = null;

  if (isLocal) {
    ollamaProc = await startOllama();
  }

  const gw = startGateway();

  // Cleanup on exit
  function cleanup() {
    if (ollamaProc) {
      console.log("\n🦙 Stopping Ollama...");
      ollamaProc.kill();
    }
    gw.kill();
    process.exit(0);
  }

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  gw.on("exit", (code) => {
    if (ollamaProc) ollamaProc.kill();
    process.exit(code ?? 0);
  });
}

main();
