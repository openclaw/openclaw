import { spawn } from "node:child_process";
import type { CodexAppServerStartOptions } from "./config.js";
import type { CodexAppServerTransport } from "./transport.js";

export function createStdioTransport(options: CodexAppServerStartOptions): CodexAppServerTransport {
  return spawn(options.command, options.args, {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}
