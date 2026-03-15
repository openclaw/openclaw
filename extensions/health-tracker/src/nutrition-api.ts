import type { MacroNutrients } from "./types.js";

export type NutritionSearchResult = {
  name: string;
  brand?: string;
  servingSize: string;
  macros: MacroNutrients;
  source: "usda" | "openfoodfacts";
  sourceId?: string;
};

// --- USDA FoodData Central (free, key required) ---

type UsdaFoodNutrient = {
  nutrientId: number;
  nutrientName: string;
  value: number;
  unitName: string;
};

type UsdaSearchFood = {
  fdcId: number;
  description: string;
  brandName?: string;
  brandOwner?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  foodNutrients: UsdaFoodNutrient[];
};

type UsdaSearchResponse = {
  foods: UsdaSearchFood[];
  totalHits: number;
};

// USDA nutrient IDs
const USDA_ENERGY = 1008; // kcal
const USDA_PROTEIN = 1003;
const USDA_FAT = 1004;
const USDA_CARBS = 1005;
const USDA_FIBER = 1079;
const USDA_SUGAR = 2000;
const USDA_SODIUM = 1093;
const USDA_SAT_FAT = 1258;
const USDA_CHOLESTEROL = 1253;

function extractUsdaNutrient(nutrients: UsdaFoodNutrient[], id: number): number {
  return nutrients.find((n) => n.nutrientId === id)?.value ?? 0;
}

export async function searchUsda(query: string, apiKey?: string): Promise<NutritionSearchResult[]> {
  const key = apiKey ?? process.env.USDA_API_KEY ?? "DEMO_KEY";
  const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
  url.searchParams.set("query", query);
  url.searchParams.set("api_key", key);
  url.searchParams.set("pageSize", "5");
  url.searchParams.set("dataType", "Foundation,SR Legacy,Branded");

  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    return [];
  }

  const data = (await resp.json()) as UsdaSearchResponse;
  return data.foods.map((f) => ({
    name: f.description,
    brand: f.brandName ?? f.brandOwner,
    servingSize: f.servingSize ? `${f.servingSize} ${f.servingSizeUnit ?? "g"}` : "100 g",
    macros: {
      calories: extractUsdaNutrient(f.foodNutrients, USDA_ENERGY),
      proteinG: extractUsdaNutrient(f.foodNutrients, USDA_PROTEIN),
      carbsG: extractUsdaNutrient(f.foodNutrients, USDA_CARBS),
      fatG: extractUsdaNutrient(f.foodNutrients, USDA_FAT),
      fiberG: extractUsdaNutrient(f.foodNutrients, USDA_FIBER) || undefined,
      sugarG: extractUsdaNutrient(f.foodNutrients, USDA_SUGAR) || undefined,
      sodiumMg: extractUsdaNutrient(f.foodNutrients, USDA_SODIUM) || undefined,
      saturatedFatG: extractUsdaNutrient(f.foodNutrients, USDA_SAT_FAT) || undefined,
      cholesterolMg: extractUsdaNutrient(f.foodNutrients, USDA_CHOLESTEROL) || undefined,
    },
    source: "usda" as const,
    sourceId: String(f.fdcId),
  }));
}

// --- OpenFoodFacts (free, no key) ---

type OffProduct = {
  product_name?: string;
  brands?: string;
  serving_size?: string;
  nutriments?: {
    "energy-kcal_100g"?: number;
    proteins_100g?: number;
    carbohydrates_100g?: number;
    fat_100g?: number;
    fiber_100g?: number;
    sugars_100g?: number;
    sodium_100g?: number;
    "saturated-fat_100g"?: number;
  };
};

type OffSearchResponse = {
  products: OffProduct[];
  count: number;
};

export async function searchOpenFoodFacts(query: string): Promise<NutritionSearchResult[]> {
  const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
  url.searchParams.set("search_terms", query);
  url.searchParams.set("search_simple", "1");
  url.searchParams.set("action", "process");
  url.searchParams.set("json", "1");
  url.searchParams.set("page_size", "5");

  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    return [];
  }

  const data = (await resp.json()) as OffSearchResponse;
  return data.products
    .filter((p) => p.product_name && p.nutriments)
    .map((p) => ({
      name: p.product_name!,
      brand: p.brands,
      servingSize: p.serving_size ?? "100 g",
      macros: {
        calories: p.nutriments!["energy-kcal_100g"] ?? 0,
        proteinG: p.nutriments!.proteins_100g ?? 0,
        carbsG: p.nutriments!.carbohydrates_100g ?? 0,
        fatG: p.nutriments!.fat_100g ?? 0,
        fiberG: p.nutriments!.fiber_100g || undefined,
        sugarG: p.nutriments!.sugars_100g || undefined,
        sodiumMg: p.nutriments!.sodium_100g != null ? p.nutriments!.sodium_100g * 1000 : undefined,
        saturatedFatG: p.nutriments!["saturated-fat_100g"] || undefined,
      },
      source: "openfoodfacts" as const,
    }));
}
