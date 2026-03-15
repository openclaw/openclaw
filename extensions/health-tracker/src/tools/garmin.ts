import { execSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { toDateString } from "../date-utils.js";
import { computeHrvRange } from "../hrv-analysis.js";
import type { WorkoutStore } from "../workout-store.js";
import type { GarminDailyMetrics, HrvDayAnalysis } from "../workout-types.js";

const GARMIN_ACTIONS = ["status", "import_db", "metrics", "hrv_analysis"] as const;

const GarminSchema = Type.Object({
  action: Type.Unsafe<(typeof GARMIN_ACTIONS)[number]>({
    type: "string",
    enum: [...GARMIN_ACTIONS],
    description:
      "Action to perform. " +
      "'status' checks if Garmin data is loaded. " +
      "'import_db' imports data from a workout.db SQLite file. " +
      "'metrics' shows health metrics for a date range. " +
      "'hrv_analysis' computes HRV baseline analysis.",
  }),
  db_path: Type.Optional(
    Type.String({ description: "Path to workout.db SQLite file (for 'import_db')" }),
  ),
  date: Type.Optional(Type.String({ description: "Specific date YYYY-MM-DD (for 'metrics')" })),
  start_date: Type.Optional(
    Type.String({ description: "Start date YYYY-MM-DD (for 'metrics'/'hrv_analysis')" }),
  ),
  end_date: Type.Optional(
    Type.String({ description: "End date YYYY-MM-DD (for 'metrics'/'hrv_analysis')" }),
  ),
  days: Type.Optional(
    Type.Number({ description: "Last N days to show (default 7, for 'metrics'/'hrv_analysis')" }),
  ),
});

function computeDateRange(params: {
  date?: string;
  start_date?: string;
  end_date?: string;
  days?: number;
}): { startDate: string; endDate: string } {
  const endDate = params.end_date ?? params.date ?? toDateString();
  if (params.start_date) {
    return { startDate: params.start_date, endDate };
  }
  const daysBack = params.days ?? 7;
  const end = new Date(endDate);
  const start = new Date(end);
  start.setDate(start.getDate() - daysBack + 1);
  return { startDate: toDateString(start), endDate };
}

function formatSleepHours(seconds?: number): string | undefined {
  if (seconds == null) return undefined;
  return (seconds / 3600).toFixed(1);
}

export function createGarminTool(workoutStore: WorkoutStore): AnyAgentTool {
  return {
    name: "health_garmin",
    label: "Garmin",
    description:
      "Import and analyze Garmin health data: daily metrics (HRV, RHR, sleep, steps, " +
      "body battery), and HRV baseline analysis with trend detection.",
    parameters: GarminSchema,
    async execute(_toolCallId, params) {
      const action = params.action;

      if (action === "status") {
        const garminData = await workoutStore.getGarminRange("2020-01-01", "2099-12-31");
        const hasData = garminData.length > 0;
        const latestDate = hasData ? garminData[garminData.length - 1]!.date : null;
        const latestHrv = latestDate ? await workoutStore.getHrvAnalysis(latestDate) : null;
        const hasHrvAnalysis = latestHrv != null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  hasData,
                  recordCount: garminData.length,
                  latestDate,
                  hasHrvAnalysis,
                  hint: hasData
                    ? "Use 'metrics' to view health data or 'hrv_analysis' to compute HRV trends."
                    : "Use 'import_db' with db_path to load your workout.db SQLite file.",
                },
                null,
                2,
              ),
            },
          ],
          details: { hasData, latestDate, hasHrvAnalysis },
        };
      }

      if (action === "import_db") {
        if (!params.db_path) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "db_path is required for import_db." }, null, 2),
              },
            ],
            details: null,
          };
        }

        const dbPath = params.db_path;
        const counts = { garminDaily: 0, exercises: 0, programs: 0, sessions: 0, hrvAnalysis: 0 };

        try {
          // Import garmin_daily
          const garminRaw = execSync(
            `sqlite3 -json "${dbPath}" "SELECT * FROM garmin_daily ORDER BY date"`,
            { encoding: "utf-8" },
          );
          const garminRows = JSON.parse(garminRaw) as Record<string, unknown>[];
          const garminMetrics: GarminDailyMetrics[] = garminRows.map((row) => ({
            date: String(row.date),
            rhr: row.rhr != null ? Number(row.rhr) : undefined,
            hrv: row.hrv != null ? Number(row.hrv) : undefined,
            steps: row.steps != null ? Number(row.steps) : undefined,
            caloriesActive: row.calories_active != null ? Number(row.calories_active) : undefined,
            caloriesResting:
              row.calories_resting != null ? Number(row.calories_resting) : undefined,
            weight: row.weight != null ? Number(row.weight) : undefined,
            sleepScore: row.sleep_score != null ? Number(row.sleep_score) : undefined,
            sleepDurationSeconds:
              row.sleep_duration_seconds != null ? Number(row.sleep_duration_seconds) : undefined,
            sleepDeepSeconds:
              row.sleep_deep_seconds != null ? Number(row.sleep_deep_seconds) : undefined,
            sleepLightSeconds:
              row.sleep_light_seconds != null ? Number(row.sleep_light_seconds) : undefined,
            sleepRemSeconds:
              row.sleep_rem_seconds != null ? Number(row.sleep_rem_seconds) : undefined,
            sleepAwakeSeconds:
              row.sleep_awake_seconds != null ? Number(row.sleep_awake_seconds) : undefined,
            bodyBatteryStart:
              row.body_battery_start != null ? Number(row.body_battery_start) : undefined,
            bodyBatteryEnd: row.body_battery_end != null ? Number(row.body_battery_end) : undefined,
            stressAvg: row.stress_avg != null ? Number(row.stress_avg) : undefined,
          }));
          await workoutStore.saveGarminBulk(garminMetrics);
          counts.garminDaily = garminMetrics.length;

          // Import exercises
          try {
            const exercisesRaw = execSync(
              `sqlite3 -json "${dbPath}" "SELECT * FROM exercises ORDER BY canonical_name"`,
              { encoding: "utf-8" },
            );
            const exerciseRows = JSON.parse(exercisesRaw) as Record<string, unknown>[];
            for (const row of exerciseRows) {
              await workoutStore.getOrCreateExercise(
                String(row.canonical_name),
                row.muscle_group != null ? String(row.muscle_group) : undefined,
                row.slot != null ? String(row.slot) : undefined,
              );
              counts.exercises++;
            }
          } catch {
            // exercises table may not exist
          }

          // Import programs + program_days + program_day_exercises
          try {
            const programsRaw = execSync(`sqlite3 -json "${dbPath}" "SELECT * FROM programs"`, {
              encoding: "utf-8",
            });
            const programRows = JSON.parse(programsRaw) as Record<string, unknown>[];

            for (const pRow of programRows) {
              const programId = String(pRow.id);

              const daysRaw = execSync(
                `sqlite3 -json "${dbPath}" "SELECT * FROM program_days WHERE program_id = '${programId}' ORDER BY rotation_order"`,
                { encoding: "utf-8" },
              );
              const dayRows = JSON.parse(daysRaw) as Record<string, unknown>[];

              const days = [];
              for (const dRow of dayRows) {
                const dayId = String(dRow.id);

                const exRaw = execSync(
                  `sqlite3 -json "${dbPath}" "SELECT * FROM program_day_exercises WHERE program_day_id = '${dayId}' ORDER BY position"`,
                  { encoding: "utf-8" },
                );
                const exRows = JSON.parse(exRaw) as Record<string, unknown>[];

                const exercises = exRows.map((eRow) => ({
                  exerciseId: String(eRow.exercise_id),
                  position: Number(eRow.position),
                  sets: Number(eRow.sets),
                  repRanges: JSON.parse(String(eRow.rep_ranges ?? "[]")) as string[],
                  style: eRow.style != null ? String(eRow.style) : undefined,
                  variations: eRow.variations
                    ? (JSON.parse(String(eRow.variations)) as string[])
                    : undefined,
                }));

                days.push({
                  id: dayId,
                  dayLabel: String(dRow.day_label),
                  rotationOrder: Number(dRow.rotation_order),
                  focus: dRow.focus != null ? String(dRow.focus) : undefined,
                  exercises,
                });
              }

              await workoutStore.saveProgram({
                id: programId,
                name: String(pRow.name),
                code: pRow.code != null ? String(pRow.code) : undefined,
                days,
              });
              counts.programs++;
            }
          } catch {
            // programs table may not exist
          }

          // Import sessions + sets_logged
          try {
            const sessionsRaw = execSync(
              `sqlite3 -json "${dbPath}" "SELECT * FROM sessions ORDER BY date"`,
              { encoding: "utf-8" },
            );
            const sessionRows = JSON.parse(sessionsRaw) as Record<string, unknown>[];

            for (const sRow of sessionRows) {
              const sessionId = String(sRow.id);

              let sets: {
                id: string;
                exerciseId: string;
                setNumber: number;
                weight: number;
                reps: number;
                note?: string;
              }[] = [];
              try {
                const setsRaw = execSync(
                  `sqlite3 -json "${dbPath}" "SELECT * FROM sets_logged WHERE session_id = '${sessionId}' ORDER BY set_number"`,
                  { encoding: "utf-8" },
                );
                const setRows = JSON.parse(setsRaw) as Record<string, unknown>[];
                sets = setRows.map((r) => ({
                  id: String(r.id),
                  exerciseId: String(r.exercise_id),
                  setNumber: Number(r.set_number),
                  weight: Number(r.weight),
                  reps: Number(r.reps),
                  note: r.note != null ? String(r.note) : undefined,
                }));
              } catch {
                // sets_logged may not exist for this session
              }

              await workoutStore.saveSession({
                id: sessionId,
                date: String(sRow.date),
                programId: sRow.program_id != null ? String(sRow.program_id) : undefined,
                programDayId: sRow.program_day_id != null ? String(sRow.program_day_id) : undefined,
                source: String(sRow.source ?? "import"),
                status: String(sRow.status ?? "completed") as "in_progress" | "completed",
                startedAt: sRow.started_at != null ? String(sRow.started_at) : undefined,
                endedAt: sRow.ended_at != null ? String(sRow.ended_at) : undefined,
                sets,
              });
              counts.sessions++;
            }
          } catch {
            // sessions table may not exist
          }

          // Import hrv_analysis
          try {
            const hrvRaw = execSync(
              `sqlite3 -json "${dbPath}" "SELECT * FROM hrv_analysis ORDER BY date"`,
              { encoding: "utf-8" },
            );
            const hrvRows = JSON.parse(hrvRaw) as Record<string, unknown>[];
            const analyses: HrvDayAnalysis[] = hrvRows.map((row) => ({
              date: String(row.date),
              hrvRaw: row.hrv_raw != null ? Number(row.hrv_raw) : undefined,
              rhrRaw: row.rhr_raw != null ? Number(row.rhr_raw) : undefined,
              hrv7dMa: row.hrv_7d_ma != null ? Number(row.hrv_7d_ma) : undefined,
              hrvBaseline60d:
                row.hrv_baseline_60d != null ? Number(row.hrv_baseline_60d) : undefined,
              hrvSd60d: row.hrv_sd_60d != null ? Number(row.hrv_sd_60d) : undefined,
              hrvNormalLow: row.hrv_normal_low != null ? Number(row.hrv_normal_low) : undefined,
              hrvNormalHigh: row.hrv_normal_high != null ? Number(row.hrv_normal_high) : undefined,
              hrvStatus: row.hrv_status != null ? String(row.hrv_status) : undefined,
              hrvPctFromBaseline:
                row.hrv_pct_from_baseline != null ? Number(row.hrv_pct_from_baseline) : undefined,
              rhrBaseline60d:
                row.rhr_baseline_60d != null ? Number(row.rhr_baseline_60d) : undefined,
              rhrSd60d: row.rhr_sd_60d != null ? Number(row.rhr_sd_60d) : undefined,
              rhrNormalLow: row.rhr_normal_low != null ? Number(row.rhr_normal_low) : undefined,
              rhrNormalHigh: row.rhr_normal_high != null ? Number(row.rhr_normal_high) : undefined,
              rhrStatus: row.rhr_status != null ? String(row.rhr_status) : undefined,
              hrvCv7d: row.hrv_cv_7d != null ? Number(row.hrv_cv_7d) : undefined,
              trend28d: row.trend_28d != null ? String(row.trend_28d) : undefined,
              hrvTrendDirection:
                row.hrv_trend_direction != null ? String(row.hrv_trend_direction) : undefined,
              rhrTrendDirection:
                row.rhr_trend_direction != null ? String(row.rhr_trend_direction) : undefined,
              cvTrendDirection:
                row.cv_trend_direction != null ? String(row.cv_trend_direction) : undefined,
              daysBelowHrvNormal:
                row.days_below_hrv_normal != null ? Number(row.days_below_hrv_normal) : undefined,
              postWorkout: row.post_workout != null ? Boolean(row.post_workout) : undefined,
            }));
            await workoutStore.saveHrvBulk(analyses);
            counts.hrvAnalysis = analyses.length;
          } catch {
            // hrv_analysis table may not exist
          }
        } catch (err) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "Failed to import database.",
                    detail: err instanceof Error ? err.message : String(err),
                  },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "import_complete",
                  counts,
                },
                null,
                2,
              ),
            },
          ],
          details: counts,
        };
      }

      if (action === "metrics") {
        const { startDate, endDate } = computeDateRange(params);
        const filtered = await workoutStore.getGarminRange(startDate, endDate);

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "No Garmin data for this date range.",
                    startDate,
                    endDate,
                    hint: "Use 'import_db' to load data first.",
                  },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        const daily = filtered.map((d: GarminDailyMetrics) => ({
          date: d.date,
          hrv: d.hrv,
          rhr: d.rhr,
          steps: d.steps,
          weight: d.weight,
          sleepHours: formatSleepHours(d.sleepDurationSeconds),
          sleepScore: d.sleepScore,
          bodyBattery:
            d.bodyBatteryStart != null && d.bodyBatteryEnd != null
              ? `${d.bodyBatteryStart} -> ${d.bodyBatteryEnd}`
              : undefined,
          stressAvg: d.stressAvg,
          caloriesActive: d.caloriesActive,
          caloriesResting: d.caloriesResting,
        }));

        // Compute 7d averages for key metrics
        const last7 = filtered.slice(-7);
        const avg = (arr: (number | undefined)[]) => {
          const valid = arr.filter((v): v is number => v != null);
          return valid.length > 0
            ? Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10
            : null;
        };

        const averages = {
          hrv: avg(last7.map((d: GarminDailyMetrics) => d.hrv)),
          rhr: avg(last7.map((d: GarminDailyMetrics) => d.rhr)),
          steps: avg(last7.map((d: GarminDailyMetrics) => d.steps)),
          sleepHours: avg(
            last7.map((d: GarminDailyMetrics) =>
              d.sleepDurationSeconds != null ? d.sleepDurationSeconds / 3600 : undefined,
            ),
          ),
          sleepScore: avg(last7.map((d: GarminDailyMetrics) => d.sleepScore)),
          stressAvg: avg(last7.map((d: GarminDailyMetrics) => d.stressAvg)),
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  dateRange: { start: startDate, end: endDate },
                  daysCount: filtered.length,
                  daily,
                  sevenDayAverages: averages,
                },
                null,
                2,
              ),
            },
          ],
          details: { daily, averages },
        };
      }

      if (action === "hrv_analysis") {
        // Need full history for 60d baseline computation
        const allGarmin = await workoutStore.getGarminRange("2020-01-01", "2099-12-31");
        if (allGarmin.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "No Garmin data found. Use 'import_db' first.",
                  },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        // Post-workout flags are nice-to-have; pass empty set since there's
        // no efficient way to enumerate all session dates from the store.
        const sessionDates = new Set<string>();

        // Compute HRV analysis for all dates
        const analyses = computeHrvRange(allGarmin, sessionDates);

        // Save results
        await workoutStore.saveHrvBulk(analyses);

        // Filter to requested range for display
        const { startDate, endDate } = computeDateRange(params);
        const recent = analyses.filter((a) => a.date >= startDate && a.date <= endDate);

        // Summary trend info from the most recent entry
        const latest = analyses.length > 0 ? analyses[analyses.length - 1]! : null;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "hrv_analysis_complete",
                  totalDaysAnalyzed: analyses.length,
                  dateRange: { start: startDate, end: endDate },
                  recentCount: recent.length,
                  recent,
                  latestTrend: latest
                    ? {
                        date: latest.date,
                        hrvStatus: latest.hrvStatus,
                        rhrStatus: latest.rhrStatus,
                        trend28d: latest.trend28d,
                        hrvTrendDirection: latest.hrvTrendDirection,
                        rhrTrendDirection: latest.rhrTrendDirection,
                        hrvBaseline60d: latest.hrvBaseline60d,
                        hrvPctFromBaseline: latest.hrvPctFromBaseline,
                      }
                    : null,
                },
                null,
                2,
              ),
            },
          ],
          details: { totalDaysAnalyzed: analyses.length, recent, latestTrend: latest },
        };
      }

      return {
        content: [{ type: "text" as const, text: `{"error": "Unknown action: ${action}"}` }],
        details: null,
      };
    },
  } as AnyAgentTool;
}
