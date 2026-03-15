import fs from "node:fs/promises";
import path from "node:path";
import {
  readJsonFileWithFallback,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk/health-tracker";
import { toDateString, uuid } from "./date-utils.js";
import type {
  Exercise,
  GarminDailyMetrics,
  HrvDayAnalysis,
  LoggedSet,
  Program,
  WorkoutSession,
} from "./workout-types.js";

export class WorkoutStore {
  constructor(private readonly baseDir: string) {}

  // --- paths ---

  private exercisesPath(): string {
    return path.join(this.baseDir, "exercises.json");
  }

  private aliasesPath(): string {
    return path.join(this.baseDir, "exercise-aliases.json");
  }

  private programsPath(): string {
    return path.join(this.baseDir, "programs.json");
  }

  private sessionsDir(): string {
    return path.join(this.baseDir, "sessions");
  }

  private sessionPath(date: string): string {
    return path.join(this.sessionsDir(), `${date}.json`);
  }

  private garminDailyPath(): string {
    return path.join(this.baseDir, "garmin-daily.json");
  }

  private hrvAnalysisPath(): string {
    return path.join(this.baseDir, "hrv-analysis.json");
  }

  // --- exercises ---

  async getExercises(): Promise<Exercise[]> {
    const { value } = await readJsonFileWithFallback<Exercise[]>(this.exercisesPath(), []);
    return value;
  }

  async getExercise(id: string): Promise<Exercise | null> {
    const exercises = await this.getExercises();
    return exercises.find((e) => e.id === id) ?? null;
  }

  async getOrCreateExercise(name: string, muscleGroup?: string, slot?: string): Promise<Exercise> {
    const exercises = await this.getExercises();
    const nameLower = name.toLowerCase();
    const existing = exercises.find((e) => e.canonicalName.toLowerCase() === nameLower);
    if (existing) return existing;

    const exercise: Exercise = {
      id: uuid(),
      canonicalName: name,
      muscleGroup,
      slot,
    };
    exercises.push(exercise);
    await writeJsonFileAtomically(this.exercisesPath(), exercises);
    return exercise;
  }

  async resolveExercise(rawName: string): Promise<Exercise> {
    // Check aliases first
    const { value: aliases } = await readJsonFileWithFallback<Record<string, string>>(
      this.aliasesPath(),
      {},
    );
    const aliasKey = rawName.toLowerCase();
    if (aliases[aliasKey]) {
      const exercise = await this.getExercise(aliases[aliasKey]!);
      if (exercise) return exercise;
    }

    // Check canonical name match (case-insensitive)
    const exercises = await this.getExercises();
    const nameLower = rawName.toLowerCase();
    const match = exercises.find((e) => e.canonicalName.toLowerCase() === nameLower);
    if (match) return match;

    // Create new
    return this.getOrCreateExercise(rawName);
  }

  async addAlias(alias: string, exerciseId: string): Promise<void> {
    const { value: aliases } = await readJsonFileWithFallback<Record<string, string>>(
      this.aliasesPath(),
      {},
    );
    aliases[alias.toLowerCase()] = exerciseId;
    await writeJsonFileAtomically(this.aliasesPath(), aliases);
  }

  // --- programs ---

  async getPrograms(): Promise<Program[]> {
    const { value } = await readJsonFileWithFallback<Program[]>(this.programsPath(), []);
    return value;
  }

  async getProgram(id: string): Promise<Program | null> {
    const programs = await this.getPrograms();
    return programs.find((p) => p.id === id) ?? null;
  }

  async saveProgram(program: Program): Promise<void> {
    const programs = await this.getPrograms();
    const idx = programs.findIndex((p) => p.id === program.id);
    if (idx >= 0) {
      programs[idx] = program;
    } else {
      programs.push(program);
    }
    await writeJsonFileAtomically(this.programsPath(), programs);
  }

  // --- sessions ---

  async getSessionsByDate(date: string): Promise<WorkoutSession[]> {
    const { value } = await readJsonFileWithFallback<WorkoutSession[]>(this.sessionPath(date), []);
    return value;
  }

  async getActiveSession(date: string): Promise<WorkoutSession | null> {
    const sessions = await this.getSessionsByDate(date);
    return sessions.find((s) => s.status === "in_progress") ?? null;
  }

  async saveSession(session: WorkoutSession): Promise<void> {
    const date = session.date;
    const sessions = await this.getSessionsByDate(date);
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    await writeJsonFileAtomically(this.sessionPath(date), sessions);
  }

  async getLastSessionWithProgram(): Promise<WorkoutSession | null> {
    const files = await this.listSessionFiles();
    // Files are sorted descending (most recent first)
    for (const file of files.slice(0, 30)) {
      const date = path.basename(file, ".json");
      const sessions = await this.getSessionsByDate(date);
      for (const session of sessions.reverse()) {
        if (session.programDayId) return session;
      }
    }
    return null;
  }

  // --- exercise history ---

  async getExerciseHistory(
    exerciseId: string,
    limit = 10,
  ): Promise<{ date: string; sets: LoggedSet[] }[]> {
    const files = await this.listSessionFiles();
    const results: { date: string; sets: LoggedSet[] }[] = [];

    for (const file of files) {
      if (results.length >= limit) break;
      const date = path.basename(file, ".json");
      const sessions = await this.getSessionsByDate(date);
      const matchingSets: LoggedSet[] = [];
      for (const session of sessions) {
        for (const set of session.sets) {
          if (set.exerciseId === exerciseId) {
            matchingSets.push(set);
          }
        }
      }
      if (matchingSets.length > 0) {
        results.push({ date, sets: matchingSets });
      }
    }

    return results;
  }

  // --- garmin ---

  private async getGarminAll(): Promise<Record<string, GarminDailyMetrics>> {
    const { value } = await readJsonFileWithFallback<Record<string, GarminDailyMetrics>>(
      this.garminDailyPath(),
      {},
    );
    return value;
  }

  async getGarminDaily(date: string): Promise<GarminDailyMetrics | null> {
    const all = await this.getGarminAll();
    return all[date] ?? null;
  }

  async saveGarminDaily(metrics: GarminDailyMetrics): Promise<void> {
    const all = await this.getGarminAll();
    all[metrics.date] = metrics;
    await writeJsonFileAtomically(this.garminDailyPath(), all);
  }

  async saveGarminBulk(metrics: GarminDailyMetrics[]): Promise<void> {
    const all = await this.getGarminAll();
    for (const m of metrics) {
      all[m.date] = m;
    }
    await writeJsonFileAtomically(this.garminDailyPath(), all);
  }

  async getGarminRange(startDate: string, endDate: string): Promise<GarminDailyMetrics[]> {
    const all = await this.getGarminAll();
    return Object.values(all)
      .filter((m) => m.date >= startDate && m.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // --- HRV analysis ---

  private async getHrvAll(): Promise<Record<string, HrvDayAnalysis>> {
    const { value } = await readJsonFileWithFallback<Record<string, HrvDayAnalysis>>(
      this.hrvAnalysisPath(),
      {},
    );
    return value;
  }

  async getHrvAnalysis(date: string): Promise<HrvDayAnalysis | null> {
    const all = await this.getHrvAll();
    return all[date] ?? null;
  }

  async saveHrvAnalysis(analysis: HrvDayAnalysis): Promise<void> {
    const all = await this.getHrvAll();
    all[analysis.date] = analysis;
    await writeJsonFileAtomically(this.hrvAnalysisPath(), all);
  }

  async saveHrvBulk(analyses: HrvDayAnalysis[]): Promise<void> {
    const all = await this.getHrvAll();
    for (const a of analyses) {
      all[a.date] = a;
    }
    await writeJsonFileAtomically(this.hrvAnalysisPath(), all);
  }

  async getHrvRange(startDate: string, endDate: string): Promise<HrvDayAnalysis[]> {
    const all = await this.getHrvAll();
    return Object.values(all)
      .filter((a) => a.date >= startDate && a.date <= endDate)
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  // --- helpers ---

  /** List session files sorted by date descending (most recent first). */
  private async listSessionFiles(): Promise<string[]> {
    try {
      const dir = this.sessionsDir();
      const entries = await fs.readdir(dir);
      return entries.filter((e) => e.endsWith(".json")).sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }
}
