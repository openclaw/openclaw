export type MacroNutrients = {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG?: number;
  sugarG?: number;
  saturatedFatG?: number;
  sodiumMg?: number;
  cholesterolMg?: number;
};

export type MicroNutrients = {
  vitaminAPercent?: number;
  vitaminCPercent?: number;
  calciumPercent?: number;
  ironPercent?: number;
  potassiumMg?: number;
};

export type FoodEntry = {
  id: string;
  name: string;
  brand?: string;
  servingSize: string;
  servingGrams?: number;
  macros: MacroNutrients;
  micronutrients?: MicroNutrients;
  source: "manual" | "usda" | "openfoodfacts" | "mfp_import" | "photo";
  usdaFdcId?: number;
  createdAt: string;
  timesLogged: number;
};

export type MealSlot = "breakfast" | "lunch" | "dinner" | "snack" | "pre_workout" | "post_workout";

export type FoodLogEntry = {
  id: string;
  timestamp: string;
  meal: MealSlot;
  foodId?: string;
  foodName: string;
  servings: number;
  macros: MacroNutrients;
  notes?: string;
};

export type ActivityCategory =
  | "ice_bath"
  | "supplement"
  | "coffee"
  | "sauna"
  | "meditation"
  | "stretching"
  | "workout"
  | "sleep"
  | "other";

export type ActivityLogEntry = {
  id: string;
  timestamp: string;
  category: ActivityCategory;
  description: string;
  duration?: string;
  details?: Record<string, string | number>;
};

export type MacroTargets = {
  calories: number;
  proteinG: number;
  carbsG: number;
  fatG: number;
  fiberG?: number;
  updatedAt: string;
};

export type WeightEntry = {
  date: string;
  weightKg: number;
  timestamp: string;
};

export type DailySummary = {
  date: string;
  consumed: MacroNutrients;
  remaining: MacroNutrients;
  percentComplete: {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  };
  meals: FoodLogEntry[];
  activities: ActivityLogEntry[];
  weight?: WeightEntry;
  targets?: MacroTargets;
};

export type FoodDatabase = {
  foods: FoodEntry[];
};

export type MfpNutritionRow = {
  date: string;
  meal: string;
  calories: number;
  fatG: number;
  saturatedFatG: number;
  polyunsaturatedFatG: number;
  monounsaturatedFatG: number;
  transFatG: number;
  cholesterolMg: number;
  sodiumMg: number;
  potassiumMg: number;
  carbsG: number;
  fiberG: number;
  sugarG: number;
  proteinG: number;
  vitaminAPercent: number;
  vitaminCPercent: number;
  calciumPercent: number;
  ironPercent: number;
  note: string;
};

export type MfpExerciseRow = {
  date: string;
  exercise: string;
  type: string;
  calories: number;
  minutes: number;
  sets?: number;
  repsPerSet?: number;
  kilograms?: number;
  steps?: number;
  note: string;
};
