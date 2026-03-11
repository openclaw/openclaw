/**
 * Memory Hierarchy Tools — R2: Hierarchical Memory Index
 *
 * Builds and searches time-hierarchy summaries over daily logs:
 * weekly digests, monthly themes, quarterly reviews.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import type { OpenClawPluginApi, AnyAgentTool } from "openclaw/plugin-sdk";
import { textResult, resolveWorkspaceDir } from "./common.js";
import {
  materializeWeeklySummary,
  materializeMonthlySummary,
  materializeQuarterlyReview,
} from "./memory-materializer.js";

async function readMd(p: string): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    return await readFile(p, "utf-8");
  } catch {
    return "";
  }
}

function getMonday(date: Date): Date {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d;
}

const MemoryBuildHierarchyParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  scope: Type.Optional(
    Type.Union(
      [Type.Literal("week"), Type.Literal("month"), Type.Literal("quarter"), Type.Literal("all")],
      { description: "Which hierarchy levels to build (default: all)" },
    ),
  ),
  since: Type.Optional(Type.String({ description: "Start date (ISO format, e.g. 2026-01-01)" })),
});

const MemoryHierarchySearchParams = Type.Object({
  agent_id: Type.String({ description: "Agent ID" }),
  query: Type.String({ description: "Search query" }),
  level: Type.Union(
    [
      Type.Literal("daily"),
      Type.Literal("weekly"),
      Type.Literal("monthly"),
      Type.Literal("quarterly"),
    ],
    { description: "Hierarchy level to search" },
  ),
  limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
});

export function createMemoryHierarchyTools(api: OpenClawPluginApi): AnyAgentTool[] {
  return [
    {
      name: "memory_build_hierarchy",
      label: "Build Memory Hierarchy",
      description:
        "Build time-hierarchy summaries from daily memory logs. " +
        "Generates weekly digests, monthly themes, and quarterly reviews. " +
        "Can be scoped to a specific level or build all levels.",
      parameters: MemoryBuildHierarchyParams,
      async execute(_id: string, params: Static<typeof MemoryBuildHierarchyParams>) {
        const scope = params.scope || "all";
        const ws = resolveWorkspaceDir(api);
        const memoryDir = join(ws, "agents", params.agent_id, "memory");

        // Discover daily log files
        let dailyFiles: string[] = [];
        try {
          const files = await readdir(memoryDir);
          dailyFiles = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort();
        } catch {
          return textResult("No daily memory logs found.");
        }

        if (dailyFiles.length === 0) {
          return textResult("No daily memory logs found.");
        }

        // Filter by since date if provided
        if (params.since) {
          dailyFiles = dailyFiles.filter((f) => f.replace(".md", "") >= params.since!);
        }

        let weeksBuilt = 0;
        let monthsBuilt = 0;
        let quartersBuilt = 0;

        // Build weekly summaries
        if (scope === "week" || scope === "all") {
          const weekStarts = new Set<string>();
          for (const f of dailyFiles) {
            const date = new Date(f.replace(".md", ""));
            const monday = getMonday(date);
            weekStarts.add(monday.toISOString().split("T")[0]);
          }

          for (const weekStart of weekStarts) {
            try {
              await materializeWeeklySummary(api, params.agent_id, weekStart);
              weeksBuilt++;
            } catch {
              // Skip individual week errors
            }
          }
        }

        // Build monthly summaries
        if (scope === "month" || scope === "all") {
          const months = new Set<string>();
          for (const f of dailyFiles) {
            months.add(f.slice(0, 7)); // YYYY-MM
          }

          for (const month of months) {
            try {
              await materializeMonthlySummary(api, params.agent_id, month);
              monthsBuilt++;
            } catch {
              // Skip individual month errors
            }
          }
        }

        // Build quarterly reviews
        if (scope === "quarter" || scope === "all") {
          const quarters = new Set<string>();
          for (const f of dailyFiles) {
            const year = f.slice(0, 4);
            const month = parseInt(f.slice(5, 7), 10);
            const q = Math.floor((month - 1) / 3) + 1;
            quarters.add(`${year}-Q${q}`);
          }

          for (const quarter of quarters) {
            try {
              await materializeQuarterlyReview(api, params.agent_id, quarter);
              quartersBuilt++;
            } catch {
              // Skip individual quarter errors
            }
          }
        }

        return textResult(
          `## Memory Hierarchy Built — ${params.agent_id}\n\n` +
            `- Weekly summaries: ${weeksBuilt}\n` +
            `- Monthly summaries: ${monthsBuilt}\n` +
            `- Quarterly reviews: ${quartersBuilt}`,
        );
      },
    },

    {
      name: "memory_hierarchy_search",
      label: "Search Memory Hierarchy",
      description:
        "Search memory at a specific granularity level (daily, weekly, monthly, quarterly). " +
        "Useful for finding patterns across time periods.",
      parameters: MemoryHierarchySearchParams,
      async execute(_id: string, params: Static<typeof MemoryHierarchySearchParams>) {
        const ws = resolveWorkspaceDir(api);
        const memoryDir = join(ws, "agents", params.agent_id, "memory");
        const limit = params.limit || 10;
        const query = params.query.toLowerCase();

        let searchDir: string;
        switch (params.level) {
          case "daily":
            searchDir = memoryDir;
            break;
          case "weekly":
            searchDir = join(memoryDir, "weekly");
            break;
          case "monthly":
            searchDir = join(memoryDir, "monthly");
            break;
          case "quarterly":
            searchDir = join(memoryDir, "quarterly");
            break;
        }

        let files: string[] = [];
        try {
          const allFiles = await readdir(searchDir);
          files = allFiles
            .filter((f) => f.endsWith(".md"))
            .sort()
            .reverse();
        } catch {
          return textResult(`No ${params.level} summaries found.`);
        }

        const results: Array<{ file: string; snippet: string }> = [];

        for (const file of files) {
          if (results.length >= limit) break;
          const content = await readMd(join(searchDir, file));
          if (!content) continue;

          const lower = content.toLowerCase();
          const idx = lower.indexOf(query);
          if (idx === -1) continue;

          // Extract a snippet around the match
          const start = Math.max(0, idx - 80);
          const end = Math.min(content.length, idx + query.length + 120);
          const snippet =
            (start > 0 ? "..." : "") +
            content.slice(start, end).replace(/\n/g, " ").trim() +
            (end < content.length ? "..." : "");

          results.push({ file: file.replace(".md", ""), snippet });
        }

        if (results.length === 0) {
          return textResult(`No matches for "${params.query}" at ${params.level} level.`);
        }

        const output = results.map((r) => `- **${r.file}** — ${r.snippet}`).join("\n");

        return textResult(
          `## Hierarchy Search — ${params.level} level\n\n` +
            `Found ${results.length} matches:\n\n${output}`,
        );
      },
    },
  ];
}
