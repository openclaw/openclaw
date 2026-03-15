import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { toDateString } from "../date-utils.js";
import type { HealthStore } from "../store.js";
import type { MacroNutrients } from "../types.js";

const MacroStatusSchema = Type.Object({
  date: Type.Optional(
    Type.String({ description: "Date in YYYY-MM-DD format. Defaults to today." }),
  ),
});

function sumMacros(entries: { macros: MacroNutrients }[]): MacroNutrients {
  const result: MacroNutrients = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
  for (const e of entries) {
    result.calories += e.macros.calories;
    result.proteinG += e.macros.proteinG;
    result.carbsG += e.macros.carbsG;
    result.fatG += e.macros.fatG;
    if (e.macros.fiberG != null) result.fiberG = (result.fiberG ?? 0) + e.macros.fiberG;
    if (e.macros.sugarG != null) result.sugarG = (result.sugarG ?? 0) + e.macros.sugarG;
    if (e.macros.sodiumMg != null) result.sodiumMg = (result.sodiumMg ?? 0) + e.macros.sodiumMg;
  }
  return result;
}

export function createMacroStatusTool(store: HealthStore): AnyAgentTool {
  return {
    name: "health_macro_status",
    label: "Macro Status",
    description:
      "Get current daily macro nutrient status: consumed, remaining, and percentage toward targets. " +
      "Shows a breakdown by meal slot.",
    parameters: MacroStatusSchema,
    async execute(_toolCallId, params) {
      const date = params.date ?? toDateString();
      const foodLog = await store.getFoodLog(date);
      const consumed = sumMacros(foodLog);
      const targets = await store.getTargets();

      // Group by meal
      const byMeal: Record<string, MacroNutrients> = {};
      for (const entry of foodLog) {
        if (!byMeal[entry.meal]) {
          byMeal[entry.meal] = { calories: 0, proteinG: 0, carbsG: 0, fatG: 0 };
        }
        const m = byMeal[entry.meal]!;
        m.calories += entry.macros.calories;
        m.proteinG += entry.macros.proteinG;
        m.carbsG += entry.macros.carbsG;
        m.fatG += entry.macros.fatG;
      }

      const result: Record<string, unknown> = {
        date,
        consumed,
        mealBreakdown: byMeal,
        totalEntries: foodLog.length,
      };

      if (targets) {
        result.targets = targets;
        result.remaining = {
          calories: Math.max(0, targets.calories - consumed.calories),
          proteinG: Math.max(0, targets.proteinG - consumed.proteinG),
          carbsG: Math.max(0, targets.carbsG - consumed.carbsG),
          fatG: Math.max(0, targets.fatG - consumed.fatG),
        };
        result.percentComplete = {
          calories:
            targets.calories > 0 ? Math.round((consumed.calories / targets.calories) * 100) : 0,
          protein:
            targets.proteinG > 0 ? Math.round((consumed.proteinG / targets.proteinG) * 100) : 0,
          carbs: targets.carbsG > 0 ? Math.round((consumed.carbsG / targets.carbsG) * 100) : 0,
          fat: targets.fatG > 0 ? Math.round((consumed.fatG / targets.fatG) * 100) : 0,
        };
      } else {
        result.note = "No daily macro targets set. Use health_set_targets to set them.";
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  } as AnyAgentTool;
}
