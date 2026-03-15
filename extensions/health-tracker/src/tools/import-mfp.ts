import fs from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/health-tracker";
import { nowISO, uuid } from "../date-utils.js";
import type { HealthStore } from "../store.js";
import type { FoodLogEntry, MealSlot } from "../types.js";

const ImportMfpSchema = Type.Object({
  directoryPath: Type.String({
    description:
      "Path to the MyFitnessPal export directory containing CSV files " +
      "(Nutrition-Summary, Exercise-Summary, Measurement-Summary)",
  }),
});

/** Clean UTF-8 encoding artifacts from MFP CSV data. */
function cleanMfpText(text: string): string {
  return text.replace(/\xC2/g, "").trim();
}

/** Map MFP meal names to our meal slots. */
function normalizeMealSlot(raw: string): MealSlot {
  const cleaned = cleanMfpText(raw).toLowerCase();
  if (cleaned.includes("pre") && cleaned.includes("workout")) return "pre_workout";
  if (cleaned.includes("post") && cleaned.includes("workout")) return "post_workout";
  if (cleaned.includes("breakfast")) return "breakfast";
  if (cleaned.includes("lunch")) return "lunch";
  if (cleaned.includes("dinner")) return "dinner";
  if (cleaned.includes("snack")) return "snack";
  // MFP uses "Meal 1", "Meal 2", etc.
  if (cleaned.includes("meal 1")) return "breakfast";
  if (cleaned.includes("meal 2")) return "lunch";
  if (cleaned.includes("meal 3")) return "dinner";
  return "snack";
}

