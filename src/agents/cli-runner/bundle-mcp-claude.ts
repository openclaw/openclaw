/**
 * Claude CLI argument helpers for OpenClaw-managed bundle MCP config.
 */
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sanitizeServerName } from "../agent-bundle-mcp-names.js";
import type { ClaudeMcpServerToolPolicies, ClaudeMcpServerToolPolicy } from "./types.js";

const CLAUDE_RESERVED_MCP_SERVER_NAMES = new Set(["computer-use"]);

function normalizeMcpServerName(name: string): string {
  return name.trim().toLowerCase();
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  return entries.length > 0 ? entries : undefined;
}

function resolveClaudeMcpServerName(name: string, usedNames: Set<string>): string {
  if (!CLAUDE_RESERVED_MCP_SERVER_NAMES.has(normalizeMcpServerName(name))) {
    return name;
  }
  const base = `openclaw-mcp-${name}`;
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(normalizeMcpServerName(candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/** Prepare Claude-native MCP entries while retaining OpenClaw-owned policy metadata. */
export function prepareClaudeMcpServers(
  mcpServers: Record<string, unknown>,
  options?: {
    nativeServerNames?: ReadonlySet<string>;
    managedServerOrder?: readonly string[];
  },
): {
  mcpServers: Record<string, unknown>;
  toolPolicies: ClaudeMcpServerToolPolicies;
  nativeServerNames: string[];
} {
  const nativeServerNames = options?.nativeServerNames ?? new Set<string>();
  const managedServerNames = new Set<string>();
  const orderedManagedServerNames = [
    ...(options?.managedServerOrder ?? []),
    ...Object.keys(mcpServers),
  ].filter((name) => {
    if (nativeServerNames.has(name) || managedServerNames.has(name) || !(name in mcpServers)) {
      return false;
    }
    managedServerNames.add(name);
    return true;
  });
  const usedSafeNames = new Set<string>();
  const safeNames = new Map(
    orderedManagedServerNames.map((name) => [name, sanitizeServerName(name, usedSafeNames)]),
  );
  const usedNames = new Set(
    Object.keys(mcpServers)
      .filter(
        (name) =>
          nativeServerNames.has(name) ||
          !CLAUDE_RESERVED_MCP_SERVER_NAMES.has(normalizeMcpServerName(name)),
      )
      .map(normalizeMcpServerName),
  );
  const preparedServers: Record<string, unknown> = {};
  const toolPolicies: ClaudeMcpServerToolPolicies = {};
  for (const [configuredName, rawServer] of Object.entries(mcpServers)) {
    if (nativeServerNames.has(configuredName)) {
      preparedServers[configuredName] = rawServer;
      continue;
    }
    const runtimeName = resolveClaudeMcpServerName(configuredName, usedNames);
    usedNames.add(normalizeMcpServerName(runtimeName));
    const toolFilter =
      isRecord(rawServer) && isRecord(rawServer.toolFilter) ? rawServer.toolFilter : undefined;
    const policy: ClaudeMcpServerToolPolicy = {
      configuredName,
      safeName: safeNames.get(configuredName)!,
      ...(toolFilter
        ? {
            include: normalizeStringList(toolFilter.include),
            exclude: normalizeStringList(toolFilter.exclude),
          }
        : {}),
    };
    preparedServers[runtimeName] = stripClaudeMcpServerPolicyFields(rawServer);
    toolPolicies[runtimeName] = policy;
  }
  return {
    mcpServers: preparedServers,
    toolPolicies,
    nativeServerNames: [...nativeServerNames].toSorted(),
  };
}

/** Returns whether Claude's generated config contains servers outside OpenClaw's loopback. */
export function hasExternalClaudeMcpServerPolicies(
  policies: ClaudeMcpServerToolPolicies | undefined,
): boolean {
  return Object.values(policies ?? {}).some((policy) => policy.configuredName !== "openclaw");
}

/** Remove OpenClaw-only policy metadata from one Claude-native MCP server entry. */
function stripClaudeMcpServerPolicyFields(server: unknown): unknown {
  if (!isRecord(server)) {
    return server;
  }
  const next = { ...server };
  delete next.enabled;
  delete next.toolFilter;
  delete next.codex;
  return next;
}

/** Find existing Claude `--mcp-config` argument values. */
export function findClaudeMcpConfigPaths(args?: string[]): string[] {
  const paths: string[] = [];
  if (!args?.length) {
    return paths;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      // Claude treats --mcp-config as variadic. Keep this scan aligned with
      // extensions/anthropic/cli-shared.ts so user config files are not leaked
      // as positional prompts after OpenClaw injects its strict overlay.
      while (typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
        i += 1;
        const path = normalizeOptionalString(args[i]);
        if (path) {
          paths.push(path);
        }
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      const path = normalizeOptionalString(arg.slice("--mcp-config=".length));
      if (path) {
        paths.push(path);
      }
    }
  }
  return paths;
}

/** Find an existing Claude `--mcp-config` argument value. */
export function findClaudeMcpConfigPath(args?: string[]): string | undefined {
  return findClaudeMcpConfigPaths(args)[0];
}

/** Return Claude args with OpenClaw's strict MCP config path injected. */
export function injectClaudeMcpConfigArgs(
  args: string[] | undefined,
  mcpConfigPath: string,
): string[] {
  const next: string[] = [];
  for (let i = 0; i < (args?.length ?? 0); i += 1) {
    const arg = args?.[i] ?? "";
    if (arg === "--strict-mcp-config") {
      continue;
    }
    if (arg === "--mcp-config") {
      while (typeof args?.[i + 1] === "string" && !args[i + 1]?.startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      continue;
    }
    next.push(arg);
  }
  next.push("--strict-mcp-config", "--mcp-config", mcpConfigPath);
  return next;
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
  const mcpServers = isRecord(raw.mcpServers) ? raw.mcpServers : {};
  const openclaw = isRecord(mcpServers.openclaw) ? mcpServers.openclaw : undefined;
  if (!openclaw) {
    throw new Error("Claude MCP capture requires an openclaw server config");
  }
  const headers = isRecord(openclaw.headers) ? openclaw.headers : {};
  await fs.writeFile(
    params.mcpConfigPath,
    `${JSON.stringify(
      {
        ...raw,
        mcpServers: {
          ...mcpServers,
          openclaw: {
            ...openclaw,
            headers: {
              ...headers,
              "x-openclaw-cli-capture-key": params.captureKey,
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}
