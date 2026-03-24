#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

const PROTOCOL_OUTPUTS = [
  "dist/protocol.schema.json",
  "apps/macos/Sources/OpenClawProtocol/GatewayModels.swift",
  "apps/shared/OpenClawKit/Sources/OpenClawProtocol/GatewayModels.swift",
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
}

function runPackageScript(scriptName) {
  const execPath = process.env.npm_execpath;
  if (!execPath) {
    throw new Error("npm_execpath is not set");
  }
  return run(process.execPath, [execPath, scriptName]);
}

export function main() {
  for (const scriptName of ["protocol:gen", "protocol:gen:swift"]) {
    const result = runPackageScript(scriptName);
    if ((result.status ?? 1) !== 0) {
      return result.status ?? 1;
    }
  }

  const diffResult = run("git", ["diff", "--exit-code", "--", ...PROTOCOL_OUTPUTS]);
  return diffResult.status ?? 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`${String(error.message ?? error)}\n`);
    process.exit(1);
  }
}
