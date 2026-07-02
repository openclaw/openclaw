/**
 * Claude CLI argument helpers for OpenClaw-managed bundle MCP config.
 */
import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Find an existing Claude `--mcp-config` argument value. */
export function findClaudeMcpConfigPath(args?: string[]): string | undefined {
  return findAllClaudeMcpConfigPaths(args)[0];
}

/**
 * Collect all Claude `--mcp-config` argument values.
 *
 * `--mcp-config` is variadic in Claude's own arg model (see
 * `CLAUDE_SIDE_QUESTION_VARIADIC_VALUE_ARGS` in the anthropic extension):
 * every non-dash token after `--mcp-config` until the next flag is a
 * separate config file path.
 */
export function findAllClaudeMcpConfigPaths(args?: string[]): string[] {
  const paths: string[] = [];
  if (!args?.length) {
    return paths;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "--mcp-config") {
      // Variadic: collect all following non-flag values.
      while (
        i + 1 < args.length &&
        typeof args[i + 1] === "string" &&
        !(args[i + 1] ?? "").startsWith("-")
      ) {
        i += 1;
        const value = normalizeOptionalString(args[i]);
        if (value) {
          paths.push(value);
        }
      }
      continue;
    }
    if (arg.startsWith("--mcp-config=")) {
      const value = normalizeOptionalString(arg.slice("--mcp-config=".length));
      if (value) {
        paths.push(value);
      }
    }
  }
  return paths;
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
      // Variadic: skip all following non-flag values.
      while (i + 1 < (args?.length ?? 0) && !(args?.[i + 1] ?? "").startsWith("-")) {
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
