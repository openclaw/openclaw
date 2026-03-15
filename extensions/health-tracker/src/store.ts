import path from "node:path";
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk/health-tracker";
import { toDateString } from "./date-utils.js";
import type {
  ActivityLogEntry,
  FoodDatabase,
  FoodLogEntry,
  MacroTargets,
  WeightEntry,
} from "./types.js";

export class HealthStore {
  constructor(private readonly baseDir: string) {}

  // --- paths ---

  private foodDbPath(): string {
    return path.join(this.baseDir, "food-db.json");
  }

  private targetsPath(): string {
    return path.join(this.baseDir, "targets.json");
  }

  private weightPath(): string {
    return path.join(this.baseDir, "weight.json");
  }

  private foodLogPath(date: string): string {
    return path.join(this.baseDir, "logs", `food-${date}.json`);
  }

  private activityLogPath(date: string): string {
    return path.join(this.baseDir, "logs", `activity-${date}.json`);
  }

  // --- food database ---

  async getFoodDb(): Promise<FoodDatabase> {
    const { value } = await readJsonFileWithFallback<FoodDatabase>(this.foodDbPath(), {
      foods: [],
    });
    return value;
  }

  async saveFoodDb(db: FoodDatabase): Promise<void> {
    await writeJsonFileAtomically(this.foodDbPath(), db);
  }

  async findFood(query: string): Promise<FoodDatabase["foods"]> {
    const db = await this.getFoodDb();
    const q = query.toLowerCase();
    return db.foods.filter(
      (f) => f.name.toLowerCase().includes(q) || (f.brand && f.brand.toLowerCase().includes(q)),
    );
  }

  async addFood(entry: FoodDatabase["foods"][number]): Promise<void> {
    const db = await this.getFoodDb();
    const existing = db.foods.findIndex((f) => f.id === entry.id);
    if (existing >= 0) {
      db.foods[existing] = entry;
    } else {
      db.foods.push(entry);
    }
    await this.saveFoodDb(db);
  }

  async incrementFoodUsage(foodId: string): Promise<void> {
    const db = await this.getFoodDb();
    const food = db.foods.find((f) => f.id === foodId);
    if (food) {
      food.timesLogged++;
      await this.saveFoodDb(db);
    }
  }

  // --- food log ---

  async getFoodLog(date?: string): Promise<FoodLogEntry[]> {
    const d = date ?? toDateString();
    const { value } = await readJsonFileWithFallback<FoodLogEntry[]>(this.foodLogPath(d), []);
    return value;
  }

  async addFoodLogEntry(entry: FoodLogEntry): Promise<void> {
    const date = entry.timestamp.slice(0, 10);
    const log = await this.getFoodLog(date);
    log.push(entry);
    await writeJsonFileAtomically(this.foodLogPath(date), log);
  }

  // --- activity log ---

  async getActivityLog(date?: string): Promise<ActivityLogEntry[]> {
    const d = date ?? toDateString();
    const { value } = await readJsonFileWithFallback<ActivityLogEntry[]>(
      this.activityLogPath(d),
      [],
    );
    return value;
  }

  async addActivityLogEntry(entry: ActivityLogEntry): Promise<void> {
    const date = entry.timestamp.slice(0, 10);
    const log = await this.getActivityLog(date);
    log.push(entry);
    await writeJsonFileAtomically(this.activityLogPath(date), log);
  }

  // --- targets ---

  async getTargets(): Promise<MacroTargets | null> {
    const { value, exists } = await readJsonFileWithFallback<MacroTargets | null>(
      this.targetsPath(),
      null,
    );
    return exists ? value : null;
  }

  async setTargets(targets: MacroTargets): Promise<void> {
    await writeJsonFileAtomically(this.targetsPath(), targets);
  }

  // --- weight ---

  async getWeightHistory(): Promise<WeightEntry[]> {
    const { value } = await readJsonFileWithFallback<WeightEntry[]>(this.weightPath(), []);
    return value;
  }

  async addWeight(entry: WeightEntry): Promise<void> {
    const history = await this.getWeightHistory();
    // Replace if same date exists
    const idx = history.findIndex((w) => w.date === entry.date);
    if (idx >= 0) {
      history[idx] = entry;
    } else {
      history.push(entry);
      history.sort((a, b) => a.date.localeCompare(b.date));
    }
    await writeJsonFileAtomically(this.weightPath(), history);
  }

  async getLatestWeight(): Promise<WeightEntry | null> {
    const history = await this.getWeightHistory();
    return history.length > 0 ? history[history.length - 1]! : null;
  }

  async getWeightForDate(date: string): Promise<WeightEntry | null> {
    const history = await this.getWeightHistory();
    return history.find((w) => w.date === date) ?? null;
  }
}
