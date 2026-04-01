import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchComposioConnections,
  fetchComposioMcpToolsList,
  type ComposioMcpTool,
} from "@/lib/composio";
import {
  extractComposioConnections,
  normalizeComposioConnections,
  normalizeComposioToolkitSlug,
} from "@/lib/composio-client";

/** Mirrors `extensions/dench-identity/composio-cheat-sheet.ts`. */
export type ComposioToolIndex = {
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

const TOP_TOOLS_PER_APP = 10;

/** Intent label → canonical MCP tool name (must exist in catalog for that app). */
const RECIPES_BY_SLUG: Record<string, Record<string, string>> = {
  gmail: {
    "Read recent emails": "GMAIL_FETCH_EMAILS",
    "Read one email": "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
    "Send email": "GMAIL_SEND_EMAIL",
  },
  slack: {
    "Send message": "SLACK_SEND_MESSAGE",
    "List channels": "SLACK_LIST_CONVERSATIONS",
    "Post to channel": "SLACK_SEND_MESSAGE",
  },
  github: {
    "List repos": "GITHUB_LIST_REPOSITORIES_FOR_AUTHENTICATED_USER",
    "Get repo": "GITHUB_GET_A_REPOSITORY",
    "Create issue": "GITHUB_CREATE_AN_ISSUE",
  },
  notion: {
    "Search pages": "NOTION_SEARCH",
    "Create page": "NOTION_CREATE_PAGE",
    "Get page": "NOTION_GET_PAGE",
  },
  "google-calendar": {
    "List events": "GOOGLE_CALENDAR_EVENTS_LIST",
    "Create event": "GOOGLE_CALENDAR_CREATE_EVENT",
    "Get calendar list": "GOOGLE_CALENDAR_CALENDAR_LIST",
  },
  linear: {
    "List issues": "LINEAR_LIST_ISSUES",
    "Create issue": "LINEAR_CREATE_ISSUE",
    "Get issue": "LINEAR_GET_ISSUE",
  },
};

function toolkitSlugToToolPrefix(slug: string): string {
  return normalizeComposioToolkitSlug(slug).toUpperCase().replace(/-/g, "_") + "_";
}

function firstSentence(text: string): string {
  const t = text.trim();
  if (!t) {
    return "";
  }
  const parts = t.split(/(?<=[.!?])\s+/);
  const cut = parts[0];
  return cut ?? t.slice(0, 160);
}

function asObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function extractRequiredArgs(schema: ComposioMcpTool["inputSchema"]): string[] {
  if (!schema || schema.type !== "object" || !Array.isArray(schema.required)) {
    return [];
  }
  return schema.required.filter(
    (x): x is string => typeof x === "string" && x.trim().length > 0,
  );
}

function buildArgHints(toolName: string, schema: ComposioMcpTool["inputSchema"]): Record<string, string> {
  const hints: Record<string, string> = {};
  const props = schema && schema.type === "object" ? schema.properties : undefined;
  if (!props) {
    return hints;
  }

  const upper = toolName.toUpperCase();

  if (upper.includes("GMAIL") && props.label_ids) {
    hints.label_ids = 'Must be an array of label IDs, e.g. ["INBOX"] — not a string.';
  }
  if (upper.includes("GMAIL") && props.max_results) {
    hints.max_results = "Integer (e.g. 10).";
  }

  if (upper.includes("SLACK") && props.channel) {
    hints.channel = "Channel ID (starts with C) or name per tool docs.";
  }

  if (upper.includes("GOOGLE_CALENDAR") && props.time_min) {
    hints.time_min = "RFC3339 datetime string.";
  }

  for (const [key, val] of Object.entries(props)) {
    const p = asObjectRecord(val);
    if (!p) {
      continue;
    }
    if (p.type === "array" && !hints[key]) {
      hints[key] = "Must be a JSON array, not a comma-separated string.";
    }
  }

  return hints;
}

function toolSortKey(tool: ComposioMcpTool): [number, string] {
  const readOnly = tool.annotations?.readOnlyHint === true ? 0 : 1;
  return [readOnly, tool.name.toLowerCase()];
}

function buildRecipesForToolkit(
  slug: string,
  availableNames: Set<string>,
): Record<string, string> {
  const recipes = RECIPES_BY_SLUG[normalizeComposioToolkitSlug(slug)] ?? {};
  const out: Record<string, string> = {};
  for (const [intent, toolName] of Object.entries(recipes)) {
    if (availableNames.has(toolName)) {
      out[intent] = toolName;
    }
  }
  return out;
}

export type BuildComposioToolIndexParams = {
  workspaceDir: string;
  gatewayUrl: string;
  apiKey: string;
};

/**
 * Fetches active connections and MCP tools, builds a compact index, writes
 * `<workspaceDir>/composio-tool-index.json`, and returns the in-memory index.
 */
export async function buildComposioToolIndex(
  params: BuildComposioToolIndexParams,
): Promise<ComposioToolIndex> {
  const { workspaceDir, gatewayUrl, apiKey } = params;

  const [connectionsRes, allTools] = await Promise.all([
    fetchComposioConnections(gatewayUrl, apiKey),
    fetchComposioMcpToolsList(gatewayUrl, apiKey),
  ]);

  const connections = normalizeComposioConnections(extractComposioConnections(connectionsRes));
  const active = connections.filter((c) => c.is_active);
  const bySlug = new Map<string, { toolkit_name: string; accounts: Set<string> }>();

  for (const c of active) {
    const slug = c.normalized_toolkit_slug;
    const existing = bySlug.get(slug);
    if (existing) {
      existing.accounts.add(c.account_identity);
    } else {
      bySlug.set(slug, {
        toolkit_name: c.toolkit_name?.trim() || slug,
        accounts: new Set([c.account_identity]),
      });
    }
  }

  const connected_apps: ComposioToolIndex["connected_apps"] = [];

  for (const [slug, meta] of [...bySlug.entries()].toSorted((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const prefix = toolkitSlugToToolPrefix(slug);
    const forToolkit = allTools.filter((t) => t.name.startsWith(prefix));
    const availableNames = new Set(forToolkit.map((t) => t.name));

    const sorted = [...forToolkit].toSorted((a, b) => {
      const ka = toolSortKey(a);
      const kb = toolSortKey(b);
      if (ka[0] !== kb[0]) {
        return ka[0] - kb[0];
      }
      return ka[1].localeCompare(kb[1]);
    });

    const top = sorted.slice(0, TOP_TOOLS_PER_APP);
    const tools = top.map((tool) => {
      const schema = tool.inputSchema;
      const title =
        tool.title?.trim() ||
        tool.annotations?.title?.trim() ||
        tool.name.replace(/^([A-Z0-9]+_)+/i, "").replace(/_/g, " ") ||
        tool.name;
      const desc = tool.description?.trim() ?? "";
      return {
        name: tool.name,
        title,
        description_short: firstSentence(desc),
        required_args: extractRequiredArgs(schema),
        arg_hints: buildArgHints(tool.name, schema),
      };
    });

    connected_apps.push({
      toolkit_slug: slug,
      toolkit_name: meta.toolkit_name,
      account_count: meta.accounts.size,
      tools,
      recipes: buildRecipesForToolkit(slug, availableNames),
    });
  }

  const index: ComposioToolIndex = {
    generated_at: new Date().toISOString(),
    connected_apps,
  };

  const outPath = join(workspaceDir, "composio-tool-index.json");
  writeFileSync(outPath, JSON.stringify(index, null, 2) + "\n", "utf-8");

  return index;
}
