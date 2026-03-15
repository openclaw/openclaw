import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { toDateString } from "../date-utils.js";
import type { HealthStore } from "../store.js";
import type { DailySummary, MacroNutrients } from "../types.js";

const DailySummarySchema = Type.Object({
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

export function createDailySummaryTool(store: HealthStore): AnyAgentTool {
  return {
    name: "health_daily_summary",
    label: "Daily Summary",
    description:
      "Get a comprehensive daily health summary including all meals, activities, " +
      "macro progress, weight, and timing data. Use this for daily coaching and optimization advice.",
    parameters: DailySummarySchema,
    async execute(_toolCallId, params) {
      const date = params.date ?? toDateString();
      const meals = await store.getFoodLog(date);
      const activities = await store.getActivityLog(date);
      const targets = await store.getTargets();
      const weight = await store.getWeightForDate(date);
      const latestWeight = await store.getLatestWeight();
      const consumed = sumMacros(meals);

      const summary: DailySummary = {
        date,
        consumed,
        remaining: {
          calories: targets ? Math.max(0, targets.calories - consumed.calories) : 0,
          proteinG: targets ? Math.max(0, targets.proteinG - consumed.proteinG) : 0,
          carbsG: targets ? Math.max(0, targets.carbsG - consumed.carbsG) : 0,
          fatG: targets ? Math.max(0, targets.fatG - consumed.fatG) : 0,
        },
        percentComplete: {
          calories:
            targets && targets.calories > 0
              ? Math.round((consumed.calories / targets.calories) * 100)
              : 0,
          protein:
            targets && targets.proteinG > 0
              ? Math.round((consumed.proteinG / targets.proteinG) * 100)
              : 0,
          carbs:
            targets && targets.carbsG > 0
              ? Math.round((consumed.carbsG / targets.carbsG) * 100)
              : 0,
          fat: targets && targets.fatG > 0 ? Math.round((consumed.fatG / targets.fatG) * 100) : 0,
        },
        meals,
        activities,
        weight: weight ?? undefined,
        targets: targets ?? undefined,
      };

      // Meal timing analysis
      const mealTimes = meals
        .map((m) => ({ meal: m.meal, time: m.timestamp, food: m.foodName }))
        .sort((a, b) => a.time.localeCompare(b.time));

      // Activity highlights
      const coffeeEntries = activities.filter((a) => a.category === "coffee");
      const lateCoffee = coffeeEntries.filter((a) => {
        const hour = new Date(a.timestamp).getHours();
        return hour >= 14;
      });

      const result: Record<string, unknown> = {
        summary,
        mealTimeline: mealTimes,
        latestWeight: latestWeight ?? undefined,
        insights: {
          totalMeals: meals.length,
          totalActivities: activities.length,
          hasLateCoffee: lateCoffee.length > 0,
          lateCoffeeCount: lateCoffee.length,
        },
      };

      if (!targets) {
        result.warning = "No daily macro targets set. Use health_set_targets to set them.";
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  } as AnyAgentTool;
}
