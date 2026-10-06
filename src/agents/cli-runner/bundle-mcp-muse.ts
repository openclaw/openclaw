import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyMergePatch } from "../../config/merge-patch.js";
import { tryReadJson, writeJson } from "../../infra/json-files.js";
import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.types.js";
import {
  decodeHeaderEnvPlaceholder,
  isRecord,
  normalizeBundleMcpServerConfig,
  normalizeMcpStringRecord,
} from "../bundle-mcp-adapter.js";
import { withOpenClawMcpCaptureHeader } from "./bundle-mcp-runtime.js";

const MUSE_MCP_SERVER_FIELDS = { strings: ["type"] } as const;

/** Entries symlinked from the real Muse config dir so auth survives staging. */
const MUSE_PASSTHROUGH_ENTRIES = ["auth.json", "trust.json", "skills"] as const;

function resolveMuseConfigDir(
  inheritedEnv: Record<string, string> | undefined,
): string {
  const xdg =
    inheritedEnv?.XDG_CONFIG_HOME ?? process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "muse");
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const raw = await tryReadJson<unknown>(filePath);
  return isRecord(raw) ? { ...raw } : {};
}

function resolveEnvPlaceholder(
  value: string,
  inheritedEnv: Record<string, string> | undefined,
): string {
  // Muse expands no ${} placeholders itself; resolve from the inherited run
  // env first, then the process env.
  const decoded = decodeHeaderEnvPlaceholder(value);
  if (!decoded) {
    return value;
  }
  const resolved = inheritedEnv?.[decoded.envVar] ?? process.env[decoded.envVar] ?? "";
  return decoded.bearer ? `Bearer ${resolved}` : resolved;
}

function toMuseServerType(value: unknown): string | undefined {
  // Muse only understands "streamable-http" for HTTP servers; "http" makes it
  // attempt a stdio spawn and skip the server.
  if (value === "http") {
    return "streamable-http";
  }
  return typeof value === "string" ? value : undefined;
}

function normalizeMuseServerConfig(
  server: BundleMcpServerConfig,
  inheritedEnv: Record<string, string> | undefined,
): Record<string, unknown> {
  const next = normalizeBundleMcpServerConfig(server, MUSE_MCP_SERVER_FIELDS);
  const type = toMuseServerType(server.type);
  if (type) {
    next.type = type;
  }
  const headers = normalizeMcpStringRecord(server.headers);
  if (headers) {
    next.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, resolveEnvPlaceholder(value, inheritedEnv)]),
    );
  }
  if (type === "streamable-http") {
    // Muse rejects stdio fields on the streamable transport.
    delete next.command;
    delete next.args;
    delete next.env;
  }
  return next;
}

/**
 * Stage a per-turn XDG_CONFIG_HOME for Muse: the real settings.json merged
 * with bundle MCP servers, plus auth/trust symlinks so the user's Muse
 * subscription keeps working. Secrets are never copied.
 *
 * Client-side tool filters are intentionally omitted: Muse has no
 * include/exclude contract, and the loopback grant scope enforces denials
 * server-side.
 */
export async function writeMuseSystemSettings(
  mergedConfig: BundleMcpConfig,
  inheritedEnv: Record<string, string> | undefined,
): Promise<{ env: Record<string, string>; cleanup: () => Promise<void> }> {
  const realDir = resolveMuseConfigDir(inheritedEnv);
  const stagedXdg = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-muse-mcp-"));
  const stagedMuse = path.join(stagedXdg, "muse");
  await fs.mkdir(stagedMuse, { recursive: true });
  const cleanup = () => fs.rm(stagedXdg, { recursive: true, force: true });
  try {
    const base = await readJsonObject(path.join(realDir, "settings.json"));
    const mcpServers = Object.fromEntries(
      Object.entries(mergedConfig.mcpServers).map(([name, server]) => [
        name,
        normalizeMuseServerConfig(server, inheritedEnv),
      ]),
    );
    const settings = applyMergePatch(base, { mcpServers }) as Record<string, unknown>;
    await writeJson(path.join(stagedMuse, "settings.json"), settings, { trailingNewline: true });
    for (const name of MUSE_PASSTHROUGH_ENTRIES) {
      try {
        await fs.symlink(path.join(realDir, name), path.join(stagedMuse, name));
      } catch {
        // Missing entry: the CLI runs without it.
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    env: { ...inheritedEnv, XDG_CONFIG_HOME: stagedXdg },
    cleanup,
  };
}

/** Rewrite the staged Muse settings in place with the active loopback capture token. */
export async function writeMuseMcpCaptureSettings(params: {
  inheritedEnv: Record<string, string> | undefined;
  captureKey: string;
}): Promise<{ env: Record<string, string> | undefined }> {
  const stagedXdg = params.inheritedEnv?.XDG_CONFIG_HOME;
  if (!stagedXdg) {
    throw new Error("Muse MCP capture requires prepared XDG staging");
  }
  const settingsPath = path.join(stagedXdg, "muse", "settings.json");
  const settings = await readJsonObject(settingsPath);
  await writeJson(settingsPath, withOpenClawMcpCaptureHeader(settings, params.captureKey), {
    trailingNewline: true,
  });
  return { env: params.inheritedEnv };
}
