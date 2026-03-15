import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { nowISO, toDateString, uuid } from "../date-utils.js";
import type { HealthStore } from "../store.js";
import type { MacroNutrients, MealSlot } from "../types.js";

const MEAL_SLOTS = [
  "breakfast",
  "lunch",
  "dinner",
  "snack",
  "pre_workout",
  "post_workout",
] as const;

const LogFoodSchema = Type.Object({
  foodName: Type.String({ description: "Name of the food item" }),
  meal: Type.Unsafe<MealSlot>({
    type: "string",
    enum: [...MEAL_SLOTS],
    description: "Meal slot for this food entry",
  }),
  servings: Type.Optional(
    Type.Number({ description: "Number of servings. Defaults to 1.", default: 1 }),
  ),
  calories: Type.Optional(Type.Number({ description: "Calories per serving" })),
  proteinG: Type.Optional(Type.Number({ description: "Protein in grams per serving" })),
  carbsG: Type.Optional(Type.Number({ description: "Carbohydrates in grams per serving" })),
  fatG: Type.Optional(Type.Number({ description: "Fat in grams per serving" })),
  fiberG: Type.Optional(Type.Number({ description: "Fiber in grams per serving" })),
  sugarG: Type.Optional(Type.Number({ description: "Sugar in grams per serving" })),
  sodiumMg: Type.Optional(Type.Number({ description: "Sodium in milligrams per serving" })),
  notes: Type.Optional(Type.String({ description: "Additional notes" })),
});

function computeRemainingMacros(
  targets: { calories: number; proteinG: number; carbsG: number; fatG: number; fiberG?: number },
  consumed: MacroNutrients,
): MacroNutrients {
  return {
    calories: Math.max(0, targets.calories - consumed.calories),
    proteinG: Math.max(0, targets.proteinG - consumed.proteinG),
    carbsG: Math.max(0, targets.carbsG - consumed.carbsG),
    fatG: Math.max(0, targets.fatG - consumed.fatG),
    fiberG:
      targets.fiberG != null ? Math.max(0, targets.fiberG - (consumed.fiberG ?? 0)) : undefined,
  };
}

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

export function createLogFoodTool(store: HealthStore): AnyAgentTool {
  return {
    name: "health_log_food",
    label: "Log Food",
    description:
      "Log a food entry with nutritional information. Provide macros directly " +
      "(from a nutrition label photo, restaurant info, or knowledge). " +
      "If macros are not provided, search the food database first with health_food_lookup. " +
      "After logging, returns remaining daily macros.",
    parameters: LogFoodSchema,
    async execute(_toolCallId, params) {
      const servings = params.servings ?? 1;
      const macros: MacroNutrients = {
        calories: (params.calories ?? 0) * servings,
        proteinG: (params.proteinG ?? 0) * servings,
        carbsG: (params.carbsG ?? 0) * servings,
        fatG: (params.fatG ?? 0) * servings,
        fiberG: params.fiberG != null ? params.fiberG * servings : undefined,
        sugarG: params.sugarG != null ? params.sugarG * servings : undefined,
        sodiumMg: params.sodiumMg != null ? params.sodiumMg * servings : undefined,
      };

      const entry = {
        id: uuid(),
        timestamp: nowISO(),
        meal: params.meal,
        foodName: params.foodName,
        servings,
        macros,
        notes: params.notes,
      };

      await store.addFoodLogEntry(entry);

      // Try to find or create food DB entry for future lookups
      const existing = await store.findFood(params.foodName);
      if (existing.length === 0 && params.calories != null) {
        await store.addFood({
          id: uuid(),
          name: params.foodName,
          servingSize: "1 serving",
          macros: {
            calories: params.calories ?? 0,
            proteinG: params.proteinG ?? 0,
            carbsG: params.carbsG ?? 0,
            fatG: params.fatG ?? 0,
            fiberG: params.fiberG,
            sugarG: params.sugarG,
            sodiumMg: params.sodiumMg,
          },
          source: "manual",
          createdAt: nowISO(),
          timesLogged: 1,
        });
      } else if (existing.length > 0 && existing[0]) {
        await store.incrementFoodUsage(existing[0].id);
      }

      // Compute daily totals and remaining
      const today = toDateString();
      const todayLog = await store.getFoodLog(today);
      const consumed = sumMacros(todayLog);
      const targets = await store.getTargets();

      const result: Record<string, unknown> = {
        status: "food_logged",
        entry,
        dailyTotals: consumed,
      };

      if (targets) {
        result.remaining = computeRemainingMacros(targets, consumed);
        result.targets = targets;
      } else {
        result.note = "No daily macro targets set. Use health_set_targets to set them.";
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: entry,
      };
    },
  } as AnyAgentTool;
}