function parseNumber(val: string): number {
  const n = Number.parseFloat(val);
  return Number.isFinite(n) ? n : 0;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

export function createImportMfpTool(store: HealthStore, baseDir: string): AnyAgentTool {
  return {
    name: "health_import_mfp",
    label: "Import MyFitnessPal",
    description:
      "Import MyFitnessPal CSV export data (nutrition, exercise, and weight measurements). " +
      "Provide the path to the export directory.",
    parameters: ImportMfpSchema,
    async execute(_toolCallId, params) {
      const dir = params.directoryPath;
      const summary = {
        nutritionRows: 0,
        exerciseRows: 0,
        weightEntries: 0,
        dateRange: { from: "", to: "" },
        foodLogEntries: 0,
      };

      // Find CSV files
      const files = await fs.promises.readdir(dir);
      const nutritionFile = files.find((f) => f.startsWith("Nutrition-Summary"));
      const exerciseFile = files.find((f) => f.startsWith("Exercise-Summary"));
      const measurementFile = files.find((f) => f.startsWith("Measurement-Summary"));

      const importDir = path.join(baseDir, "import");

      // --- Import Nutrition ---
      if (nutritionFile) {
        const raw = await fs.promises.readFile(path.join(dir, nutritionFile), "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        // Skip header
        const dataLines = lines.slice(1);
        const nutritionData: Record<string, unknown>[] = [];
        const allDates = new Set<string>();

        for (const line of dataLines) {
          const cols = parseCsvLine(line);
          if (cols.length < 15) continue;

          const date = cols[0]!.trim();
          const meal = cols[1]!;
          allDates.add(date);

          const row = {
            date,
            meal: cleanMfpText(meal),
            calories: parseNumber(cols[2]!),
            fatG: parseNumber(cols[3]!),
            saturatedFatG: parseNumber(cols[4]!),
            polyunsaturatedFatG: parseNumber(cols[5]!),
            monounsaturatedFatG: parseNumber(cols[6]!),
            transFatG: parseNumber(cols[7]!),
            cholesterolMg: parseNumber(cols[8]!),
            sodiumMg: parseNumber(cols[9]!),
            potassiumMg: parseNumber(cols[10]!),
            carbsG: parseNumber(cols[11]!),
            fiberG: parseNumber(cols[12]!),
            sugarG: parseNumber(cols[13]!),
            proteinG: parseNumber(cols[14]!),
            vitaminAPercent: parseNumber(cols[15] ?? "0"),
            vitaminCPercent: parseNumber(cols[16] ?? "0"),
            calciumPercent: parseNumber(cols[17] ?? "0"),
            ironPercent: parseNumber(cols[18] ?? "0"),
            note: cols[19]?.trim() ?? "",
          };

          nutritionData.push(row);
          summary.nutritionRows++;

          // Also create a food log entry
          const mealSlot = normalizeMealSlot(meal);
          // Filter out obviously anomalous entries (e.g., 9857+ cal single meals from butter entries)
          if (row.calories > 5000) continue;

          const logEntry: FoodLogEntry = {
            id: uuid(),
            timestamp: `${date}T12:00:00.000Z`,
            meal: mealSlot,
            foodName: `MFP ${cleanMfpText(meal)} - ${date}`,
            servings: 1,
            macros: {
              calories: row.calories,
              proteinG: row.proteinG,
              carbsG: row.carbsG,
              fatG: row.fatG,
              fiberG: row.fiberG || undefined,
              sugarG: row.sugarG || undefined,
              saturatedFatG: row.saturatedFatG || undefined,
              sodiumMg: row.sodiumMg || undefined,
              cholesterolMg: row.cholesterolMg || undefined,
            },
          };
          await store.addFoodLogEntry(logEntry);
          summary.foodLogEntries++;
        }

        const sortedDates = [...allDates].sort();
        if (sortedDates.length > 0) {
          summary.dateRange.from = sortedDates[0]!;
          summary.dateRange.to = sortedDates[sortedDates.length - 1]!;
        }

        await writeJsonFileAtomically(path.join(importDir, "mfp-nutrition.json"), nutritionData);
      }

      // --- Import Exercise ---
      if (exerciseFile) {
        const raw = await fs.promises.readFile(path.join(dir, exerciseFile), "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        const dataLines = lines.slice(1);
        const exerciseData: Record<string, unknown>[] = [];

        for (const line of dataLines) {
          const cols = parseCsvLine(line);
          if (cols.length < 5) continue;

          exerciseData.push({
            date: cols[0]!.trim(),
            exercise: cleanMfpText(cols[1]!),
            type: cols[2]!.trim(),
            calories: parseNumber(cols[3]!),
            minutes: parseNumber(cols[4]!),
            sets: cols[5] ? parseNumber(cols[5]) || undefined : undefined,
            repsPerSet: cols[6] ? parseNumber(cols[6]) || undefined : undefined,
            kilograms: cols[7] ? parseNumber(cols[7]) || undefined : undefined,
            steps: cols[8] ? parseNumber(cols[8]) || undefined : undefined,
            note: cols[9]?.trim() ?? "",
          });
          summary.exerciseRows++;
        }

        await writeJsonFileAtomically(path.join(importDir, "mfp-exercise.json"), exerciseData);
      }

      // --- Import Weight Measurements ---
      if (measurementFile) {
        const raw = await fs.promises.readFile(path.join(dir, measurementFile), "utf-8");
        const lines = raw.split("\n").filter((l) => l.trim());
        const dataLines = lines.slice(1);

        for (const line of dataLines) {
          const cols = parseCsvLine(line);
          if (cols.length < 2) continue;

          const date = cols[0]!.trim();
          const weightKg = parseNumber(cols[1]!);
          if (weightKg > 0) {
            await store.addWeight({
              date,
              weightKg,
              timestamp: nowISO(),
            });
            summary.weightEntries++;
          }
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                status: "import_complete",
                summary,
                filesProcessed: {
                  nutrition: !!nutritionFile,
                  exercise: !!exerciseFile,
                  measurements: !!measurementFile,
                },
              },
              null,
              2,
            ),
          },
        ],
        details: summary,
      };
    },
  } as AnyAgentTool;
}
