/**
 * Shared normalization helpers for CLI-specific bundle MCP adapters.
 */
import type { BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { toMcpStringRecord } from "../mcp-config-shared.js";
/** Re-exported record guard for adapter modules that share loose JSON inputs. */
export { isRecord } from "../../../packages/normalization-core/src/record-coerce.js";

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : undefined;
}

/** Normalize MCP env/header scalar values into the strings expected by CLI runtimes. */
export function normalizeStringRecord(value: unknown): Record<string, string> | undefined {
  return toMcpStringRecord(value);
}

/** Decode supported `${ENV}` and `Bearer ${ENV}` header placeholders. */
export function decodeHeaderEnvPlaceholder(
  value: string,
): { envVar: string; bearer: boolean } | null {
  const bearerMatch = /^Bearer \${([A-Z0-9_]+)}$/.exec(value);
  if (bearerMatch) {
    return { envVar: bearerMatch[1], bearer: true };
  }
  const envMatch = /^\${([A-Z0-9_]+)}$/.exec(value);
  if (envMatch) {
    return { envVar: envMatch[1], bearer: false };
  }
  return null;
}

/** Copy common MCP server config fields into a CLI adapter config object. */
export function applyCommonServerConfig(
  next: Record<string, unknown>,
  server: BundleMcpServerConfig,
): void {
  if (typeof server.command === "string") {
    next.command = server.command;
  }
  const args = normalizeStringArray(server.args);
  if (args) {
    next.args = args;
  }
  const env = normalizeStringRecord(server.env);
  if (env) {
    next.env = env;
  }
  if (typeof server.cwd === "string") {
    next.cwd = server.cwd;
  }
  if (typeof server.url === "string") {
    next.url = server.url;
  }
}
