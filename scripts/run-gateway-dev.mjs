#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";
import { runNodeMain } from "./run-node.mjs";

export function resolveGatewayDevArgs(args = []) {
  return ["--dev", "gateway", ...args];
}

export async function runGatewayDevMain(params = {}) {
  const env = { ...(params.env ?? process.env) };
  env.OPENCLAW_SKIP_CHANNELS = "1";
  env.CLAWDBOT_SKIP_CHANNELS = "1";
  const args = resolveGatewayDevArgs(params.args ?? process.argv.slice(2));
  const run = params.runNodeMain ?? runNodeMain;
  return await run({
    ...params,
    env,
    args,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void runGatewayDevMain()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
