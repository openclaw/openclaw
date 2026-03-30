#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { bundledPluginFile } from "./lib/bundled-plugin-paths.mjs";

const args = [
  "run",
  bundledPluginFile("voice-call", "src/manager.test.ts"),
  bundledPluginFile("voice-call", "src/media-stream.test.ts"),
  "src/plugins/voice-call.plugin.test.ts",
  "--maxWorkers=1",
];

execFileSync("vitest", args, {
  stdio: "inherit",
});
