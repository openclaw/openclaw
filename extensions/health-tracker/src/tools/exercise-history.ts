import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { checkPlateau } from "../overload.js";
import type { WorkoutStore } from "../workout-store.js";

const EXERCISE_ACTIONS = ["history", "search"] as const;

const ExerciseSchema = Type.Object({
  action: Type.Unsafe<(typeof EXERCISE_ACTIONS)[number]>({
    type: "string",
    enum: [...EXERCISE_ACTIONS],
    description:
      "Action to perform. " +
      "'history' shows exercise history with PRs and plateau detection. " +
      "'search' finds exercises by name.",
  }),
  exercise: Type.Optional(Type.String({ description: "Exercise name to look up" })),
  limit: Type.Optional(Type.Number({ description: "Number of sessions to return (default 10)" })),
});

export function createExerciseTool(workoutStore: WorkoutStore): AnyAgentTool {
  return {
    name: "health_exercise",
    label: "Exercise History",
    description:
      "Look up exercise history with progressive overload tracking, PR detection, " +
      "and plateau analysis. Search exercises by name.",
    parameters: ExerciseSchema,
    async execute(_toolCallId, params) {
      const action = params.action;
      const limit = params.limit ?? 10;

      if (action === "history") {
        if (!params.exercise) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "exercise name is required for history." }, null, 2),
              },
            ],
            details: null,
          };
        }

        const exercise = await workoutStore.resolveExercise(params.exercise);
        if (!exercise) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: `Could not resolve exercise: ${params.exercise}` },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        const history = await workoutStore.getExerciseHistory(exercise.id, limit);

        // Build chart data: dates, top weights, volumes per session
        const chartData = history.map((h) => {
          const topWeight = Math.max(...h.sets.map((s) => s.weight), 0);
          const volume = h.sets.reduce((sum, s) => sum + s.weight * s.reps, 0);
          return { date: h.date, topWeight, volume };
        });

        // Find PR (best weight across all sessions)
        let prWeight = 0;
        let prDate = "";
        for (const h of history) {
          for (const s of h.sets) {
            if (s.weight > prWeight) {
              prWeight = s.weight;
              prDate = h.date;
            }
          }
        }

        const plateau = checkPlateau(history);

        const result = {
          exercise: exercise.canonicalName,
          exerciseId: exercise.id,
          slot: exercise.slot,
          muscleGroup: exercise.muscleGroup,
          sessionCount: history.length,
          pr: prWeight > 0 ? { weight: prWeight, date: prDate } : null,
          plateau,
          chartData,
          sessions: history.map((h) => ({
            date: h.date,
            sets: h.sets.map((s) => ({
              setNumber: s.setNumber,
              weight: s.weight,
              reps: s.reps,
            })),
          })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      }

      if (action === "search") {
        const query = params.exercise ?? "";
        const allExercises = await workoutStore.getExercises();
        const q = query.toLowerCase();

        const matches = q
          ? allExercises.filter(
              (e) =>
                e.canonicalName.toLowerCase().includes(q) ||
                (e.slot && e.slot.toLowerCase().includes(q)) ||
                (e.muscleGroup && e.muscleGroup.toLowerCase().includes(q)),
            )
          : allExercises;

        const results = matches.map((e) => ({
          id: e.id,
          name: e.canonicalName,
          slot: e.slot,
          muscleGroup: e.muscleGroup,
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ exercises: results }, null, 2),
            },
          ],
          details: results,
        };
      }

      return {
        content: [{ type: "text" as const, text: `{"error": "Unknown action: ${action}"}` }],
        details: null,
      };
    },
  } as AnyAgentTool;
}
