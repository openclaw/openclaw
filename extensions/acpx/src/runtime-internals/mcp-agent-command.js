import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAndCollect } from "./process.js";
const ACPX_BUILTIN_AGENT_COMMANDS = {
  codex: "npx @zed-industries/codex-acp",
  claude: "npx -y @zed-industries/claude-agent-acp",
  gemini: "gemini",
  opencode: "npx -y opencode-ai acp",
  pi: "npx pi-acp"
};
const MCP_PROXY_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mcp-proxy.mjs");
function normalizeAgentName(value) {
  return value.trim().toLowerCase();
}
function quoteCommandPart(value) {
  if (value === "") {
    return '""';
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}
const __testing = {
  quoteCommandPart
};
function toCommandLine(parts) {
  return parts.map(quoteCommandPart).join(" ");
}
function readConfiguredAgentOverrides(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const overrides = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const command = entry.command;
    if (typeof command !== "string" || command.trim() === "") {
      continue;
    }
    overrides[normalizeAgentName(name)] = command.trim();
  }
  return overrides;
}
async function loadAgentOverrides(params) {
  const result = await spawnAndCollect(
    {
      command: params.acpxCommand,
      args: ["--cwd", params.cwd, "config", "show"],
      cwd: params.cwd,
      stripProviderAuthEnvVars: params.stripProviderAuthEnvVars
    },
    params.spawnOptions
  );
  if (result.error || (result.code ?? 0) !== 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return readConfiguredAgentOverrides(parsed.agents);
  } catch {
    return {};
  }
}
async function resolveAcpxAgentCommand(params) {
  const normalizedAgent = normalizeAgentName(params.agent);
  const overrides = await loadAgentOverrides({
    acpxCommand: params.acpxCommand,
    cwd: params.cwd,
    stripProviderAuthEnvVars: params.stripProviderAuthEnvVars,
    spawnOptions: params.spawnOptions
  });
  return overrides[normalizedAgent] ?? ACPX_BUILTIN_AGENT_COMMANDS[normalizedAgent] ?? params.agent;
}
function buildMcpProxyAgentCommand(params) {
  const payload = Buffer.from(
    JSON.stringify({
      targetCommand: params.targetCommand,
      mcpServers: params.mcpServers
    }),
    "utf8"
  ).toString("base64url");
  return toCommandLine([process.execPath, MCP_PROXY_PATH, "--payload", payload]);
}
export {
  __testing,
  buildMcpProxyAgentCommand,
  resolveAcpxAgentCommand
};
