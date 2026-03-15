import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { nowISO } from "../date-utils.js";
import type { HealthStore } from "../store.js";

const SetTargetsSchema = Type.Object({
  calories: Type.Number({ description: "Daily calorie target" }),
  proteinG: Type.Number({ description: "Daily protein target in grams" }),
  carbsG: Type.Number({ description: "Daily carbohydrate target in grams" }),
  fatG: Type.Number({ description: "Daily fat target in grams" }),
  fiberG: Type.Optional(Type.Number({ description: "Daily fiber target in grams" })),
});

export function createSetTargetsTool(store: HealthStore): AnyAgentTool {
  return {
    name: "health_set_targets",
    label: "Set Macro Targets",
    description:
      "Set daily macro nutrient targets (calories, protein, carbs, fat). " +
      "These targets are used to track remaining macros throughout the day.",
    parameters: SetTargetsSchema,
    async execute(_toolCallId, params) {
      const targets = {
        calories: params.calories,
        proteinG: params.proteinG,
        carbsG: params.carbsG,
        fatG: params.fatG,
        fiberG: params.fiberG,
        updatedAt: nowISO(),
      };
      await store.setTargets(targets);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "targets_set",
                targets,
              },
              null,
              2,
            ),
          },
        ],
        details: targets,
      };
    },
  } as AnyAgentTool;
}
