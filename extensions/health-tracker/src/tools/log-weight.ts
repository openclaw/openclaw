import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { nowISO, toDateString } from "../date-utils.js";
import type { HealthStore } from "../store.js";

const LogWeightSchema = Type.Object({
  weightKg: Type.Number({ description: "Body weight in kilograms" }),
  date: Type.Optional(
    Type.String({ description: "Date in YYYY-MM-DD format. Defaults to today." }),
  ),
});

export function createLogWeightTool(store: HealthStore): AnyAgentTool {
  return {
    name: "health_log_weight",
    label: "Log Weight",
    description: "Log body weight measurement in kilograms.",
    parameters: LogWeightSchema,
    async execute(_toolCallId, params) {
      const date = params.date ?? toDateString();
      const entry = {
        date,
        weightKg: params.weightKg,
        timestamp: nowISO(),
      };
      await store.addWeight(entry);

      const history = await store.getWeightHistory();
      const recent = history.slice(-7);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "weight_logged",
                entry,
                recentHistory: recent,
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
