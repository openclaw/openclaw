#!/usr/bin/env node

import { spawn } from "node:child_process";
import { splitCommandLine } from "./split-command-line.mjs";

function decodePayload(argv) {
  const payloadIndex = argv.indexOf("--payload");
  if (payloadIndex < 0) {
    throw new Error("Missing --payload");
  }
  const encoded = argv[payloadIndex + 1];
  if (!encoded) {
    throw new Error("Missing Codex bootstrap payload value");
  }
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Codex bootstrap payload");
  }
  if (typeof parsed.targetCommand !== "string" || parsed.targetCommand.trim() === "") {
    throw new Error("Codex bootstrap payload missing targetCommand");
  }
  const bootstrap =
    parsed.bootstrap && typeof parsed.bootstrap === "object" && !Array.isArray(parsed.bootstrap)
      ? parsed.bootstrap
      : {};
  const model =
    typeof bootstrap.model === "string" && bootstrap.model.trim() ? bootstrap.model : "";
  const reasoningEffort =
    typeof bootstrap.reasoningEffort === "string" && bootstrap.reasoningEffort.trim()
      ? bootstrap.reasoningEffort
      : "";
  return {
    targetCommand: parsed.targetCommand,
    model: model || undefined,
    reasoningEffort: reasoningEffort || undefined,
  };
}

function buildCliOverrides(params) {
  const args = [];
  if (params.model) {
    args.push("-c", `model=${JSON.stringify(params.model)}`);
  }
  if (params.reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(params.reasoningEffort)}`);
  }
  return args;
}

const payload = decodePayload(process.argv.slice(2));
const target = splitCommandLine(payload.targetCommand);
const child = spawn(target.command, [...target.args, ...buildCliOverrides(payload)], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
});

if (!child.stdin || !child.stdout) {
  throw new Error("Failed to create Codex bootstrap wrapper stdio pipes");
}

process.stdin.pipe(child.stdin);
child.stdin.on("error", () => {
  // Ignore EPIPE when the child exits before stdin flush completes.
});
child.stdout.pipe(process.stdout);

child.on("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
