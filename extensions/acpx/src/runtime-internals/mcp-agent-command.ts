import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAndCollect, type SpawnCommandOptions } from "./process.js";

const ACPX_BUILTIN_AGENT_COMMANDS: Record<string, string> = {
  codex: "npx @zed-industries/codex-acp",
  claude: "npx -y @zed-industries/claude-agent-acp",
  gemini: "gemini",
  opencode: "npx -y opencode-ai acp",
  pi: "npx pi-acp",
};

const MCP_PROXY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mcp-proxy.mjs");

type AcpxConfigDisplay = {
  agents?: Record<string, { command?: unknown }>;
};

type AcpMcpServer = {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
};

function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase();
}

function quoteCommandPart(value: string): string {
  if (value === "") {
    return '""';
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

export const __testing = {
  quoteCommandPart,
};

function toCommandLine(parts: string[]): string {
  return parts.map(quoteCommandPart).join(" ");
}

function readConfiguredAgentOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const overrides: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const command = (entry as { command?: unknown }).command;
    if (typeof command !== "string" || command.trim() === "") {
      continue;
    }
    overrides[normalizeAgentName(name)] = command.trim();
  }
  return overrides;
}

async function loadAgentOverrides(params: {
  acpxCommand: string;
  cwd: string;
  stripProviderAuthEnvVars?: boolean;
  spawnOptions?: SpawnCommandOptions;
}): Promise<Record<string, string>> {
  const result = await spawnAndCollect(
    {
      command: params.acpxCommand,
      args: ["--cwd", params.cwd, "config", "show"],
      cwd: params.cwd,
      stripProviderAuthEnvVars: params.stripProviderAuthEnvVars,
    },
    params.spawnOptions,
  );
  if (result.error || (result.code ?? 0) !== 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(result.stdout) as AcpxConfigDisplay;
    return readConfiguredAgentOverrides(parsed.agents);
  } catch {
    return {};
  }
}

export async function resolveAcpxAgentCommand(params: {
  acpxCommand: string;
  cwd: string;
  agent: string;
  stripProviderAuthEnvVars?: boolean;
  spawnOptions?: SpawnCommandOptions;
}): Promise<string> {
  const normalizedAgent = normalizeAgentName(params.agent);
  const overrides = await loadAgentOverrides({
    acpxCommand: params.acpxCommand,
    cwd: params.cwd,
    stripProviderAuthEnvVars: params.stripProviderAuthEnvVars,
    spawnOptions: params.spawnOptions,
  });
  return overrides[normalizedAgent] ?? ACPX_BUILTIN_AGENT_COMMANDS[normalizedAgent] ?? params.agent;
}

/** Split a shell-style command string into command + args (POSIX quoting rules). */
function splitCommandLineParts(value: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaping = false;

  for (const ch of value) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
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
  if (current.length > 0) {
    parts.push(current);
  }
  if (parts.length === 0) {
    throw new Error("Invalid agent command: empty command");
  }
  return { command: parts[0], args: parts.slice(1) };
}

export function buildMcpProxyAgentCommand(params: {
  targetCommand: string;
  mcpServers: AcpMcpServer[];
}): string {
  // Pre-split so mcp-proxy.mjs can spawn without re-parsing the command string.
  // This avoids platform-specific quoting issues (e.g. Windows paths) in the proxy.
  const targetCommandParts = splitCommandLineParts(params.targetCommand);
  const payload = Buffer.from(
    JSON.stringify({
      targetCommand: params.targetCommand,
      targetCommandParts,
      mcpServers: params.mcpServers,
    }),
    "utf8",
  ).toString("base64url");
  return toCommandLine([process.execPath, MCP_PROXY_PATH, "--payload", payload]);
}
