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
    }>;
    recipes: Record<string, string>;
  }>;
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
  const lines: string[] = [
    "## Connected App Tools (via Composio MCP)",
    "",
    "You have MCP tools available for these connected apps. Call them directly — do **not** use curl or manual HTTP to Composio or the gateway for these integrations.",
    "",
  ];

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
      lines.push("**More intents (tool may be outside top list; still available via MCP):**");
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

/**
 * Loads and formats the cheat sheet, or returns null if no index file / invalid JSON.
 */
export function loadComposioToolCheatSheetMarkdown(workspaceDir: string): string | null {
  const index = readComposioToolIndex(workspaceDir);
  if (!index || index.connected_apps.length === 0) {
    return null;
  }
  return formatComposioToolCheatSheetFromIndex(index);
}
