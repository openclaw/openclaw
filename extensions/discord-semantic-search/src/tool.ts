import { z } from "zod";
import type { DiscordSemanticSearch, SemanticSearchResult } from "./semantic-search.js";

const DiscordSemanticSearchSchema = z.object({
  query: z.string().describe("Semantic search query"),
  channelIds: z.array(z.string()).optional().describe("Filter by channel IDs"),
  authorIds: z.array(z.string()).optional().describe("Filter by author IDs"),
  limit: z.number().optional().default(10).describe("Maximum results to return"),
  minSimilarity: z.number().optional().default(0.7).describe("Minimum similarity score (0-1)"),
});

export function createDiscordSemanticSearchTool(search: DiscordSemanticSearch) {
  return {
    name: "discord_search",
    description:
      "Search Discord message history using semantic similarity. " +
      "Use this to find past conversations, discussions, or context from Discord channels. " +
      "Returns messages ranked by relevance with similarity scores.",
    inputSchema: DiscordSemanticSearchSchema,
    async execute(input: z.infer<typeof DiscordSemanticSearchSchema>) {
      const results = await search.search({
        query: input.query,
        channelIds: input.channelIds,
        authorIds: input.authorIds,
        limit: input.limit,
        minSimilarity: input.minSimilarity,
      });

      if (results.length === 0) {
        return { content: "No matching messages found." };
      }

      const formatted = results.map((r: SemanticSearchResult, i: number) => {
        const { message, similarity } = r;
        return [
          `[${i + 1}] Score: ${(similarity * 100).toFixed(1)}%`,
          `Channel: ${message.channelId}`,
          `Author: ${message.authorId}`,
          `Time: ${message.timestamp}`,
          `Content: ${message.content}`,
          `Link: ${message.messageUrl}`,
          "",
        ].join("\n");
      });

      return {
        content: `Found ${results.length} matching messages:\n\n${formatted.join("\n")}`,
      };
    },
  };
}
