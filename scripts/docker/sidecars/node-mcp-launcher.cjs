#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const REPO_NODE_MODULES = "/app/node_modules";
const CONTAINER_PATH_DELIMITER = ":";

function fail(message, status = 1) {
  console.error(`[node-mcp] ${message}`);
  process.exit(status);
}

function appendPathEnv(value, entry) {
  const existing = value
    ? String(value)
        .split(CONTAINER_PATH_DELIMITER)
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
  if (!existing.includes(entry)) {
    existing.push(entry);
  }
  return existing.join(CONTAINER_PATH_DELIMITER);
}

const argv = process.argv.slice(2);
const scriptPath = argv.shift();
if (!scriptPath) {
  fail("usage: node-mcp-launcher.cjs <script> [args...]", 64);
}
if (!fs.existsSync(scriptPath)) {
  fail(`launch script does not exist: ${scriptPath}`);
}

const child = spawn(process.execPath, [scriptPath, ...argv], {
  cwd: path.dirname(scriptPath),
  env: {
    ...process.env,
    NODE_PATH: appendPathEnv(process.env.NODE_PATH, REPO_NODE_MODULES),
  },
  stdio: "inherit",
});

child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
