#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const localOnly = args.has("--local-only");

function run(command, commandArgs, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const maxBytes = options.maxBytes ?? 512_000;
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-maxBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-maxBytes);
    });
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
    child.on("close", (status) => {
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

function summarizeText(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function discordLooksConnected(value) {
  const serialized = JSON.stringify(value ?? {}).toLowerCase();
  return serialized.includes("discord") && serialized.includes("connected");
}

const checks = [];

const localFlow = await run(process.execPath, [
  "scripts/run-vitest.mjs",
  "run",
  "extensions/gesahni/index.test.ts",
  "--reporter=dot",
]);
checks.push({
  name: "gesahni_local_v1_flow",
  pass: localFlow.status === 0,
  command: "node scripts/run-vitest.mjs run extensions/gesahni/index.test.ts --reporter=dot",
  summary: summarizeText(
    localFlow.status === 0 ? localFlow.stdout : `${localFlow.stdout}\n${localFlow.stderr}`,
  ),
});

if (!localOnly) {
  const gateway = await run(process.execPath, ["openclaw.mjs", "gateway", "status", "--deep"]);
  const gatewayText = `${gateway.stdout}\n${gateway.stderr}`;
  checks.push({
    name: "gateway_status_deep_18789",
    pass: gateway.status === 0 && gatewayText.includes("127.0.0.1:18789"),
    command: "node openclaw.mjs gateway status --deep",
    summary: summarizeText(gatewayText),
  });

  const discord = await run(process.execPath, [
    "openclaw.mjs",
    "channels",
    "status",
    "discord",
    "--json",
  ]);
  const discordJson = parseJson(discord.stdout);
  checks.push({
    name: "discord_channel_connected",
    pass: discord.status === 0 && discordLooksConnected(discordJson ?? discord.stdout),
    command: "node openclaw.mjs channels status discord --json",
    summary: discordJson ?? summarizeText(`${discord.stdout}\n${discord.stderr}`),
  });
}

const result = {
  ok: checks.every((check) => check.pass),
  localOnly,
  checkedAt: new Date().toISOString(),
  checks,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exitCode = result.ok ? 0 : 1;
