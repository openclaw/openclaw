import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Shape written by `apps/web/lib/composio-tool-index.ts` to
 * `<workspace>/composio-tool-index.json`. Kept in the extension package so the
 * agent runtime can format the cheat sheet without importing the Next app.
 */
export type ComposioToolIndexFile = {
  generated_at: string;
  connected_apps: Array<{
    toolkit_slug: string;
    toolkit_name: string;
    account_count: number;
    tools: Array<{
      name: string;
      title: string;
      description_short: string;
      required_args: string[];
      arg_hints: Record<string, string>;
      default_args?: Record<string, unknown>;
      example_args?: Record<string, unknown>;
      example_prompts?: string[];
      input_schema?: Record<string, unknown>;
    }>;
    recipes: Record<string, string>;
  }>;
};

type ComposioMcpStatusFile = {
  summary?: {
    verified?: boolean;
    message?: string;
  };
  config?: {
    status?: "pass" | "fail" | "unknown";
  };
  gatewayTools?: {
    status?: "pass" | "fail" | "unknown";
  };
  liveAgent?: {
    status?: "pass" | "fail" | "unknown";
  };
};

function isComposioToolIndexFile(value: unknown): value is ComposioToolIndexFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.generated_at !== "string" || !Array.isArray(rec.connected_apps)) {
    return false;
  }
  return true;
}

/**
 * Build markdown for the identity system prompt from a parsed index file.
 */
export function formatComposioToolCheatSheetFromIndex(index: ComposioToolIndexFile): string {
  return formatComposioToolCheatSheet(index, null);
}

function formatComposioToolCheatSheet(
  index: ComposioToolIndexFile,
  status: ComposioMcpStatusFile | null,
): string {
  const verified = status?.summary?.verified === true;
  const summaryMessage = typeof status?.summary?.message === "string" ? status.summary.message : null;
  const lines: string[] = [
    "## Connected App Tools (via Composio MCP)",
    "",
    verified
      ? "You have verified MCP tools available for these connected apps. Call them directly."
      : "Composio MCP is the configured integration layer for these connected apps. If the MCP tools are missing in this session, stop and report the Composio MCP repair status instead of bypassing it.",
    "",
    "- Use `composio_resolve_tool` first when the exact Composio tool name or argument shape is not already obvious.",
    "- Never use `gog`, shell CLIs, curl, or raw `/v1/composio/*` HTTP as a fallback for these connected apps.",
    "- If a Composio tool fails because of argument shape, fix the JSON arguments and retry once.",
    "",
  ];
  if (summaryMessage) {
    lines.push(`Current verification status: ${summaryMessage}`, "");
  }

  for (const app of index.connected_apps) {
    const title =
      app.account_count > 1
        ? `### ${app.toolkit_name} (${app.account_count} accounts connected)`
        : `### ${app.toolkit_name} (1 account connected)`;
    lines.push(title, "");
    lines.push("| Intent | Tool | Key args |");
    lines.push("|--------|------|----------|");

    const recipeByTool = Object.fromEntries(
      Object.entries(app.recipes).map(([intent, tool]) => [tool, intent]),
    );

    for (const tool of app.tools) {
      const intent = recipeByTool[tool.name] ?? "—";
      const keyParts: string[] = [];
      for (const a of tool.required_args.slice(0, 4)) {
        keyParts.push(a);
      }
      const hintSample = Object.entries(tool.arg_hints).slice(0, 2);
      for (const [k, v] of hintSample) {
        keyParts.push(`${k}: ${v}`);
      }
      if (tool.default_args && Object.keys(tool.default_args).length > 0) {
        keyParts.push(`defaults: ${JSON.stringify(tool.default_args)}`);
      }
      const keyArgs = keyParts.length ? keyParts.join("; ") : "—";
      lines.push(`| ${intent} | \`${tool.name}\` | ${keyArgs} |`);
    }

    const gotchas = Object.entries(
      app.tools.reduce<Record<string, string>>((acc, t) => {
        for (const [k, v] of Object.entries(t.arg_hints)) {
          if (!acc[k]) {
            acc[k] = v;
          }
        }
        return acc;
      }, {}),
    );
    if (gotchas.length > 0) {
      lines.push("");
      lines.push(
        "**Known gotchas:**",
        ...gotchas.map(([k, v]) => `- \`${k}\`: ${v}`),
      );
    }

    const extraRecipes = Object.entries(app.recipes).filter(
      ([, toolName]) => !app.tools.some((t) => t.name === toolName),
    );
    if (extraRecipes.length > 0) {
      lines.push("");
      lines.push("**More intents (tool may be outside the curated direct-tool list):**");
      for (const [intent, toolName] of extraRecipes) {
        lines.push(`- ${intent}: \`${toolName}\``);
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function readComposioToolIndex(workspaceDir: string): ComposioToolIndexFile | null {
  const filePath = path.join(workspaceDir, "composio-tool-index.json");
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    return isComposioToolIndexFile(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function readComposioToolIndexFile(workspaceDir: string): ComposioToolIndexFile | null {
  return readComposioToolIndex(workspaceDir);
}

function readComposioMcpStatus(workspaceDir: string): ComposioMcpStatusFile | null {
  const filePath = path.join(workspaceDir, "composio-mcp-status.json");
  if (!existsSync(filePath)) {
    return null;
  }
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as ComposioMcpStatusFile;
    }
    return null;
  } catch {
    return null;
  }
}

export function readComposioMcpStatusFile(workspaceDir: string): ComposioMcpStatusFile | null {
  return readComposioMcpStatus(workspaceDir);
}

/**
 * Loads and formats the cheat sheet, or returns null if no index file / invalid JSON.
 */
export function loadComposioToolCheatSheetMarkdown(workspaceDir: string): string | null {
  const index = readComposioToolIndex(workspaceDir);
  if (!index || index.connected_apps.length === 0) {
    return null;
  }
  return formatComposioToolCheatSheet(index, readComposioMcpStatus(workspaceDir));
}
