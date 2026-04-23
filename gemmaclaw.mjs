#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SIGNAL_EXIT_CODES = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

const here = path.dirname(fileURLToPath(import.meta.url));
const openclawEntrypoint = path.join(here, "openclaw.mjs");

const child = spawn(process.execPath, [openclawEntrypoint, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});

child.once("exit", (code, signal) => {
  if (signal) {
    process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    return;
  }
  process.exit(code ?? 1);
});

child.once("error", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`gemmaclaw: failed to launch openclaw.mjs: ${msg}\n`);
  process.exit(1);
});
