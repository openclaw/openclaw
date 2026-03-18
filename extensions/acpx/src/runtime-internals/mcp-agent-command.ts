import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAndCollect, type SpawnCommandOptions } from "./process.js";

// Keep this mirror aligned with openclaw/acpx src/agent-registry.ts built-ins.
const ACPX_BUILTIN_AGENT_COMMANDS: Record<string, string> = {
  pi: "npx -y pi-acp@0.0.22",
  openclaw: "openclaw acp",
  codex: "npx -y @zed-industries/codex-acp@0.9.5",
  claude: "npx -y @zed-industries/claude-agent-acp@0.21.0",
  gemini: "gemini --acp",
  cursor: "cursor-agent acp",
  copilot: "copilot --acp --stdio",
  droid: "droid exec --output-format acp",
  iflow: "iflow --experimental-acp",
  kilocode: "npx -y @kilocode/cli acp",
  kimi: "kimi acp",
  kiro: "kiro-cli acp",
  opencode: "npx -y opencode-ai acp",
  qwen: "qwen --acp",
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
      args: ["--cd", params.cwd, "config", "show"],
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
}): Promise<string | null> {
  const normalizedAgent = normalizeAgentName(params.agent);
  const overrides = await loadAgentOverrides({
    acpxCommand: params.acpxCommand,
    cwd: params.cwd,
    stripProviderAuthEnvVars: params.stripProviderAuthEnvVars,
    spawnOptions: params.spawnOptions,
  });
  return overrides[normalizedAgent] ?? ACPX_BUILTIN_AGENT_COMMANDS[normalizedAgent] ?? null;
}

export function buildMcpProxyAgentCommand(params: {
  targetCommand: string;
  mcpServers: AcpMcpServer[];
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      targetCommand: params.targetCommand,
      mcpServers: params.mcpServers,
    }),
    "utf8",
  ).toString("base64url");
  return toCommandLine([process.execPath, MCP_PROXY_PATH, "--payload", payload]);
}
