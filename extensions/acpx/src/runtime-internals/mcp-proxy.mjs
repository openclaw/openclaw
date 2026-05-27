#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { formatErrorMessage } from "./error-format.mjs";
import { splitCommandLine } from "./mcp-command-line.mjs";

function verifyPayloadSignature(parsed) {
  const secret = process.env.OPENCLAW_MCP_PROXY_SECRET;
  if (!secret) {
    return;
  }

  const { signature, ...rest } = parsed;
  if (!signature) {
    throw new Error(
      "MCP proxy payload missing required signature (OPENCLAW_MCP_PROXY_SECRET is set)",
    );
  }

  const hmac = createHmac("sha256", secret);
  
  // We expect the signature to be over the canonical JSON of the payload minus the signature itself
  const canonicalBody = JSON.stringify(rest);
  hmac.update(canonicalBody);
  const expected = hmac.digest("hex");

  if (signature !== expected) {
    throw new Error("MCP proxy payload signature verification failed");
  }
}

function decodePayload(argv) {
  const payloadIndex = argv.indexOf("--payload");
  if (payloadIndex < 0) {
    throw new Error("Missing --payload");
  }
  const encoded = argv[payloadIndex + 1];
  if (!encoded) {
    throw new Error("Missing MCP proxy payload value");
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf8");
  const parsed = JSON.parse(decoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP proxy payload");
  }

  verifyPayloadSignature(parsed);

  if (typeof parsed.targetCommand !== "string" || parsed.targetCommand.trim() === "") {
    throw new Error("MCP proxy payload missing targetCommand");
  }
  const mcpServers = Array.isArray(parsed.mcpServers) ? parsed.mcpServers : [];
  return {
    targetCommand: parsed.targetCommand,
    mcpServers,
  };
}

function shouldInject(method) {
  return method === "session/new" || method === "session/load" || method === "session/fork";
}

function rewriteLine(line, mcpServers) {
  if (!line.trim()) {
    return line;
  }
  try {
    const parsed = JSON.parse(line);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      !shouldInject(parsed.method) ||
      !parsed.params ||
      typeof parsed.params !== "object" ||
      Array.isArray(parsed.params)
    ) {
      return line;
    }
    const next = {
      ...parsed,
      params: {
        ...parsed.params,
        mcpServers,
      },
    };
    return JSON.stringify(next);
  } catch {
    return line;
  }
}

export function createTargetSpawnOptions(platform = process.platform) {
  const options = {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  };
  if (platform === "win32") {
    options.windowsHide = true;
  }
  return options;
}

function isMainModule() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

function assertSafeCommand(target) {
  const allowedPrefix = process.env.OPENCLAW_MCP_PROXY_ALLOWED_COMMAND_PREFIX;
  if (allowedPrefix && !target.command.startsWith(allowedPrefix)) {
    throw new Error(
      `MCP proxy blocked command: does not start with allowed prefix "${allowedPrefix}"`,
    );
  }
}

function main() {
  const { targetCommand, mcpServers } = decodePayload(process.argv.slice(2));
  const target = splitCommandLine(targetCommand);
  assertSafeCommand(target);
  const child = spawn(target.command, target.args, createTargetSpawnOptions());

  if (!child.stdin || !child.stdout) {
    throw new Error("Failed to create MCP proxy stdio pipes");
  }

  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    child.stdin.write(`${rewriteLine(line, mcpServers)}\n`);
  });
  input.on("close", () => {
    child.stdin.end();
  });

  child.stdout.pipe(process.stdout);

  child.on("error", (error) => {
    process.stderr.write(`${formatErrorMessage(error)}\n`);
    process.exit(1);
  });

  child.on("close", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

if (isMainModule()) {
  main();
}
