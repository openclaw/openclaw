import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { BundleMcpConfig } from "../../plugins/bundle-mcp.js";
import { resolveQuestionTimeoutMs } from "../tools/ask-user-tool-normalization.js";
import { withOpenClawMcpCaptureHeader } from "./bundle-mcp-runtime.js";

export const CLAUDE_MANAGED_MCP_TIMEOUT_MS = resolveQuestionTimeoutMs(3_600);

export function applyClaudeManagedMcpTimeout(config: BundleMcpConfig): BundleMcpConfig {
  return {
    ...config,
    mcpServers: {
      ...config.mcpServers,
      openclaw: {
        ...config.mcpServers.openclaw,
        timeout: CLAUDE_MANAGED_MCP_TIMEOUT_MS,
      },
    },
  };
}

// Config paths and disallowed tools both use Claude's variadic/equals grammar.
// Discovery and replacement must consume the same span to avoid leaking paths as prompts.
function extractClaudeVariadicArgs(args: string[], names: readonly string[]) {
  const next: string[] = [];
  const values: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const equalsIndex = arg.indexOf("=");
    const name = equalsIndex < 0 ? arg : arg.slice(0, equalsIndex);
    if (!names.includes(name)) {
      next.push(arg);
    } else if (equalsIndex >= 0) {
      values.push(arg.slice(equalsIndex + 1));
    } else {
      while (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
        i += 1;
        values.push(args[i] ?? "");
      }
    }
  }
  return { args: next, values };
}

export function findClaudeMcpConfigPaths(args?: string[]): string[] {
  return extractClaudeVariadicArgs(args ?? [], ["--mcp-config"])
    .values.map(normalizeOptionalString)
    .filter((value): value is string => value !== undefined);
}

function mergeClaudeDisallowedTools(args: string[], deniedTools: string[]): string[] {
  if (deniedTools.length === 0) {
    return args;
  }
  const { args: next, values } = extractClaudeVariadicArgs(args, [
    "--disallowedTools",
    "--disallowed-tools",
  ]);
  next.push("--disallowedTools", [...new Set([...values, ...deniedTools])].join(","));
  return next;
}

function normalizeClaudeMcpIdentifierPart(value: string): string {
  // Claude Code replaces punctuation before registering MCP permission names.
  // Match that wire identity so a raw-name collision cannot bypass a denial.
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}

export function injectClaudeWebSearchDisabledArgs(args: string[] | undefined): string[] {
  return mergeClaudeDisallowedTools(args ?? [], ["WebSearch"]);
}

export function injectClaudeMcpConfigArgs(
  args: string[] | undefined,
  mcpConfigPath: string,
  mcpToolsDeny?: Record<string, string[]>,
  webSearchEnabled?: boolean,
): string[] {
  const next = extractClaudeVariadicArgs(args ?? [], ["--mcp-config"]).args.filter(
    (arg) => arg !== "--strict-mcp-config",
  );
  next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  const deniedTools = Object.entries(mcpToolsDeny ?? {}).flatMap(([serverName, toolNames]) =>
    toolNames.map(
      (toolName) =>
        `mcp__${normalizeClaudeMcpIdentifierPart(serverName)}__${normalizeClaudeMcpIdentifierPart(toolName)}`,
    ),
  );
  if (webSearchEnabled === false) {
    deniedTools.push("WebSearch");
  }
  return mergeClaudeDisallowedTools(next, deniedTools.toSorted());
}

/** Writes the active per-attempt capture token into OpenClaw's generated Claude MCP config. */
export async function writeClaudeMcpCaptureConfig(params: {
  mcpConfigPath: string;
  captureKey: string;
}): Promise<void> {
  const raw = JSON.parse(await fs.readFile(params.mcpConfigPath, "utf-8")) as unknown;
  if (!isRecord(raw)) {
    throw new Error("Claude MCP capture requires an object config");
  }
  await fs.writeFile(
    params.mcpConfigPath,
    `${JSON.stringify(
      withOpenClawMcpCaptureHeader(
        raw,
        params.captureKey,
        "Claude MCP capture requires an openclaw server config",
      ),
      null,
      2,
    )}\n`,
    "utf-8",
  );
}
