#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const WINDOWS_EXECUTABLE_PATH_RE =
  /^(?<command>(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]).*?\.(?:exe|com))(?=\s|$)(?:\s+(?<rest>.*))?$/i;

function splitCommandParts(value, platform = process.platform) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaping = false;

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index];
    const next = value[index + 1];
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      if (quote === "'") {
        current += ch;
        continue;
      }
      if (platform === "win32") {
        if (quote === '"') {
          if (next === '"' || next === "\\") {
            escaping = true;
            continue;
          }
          current += ch;
          continue;
        }
        if (!quote) {
          current += ch;
          continue;
        }
      }
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Invalid agent command: unterminated quote");
  }
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    return [];
  }
  return parts;
}

function splitWindowsExecutableCommand(value, platform = process.platform) {
  if (platform !== "win32") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('"') || trimmed.startsWith("'")) {
    return null;
  }
  const match = trimmed.match(WINDOWS_EXECUTABLE_PATH_RE);
  if (!match?.groups?.command) {
    return null;
  }
  const rest = match.groups.rest?.trim() ?? "";
  return {
    command: match.groups.command,
    args: rest ? splitCommandParts(rest, platform) : [],
  };
}

export function splitCommandLine(value, platform = process.platform) {
  const windowsCommand = splitWindowsExecutableCommand(value, platform);
  if (windowsCommand) {
    return windowsCommand;
  }
  const parts = splitCommandParts(value, platform);
  if (parts.length === 0) {
    throw new Error("Invalid agent command: empty command");
  }
  return {
    command: parts[0],
    args: parts.slice(1),
  };
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
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid MCP proxy payload");
  }
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

function isMainModule() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

function main() {
  const { targetCommand, mcpServers } = decodePayload(process.argv.slice(2));
  const target = splitCommandLine(targetCommand);
  const child = spawn(target.command, target.args, {
    stdio: ["pipe", "pipe", "inherit"],
    env: process.env,
  });

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
}

if (isMainModule()) {
  main();
}
