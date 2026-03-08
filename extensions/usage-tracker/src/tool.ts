/**
 * Agent tool definition for in-conversation usage queries.
 */

import {
  queryUsage,
  querySkillHealth,
  queryStatus,
  querySkillSessions,
  type QueryParams,
} from "./query.js";
import type { UsageStorage, SkillSessionStorage } from "./storage.js";

const UsageTrackerToolSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["query", "skill_health", "skill_sessions", "status"],
      description:
        "Action: 'query' for tool/skill aggregation, 'skill_health' for per-skill read metrics, 'skill_sessions' for full skill lifecycle metrics (duration, tool chain), 'status' for overview.",
    },
    startDay: {
      type: "string" as const,
      description: "Start date (YYYY-MM-DD). Defaults to 30 days ago.",
    },
    endDay: {
      type: "string" as const,
      description: "End date (YYYY-MM-DD). Defaults to today.",
    },
    tool: {
      type: "string" as const,
      description: "Filter by tool name.",
    },
    skill: {
      type: "string" as const,
      description: "Filter by skill name.",
    },
    groupBy: {
      type: "string" as const,
      enum: ["tool", "skill", "day", "agent"],
      description: "Group results by dimension. Default: 'tool'.",
    },
  },
  required: ["action"] as string[],
};

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function createUsageTrackerTool(
  storage: UsageStorage,
  skillSessionStorage: SkillSessionStorage,
) {
  return {
    name: "usage_tracker",
    label: "Usage Tracker",
    description:
      "Query tool call and skill usage statistics. Use 'status' for overview, 'query' for aggregation, 'skill_health' for per-skill read metrics, 'skill_sessions' for full skill lifecycle analysis (duration, tool chains, completion patterns).",
    parameters: UsageTrackerToolSchema,
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = params.action as string;

      if (action === "status") {
        return jsonResult(await queryStatus(storage));
      }

      if (action === "skill_health") {
        return jsonResult(
          await querySkillHealth(storage, {
            startDay: params.startDay as string | undefined,
            endDay: params.endDay as string | undefined,
          }),
        );
      }

      if (action === "skill_sessions") {
        return jsonResult(await querySkillSessions(skillSessionStorage));
      }

      // Default: query
      const queryParams: QueryParams = {
        startDay: params.startDay as string | undefined,
        endDay: params.endDay as string | undefined,
        tool: params.tool as string | undefined,
        skill: params.skill as string | undefined,
        groupBy: params.groupBy as QueryParams["groupBy"],
      };
      return jsonResult(await queryUsage(storage, queryParams));
    },
  };
}
