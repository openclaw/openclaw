import type { AcpAgentRegistry } from "acpx/runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_ACP_PACKAGE } from "./codex-adapter.js";

export type AcpxAgentCommand = string | string[];

/** Match ACPX's persisted argv identity; scalar records keep their original bytes. */
export function renderAgentCommand(command: AcpxAgentCommand): string {
  return typeof command === "string"
    ? command
    : command
        .map((part) => (/^[A-Za-z0-9_@%+=:,./^~-]+$/.test(part) ? part : JSON.stringify(part)))
        .join(" ");
}

/** Split a command string into argv-like parts using simple quote/backslash rules. */
export function splitCommandParts(value: AcpxAgentCommand): string[] {
  if (Array.isArray(value)) {
    return value;
  }
  const windows = process.platform === "win32";
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let hasPart = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      hasPart = true;
      continue;
    }
    if (ch === "\\" && quote !== "'" && !windows) {
      escaping = true;
      hasPart = true;
      continue;
    }
    if (windows && ch === '"' && quote !== "'") {
      // Windows folds backslash runs only before a double quote (libuv quote_cmd_arg).
      const backslashes = current.match(/\\+$/)?.[0].length ?? 0;
      current =
        current.slice(0, current.length - backslashes) + "\\".repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) {
        current += '"';
        continue;
      }
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
      hasPart = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasPart) {
        parts.push(current);
        current = "";
        hasPart = false;
      }
      continue;
    }
    current += ch;
    hasPart = true;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new Error("Invalid agent command: unterminated quote");
  }
  if (hasPart) {
    parts.push(current);
  }
  return parts;
}

function basename(value: string): string {
  return value.split(/[\\/]/).pop() ?? value;
}

function isEnvAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function unwrapEnvCommand(parts: string[]): string[] {
  const command = parts.at(0);
  if (!command || basename(command) !== "env") {
    return parts;
  }
  let index = 1;
  while (true) {
    const part = parts.at(index);
    if (!part || !isEnvAssignment(part)) {
      break;
    }
    index += 1;
  }
  return parts.slice(index);
}

function matchesExecutableName(value: string, executableName: string): boolean {
  const normalized = basename(value).toLowerCase();
  return normalized === executableName || normalized === `${executableName}.exe`;
}

function matchesPackageSpec(value: string, packageName: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === packageName || normalized.startsWith(`${packageName}@`);
}

function stripModuleExtension(value: string): string {
  return value.replace(/\.[cm]?js$/i, "").toLowerCase();
}

function isAcpCommand(
  command: AcpxAgentCommand | undefined,
  params: { packageName: string; executableName: string },
): boolean {
  if (!command) {
    return false;
  }
  const parts = unwrapEnvCommand(splitCommandParts(command));
  if (!parts.length) {
    return false;
  }
  if (parts.some((part) => matchesPackageSpec(part, params.packageName))) {
    return true;
  }
  const commandName = basename(parts[0] ?? "");
  if (matchesExecutableName(commandName, params.executableName)) {
    return true;
  }
  if (!matchesExecutableName(commandName, "node")) {
    return false;
  }
  const scriptName = stripModuleExtension(basename(parts[1] ?? ""));
  return scriptName === params.executableName || scriptName === `${params.executableName}-wrapper`;
}

export function isOpenClawBridgeCommand(command: AcpxAgentCommand | undefined): boolean {
  const [executable = "", ...args] = command ? unwrapEnvCommand(splitCommandParts(command)) : [];
  const runtime =
    basename(executable) !== "openclaw" &&
    (executable === process.execPath || /^(?:node|bun)(?:\.exe)?$/i.test(basename(executable)));
  const scriptName = basename(runtime ? (args[0] ?? "") : executable);
  return (
    (runtime ? /^openclaw(?:\.[cm]?js)?$/i.test(scriptName) : scriptName === "openclaw") &&
    args[runtime ? 1 : 0] === "acp"
  );
}

export function isCodexAcpCommand(command: AcpxAgentCommand | undefined): boolean {
  return isAcpCommand(command, {
    packageName: CODEX_ACP_PACKAGE,
    executableName: "codex-acp",
  });
}

export function isClaudeAcpCommand(command: AcpxAgentCommand | undefined): boolean {
  return isAcpCommand(command, {
    packageName: "@agentclientprotocol/claude-agent-acp",
    executableName: "claude-agent-acp",
  });
}

export function resolveAgentCommand(params: {
  agentName: string | undefined;
  agentRegistry: AcpAgentRegistry;
}): AcpxAgentCommand | undefined {
  const normalizedAgentName = normalizeOptionalLowercaseString(params.agentName);
  if (!normalizedAgentName) {
    return undefined;
  }
  return splitCommandParts(params.agentRegistry.resolve(normalizedAgentName));
}
