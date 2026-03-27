/**
 * GenPark Skill Marketplace Search Tool
 *
 * Provides a tool definition that the OpenClaw agent can use to search
 * GenPark's skill marketplace on behalf of the user.
 *
 * NOTE FOR GENPARK ENGINEERS:
 * The tool follows OpenClaw's tool registration patterns. When integrated
 * into the core, register it via `runtime.registerTool(marketplaceTool)`.
 */

import { getGenParkClient } from "./channel.ts";
import type { SkillSearchResult } from "./api-client.ts";

// ---------------------------------------------------------------------------
// Tool Definition
// ---------------------------------------------------------------------------

export const TOOL_NAME = "genpark_marketplace_search" as const;

export interface MarketplaceSearchParams {
  query: string;
  tags?: string[];
  limit?: number;
  page?: number;
}

export const marketplaceToolDefinition = {
  name: TOOL_NAME,
  description:
    "Search the GenPark Skill Marketplace for skills, plugins, and tools. " +
    "Returns a list of matching skills with descriptions, install commands, and metadata.",
  parameters: {
    type: "object" as const,
    properties: {
      query: {
        type: "string" as const,
        description:
          "Search query (skill name, keyword, or description fragment)",
      },
      tags: {
        type: "array" as const,
        items: { type: "string" as const },
        description:
          "Optional tags to filter results (e.g. ['productivity', 'ai', 'automation'])",
      },
      limit: {
        type: "number" as const,
        description: "Max results to return (default: 10, max: 50)",
      },
      page: {
        type: "number" as const,
        description: "Page number for pagination (default: 1)",
      },
    },
    required: ["query"] as const,
  },
};

// ---------------------------------------------------------------------------
// Tool Handler
// ---------------------------------------------------------------------------

/**
 * Execute a marketplace search and return formatted results.
 */
export async function handleMarketplaceSearch(
  params: MarketplaceSearchParams,
): Promise<string> {
  const client = getGenParkClient();
  if (!client) {
    return (
      "❌ GenPark is not configured. " +
      "Set `channels.genpark.genpark_api_token` in your openclaw.json to enable marketplace search."
    );
  }

  try {
    const results = await client.searchSkills(params.query, {
      page: params.page,
      limit: Math.min(params.limit ?? 10, 50),
      tags: params.tags,
    });

    if (results.length === 0) {
      return `No skills found for "${params.query}". Try broader search terms or different tags.`;
    }

    return formatSearchResults(results, params.query);
  } catch (err) {
    console.error("[GenPark Marketplace] Search failed:", err);
    return `⚠️ Marketplace search failed: ${err instanceof Error ? err.message : "Unknown error"}`;
  }
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSearchResults(
  results: SkillSearchResult[],
  query: string,
): string {
  const header = `## 🔍 GenPark Marketplace: "${query}"\n\nFound **${results.length}** skill(s):\n`;

  const rows = results.map((skill, i) => {
    const parts: string[] = [];
    parts.push(`### ${i + 1}. ${skill.name}`);
    parts.push(`> ${skill.description}`);

    const meta: string[] = [];
    if (skill.author) meta.push(`**Author:** ${skill.author}`);
    if (skill.version) meta.push(`**Version:** ${skill.version}`);
    if (skill.downloads !== undefined)
      meta.push(`**Downloads:** ${skill.downloads.toLocaleString()}`);
    if (skill.tags?.length) meta.push(`**Tags:** ${skill.tags.join(", ")}`);
    if (meta.length > 0) parts.push(meta.join(" · "));

    if (skill.installCommand) {
      parts.push(`\`\`\`bash\n${skill.installCommand}\n\`\`\``);
    }
    if (skill.url) {
      parts.push(`🔗 [View on GenPark](${skill.url})`);
    }

    return parts.join("\n");
  });

  return header + rows.join("\n\n---\n\n");
}
