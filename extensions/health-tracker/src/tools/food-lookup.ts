import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { searchOpenFoodFacts, searchUsda, type NutritionSearchResult } from "../nutrition-api.js";
import type { HealthStore } from "../store.js";

const SOURCES = ["local", "usda", "openfoodfacts", "all"] as const;

const FoodLookupSchema = Type.Object({
  query: Type.String({ description: "Food name or description to search for" }),
  source: Type.Optional(
    Type.Unsafe<(typeof SOURCES)[number]>({
      type: "string",
      enum: [...SOURCES],
      description:
        "Where to search. 'local' searches only the personal food database, " +
        "'usda' searches USDA FoodData Central, 'openfoodfacts' searches OpenFoodFacts, " +
        "'all' searches everywhere. Defaults to 'all'.",
    }),
  ),
});

export function createFoodLookupTool(store: HealthStore): AnyAgentTool {
  return {
    name: "health_food_lookup",
    label: "Food Lookup",
    description:
      "Search for food nutrition data across the personal food database, " +
      "USDA FoodData Central (free), and OpenFoodFacts (free). " +
      "Use this before health_log_food when you need to find nutrition data for a food item.",
    parameters: FoodLookupSchema,
    async execute(_toolCallId, params) {
      const source = params.source ?? "all";
      const results: Array<Omit<NutritionSearchResult, "source"> & { source: string }> = [];

      // Search local food database
      if (source === "local" || source === "all") {
        const localResults = await store.findFood(params.query);
        for (const food of localResults.slice(0, 5)) {
          results.push({
            name: food.name,
            brand: food.brand,
            servingSize: food.servingSize,
            macros: food.macros,
            source: "local",
            sourceId: food.id,
          });
        }
      }

      // Search USDA
      if (source === "usda" || source === "all") {
        try {
          const usdaResults = await searchUsda(params.query);
          results.push(...usdaResults);
        } catch {
          // USDA API unavailable, continue with other sources
        }
      }

      // Search OpenFoodFacts
      if (source === "openfoodfacts" || source === "all") {
        try {
          const offResults = await searchOpenFoodFacts(params.query);
          results.push(...offResults);
        } catch {
          // OpenFoodFacts unavailable, continue
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                query: params.query,
                resultCount: results.length,
                results: results.slice(0, 10),
                hint:
                  results.length > 0
                    ? "Pick the best match and use health_log_food with the macros to log it."
                    : "No results found. You can estimate the macros and log directly with health_log_food.",
              },
              null,
              2,
            ),
          },
        ],
        details: results,
      };
    },
  } as AnyAgentTool;
}
