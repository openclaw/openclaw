import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { nowISO, uuid } from "../date-utils.js";
import type { HealthStore } from "../store.js";

const ACTIVITY_CATEGORIES = [
  "ice_bath",
  "supplement",
  "coffee",
  "sauna",
  "meditation",
  "stretching",
  "workout",
  "sleep",
  "other",
] as const;

const LogActivitySchema = Type.Object({
  category: Type.Unsafe<(typeof ACTIVITY_CATEGORIES)[number]>({
    type: "string",
    enum: [...ACTIVITY_CATEGORIES],
    description: "Activity category",
  }),
  description: Type.String({
    description: "Description of the activity (e.g., '3 min cold plunge at 39F', '200mg caffeine')",
  }),
  duration: Type.Optional(
    Type.String({ description: "Duration of the activity (e.g., '3 min', '20 min')" }),
  ),
  details: Type.Optional(
    Type.Object(
      {},
      {
        additionalProperties: true,
        description: "Additional details as key-value pairs (e.g., temperature, dosage)",
      },
    ),
  ),
});

export function createLogActivityTool(store: HealthStore): AnyAgentTool {
  return {
    name: "health_log_activity",
    label: "Log Activity",
    description:
      "Log a health-related activity: ice baths, supplements, coffee/caffeine, " +
      "sauna, meditation, stretching, workouts, sleep notes, or other activities.",
    parameters: LogActivitySchema,
    async execute(_toolCallId, params) {
      const entry = {
        id: uuid(),
        timestamp: nowISO(),
        category: params.category,
        description: params.description,
        duration: params.duration,
        details: params.details as Record<string, string | number> | undefined,
      };
      await store.addActivityLogEntry(entry);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "activity_logged",
                entry,
              },
              null,
              2,
            ),
          },
        ],
        details: entry,
      };
    },
  } as AnyAgentTool;
}
