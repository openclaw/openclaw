import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { nowISO, toDateString, uuid } from "../date-utils.js";
import {
  buildSetTargets,
  checkPlateau,
  estimateRestSeconds,
  getSuggestedWeight,
  overloadSuggestion,
} from "../overload.js";
import type { WorkoutStore } from "../workout-store.js";
import type { ExercisePlan, LoggedSet, WorkoutPlan, WorkoutSession } from "../workout-types.js";

const WORKOUT_ACTIONS = ["plan", "start", "log_set", "finish", "summary"] as const;

const WorkoutSchema = Type.Object({
  action: Type.Unsafe<(typeof WORKOUT_ACTIONS)[number]>({
    type: "string",
    enum: [...WORKOUT_ACTIONS],
    description:
      "Action to perform. " +
      "'plan' suggests next workout with progressive overload. " +
      "'start' begins a new workout session. " +
      "'log_set' records a completed set. " +
      "'finish' completes the current session. " +
      "'summary' shows session details.",
  }),
  program_day_id: Type.Optional(
    Type.String({ description: "Program day ID to start (for 'start' action)" }),
  ),
  exercise: Type.Optional(Type.String({ description: "Exercise name (for 'log_set' action)" })),
  weight: Type.Optional(Type.Number({ description: "Weight in kg (for 'log_set' action)" })),
  reps: Type.Optional(Type.Number({ description: "Reps performed (for 'log_set' action)" })),
  date: Type.Optional(
    Type.String({ description: "Date YYYY-MM-DD (for 'plan'/'summary', defaults to today)" }),
  ),
  session_id: Type.Optional(Type.String({ description: "Session ID (for 'finish'/'summary')" })),
});

export function createWorkoutTool(workoutStore: WorkoutStore): AnyAgentTool {
  return {
    name: "health_workout",
    label: "Workout",
    description:
      "Plan workouts with progressive overload, start sessions, log sets, " +
      "and finish workouts. Uses your program to suggest weights and reps.",
    parameters: WorkoutSchema,
    async execute(_toolCallId, params) {
      const action = params.action;

      if (action === "plan") {
        const date = params.date ?? toDateString();
        const lastSession = await workoutStore.getLastSessionWithProgram();
        const programs = await workoutStore.getPrograms();

        if (programs.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "No programs found. Use health_program to create one first.",
                  },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        const program = programs[0]!;
        const totalDays = program.days.length;

        let nextRotationOrder: number;
        if (lastSession?.programDayId) {
          const lastDay = program.days.find((d) => d.id === lastSession.programDayId);
          const lastOrder = lastDay?.rotationOrder ?? 0;
          nextRotationOrder = (lastOrder % totalDays) + 1;
        } else {
          nextRotationOrder = 1;
        }

        const nextDay = program.days.find((d) => d.rotationOrder === nextRotationOrder) ?? null;

        const exercises: ExercisePlan[] = [];
        if (nextDay) {
          for (const pde of nextDay.exercises) {
            const exercise = await workoutStore.getExercise(pde.exerciseId);
            if (!exercise) continue;

            const history = await workoutStore.getExerciseHistory(pde.exerciseId, 10);
            const lastSets = history.length > 0 ? history[0]!.sets : [];
            const repRanges = pde.repRanges;
            const setCount = pde.sets;

            const setTargets = buildSetTargets(lastSets, repRanges, setCount);
            const suggestion = overloadSuggestion(lastSets, repRanges, setCount);
            const suggestedWeight = getSuggestedWeight(lastSets, repRanges, setCount);
            const plateau = checkPlateau(history);
            const restSeconds = estimateRestSeconds(pde.style, repRanges);

            const swapVariants: { id: string; name: string }[] = [];
            if (pde.variations) {
              for (const varName of pde.variations) {
                const resolved = await workoutStore.resolveExercise(varName);
                if (resolved) {
                  swapVariants.push({ id: resolved.id, name: resolved.canonicalName });
                }
              }
            }

            exercises.push({
              id: uuid(),
              baseExerciseId: pde.exerciseId,
              name: exercise.canonicalName,
              slot: exercise.slot,
              sets: setCount,
              repRanges,
              style: pde.style,
              lastSets: lastSets.map((s: LoggedSet) => ({
                date: history[0]!.date,
                weight: s.weight,
                reps: s.reps,
                setNumber: s.setNumber,
              })),
              suggestion,
              suggestedWeight,
              setTargets,
              restSeconds,
              swapVariants,
              plateau,
            });
          }
        }

        const plan: WorkoutPlan = {
          lastSessionDate: lastSession?.date ?? null,
          nextDay: nextDay ? { ...nextDay, programName: program.name } : null,
          exercises,
          allDays: program.days.map((d) => ({
            id: d.id,
            rotationOrder: d.rotationOrder,
            focus: d.focus,
            dayLabel: d.dayLabel,
          })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(plan, null, 2) }],
          details: plan,
        };
      }

      if (action === "start") {
        if (!params.program_day_id) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "program_day_id is required to start a session." },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        const today = toDateString();
        const existingSessions = await workoutStore.getSessionsByDate(today);
        const existing =
          existingSessions.find((s: WorkoutSession) => s.status === "in_progress") ?? null;
        if (existing) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  {
                    error: "Active session already exists today.",
                    session_id: existing.id,
                  },
                  null,
                  2,
                ),
              },
            ],
            details: existing,
          };
        }

        const programs = await workoutStore.getPrograms();
        const programDay =
          programs
            .flatMap((p) => p.days.map((d) => ({ ...d, programId: p.id })))
            .find((d) => d.id === params.program_day_id) ?? null;
        const session: WorkoutSession = {
          id: uuid(),
          date: today,
          programId: programDay?.programId,
          programDayId: params.program_day_id,
          source: "manual",
          status: "in_progress",
          startedAt: nowISO(),
          sets: [],
        };

        await workoutStore.saveSession(session);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "session_started",
                  session_id: session.id,
                  date: today,
                  programDayId: params.program_day_id,
                },
                null,
                2,
              ),
            },
          ],
          details: session,
        };
      }

      if (action === "log_set") {
        const today = toDateString();
        const todaySessions = await workoutStore.getSessionsByDate(today);
        const session =
          todaySessions.find((s: WorkoutSession) => s.status === "in_progress") ?? null;
        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "No active session found for today. Use 'start' first." },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        if (!params.exercise) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "exercise is required for log_set." }, null, 2),
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

        const existingSets = session.sets.filter((s: LoggedSet) => s.exerciseId === exercise.id);
        const setNumber = existingSets.length + 1;

        const loggedSet: LoggedSet = {
          id: uuid(),
          exerciseId: exercise.id,
          setNumber,
          weight: params.weight ?? 0,
          reps: params.reps ?? 0,
        };

        session.sets.push(loggedSet);
        await workoutStore.saveSession(session);

        const totalSets = session.sets.length;
        const totalVolume = session.sets.reduce(
          (sum: number, s: LoggedSet) => sum + s.weight * s.reps,
          0,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "set_logged",
                  exercise: exercise.canonicalName,
                  set: loggedSet,
                  runningTotals: {
                    totalSets,
                    totalVolume,
                    exerciseSets: existingSets.length + 1,
                  },
                },
                null,
                2,
              ),
            },
          ],
          details: loggedSet,
        };
      }

      if (action === "finish") {
        let session: WorkoutSession | null;
        if (params.session_id) {
          const finishSessions = await workoutStore.getSessionsByDate(toDateString());
          session = finishSessions.find((s: WorkoutSession) => s.id === params.session_id) ?? null;
        } else {
          const finishSessions = await workoutStore.getSessionsByDate(toDateString());
          session = finishSessions.find((s: WorkoutSession) => s.status === "in_progress") ?? null;
        }

        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "No session found to finish." }, null, 2),
              },
            ],
            details: null,
          };
        }

        session.status = "completed";
        session.endedAt = nowISO();
        await workoutStore.saveSession(session);

        const exerciseNames = new Map<string, string>();
        for (const s of session.sets) {
          if (!exerciseNames.has(s.exerciseId)) {
            const ex = await workoutStore.getExercise(s.exerciseId);
            if (ex) exerciseNames.set(s.exerciseId, ex.canonicalName);
          }
        }

        const exerciseGroups = new Map<string, LoggedSet[]>();
        for (const s of session.sets) {
          const name = exerciseNames.get(s.exerciseId) ?? s.exerciseId;
          if (!exerciseGroups.has(name)) exerciseGroups.set(name, []);
          exerciseGroups.get(name)!.push(s);
        }

        const exercises = [...exerciseGroups.entries()].map(([name, sets]) => ({
          name,
          sets: sets.length,
          volume: sets.reduce((sum: number, s: LoggedSet) => sum + s.weight * s.reps, 0),
        }));

        const totalSets = session.sets.length;
        const totalVolume = session.sets.reduce(
          (sum: number, s: LoggedSet) => sum + s.weight * s.reps,
          0,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "session_completed",
                  session_id: session.id,
                  exercises,
                  totalSets,
                  totalVolume,
                },
                null,
                2,
              ),
            },
          ],
          details: { session_id: session.id, exercises, totalSets, totalVolume },
        };
      }

      if (action === "summary") {
        let session: WorkoutSession | null;
        const summaryDate = params.date ?? toDateString();
        const summarySessions = await workoutStore.getSessionsByDate(summaryDate);
        if (params.session_id) {
          session = summarySessions.find((s: WorkoutSession) => s.id === params.session_id) ?? null;
        } else {
          session = summarySessions[0] ?? null;
        }

        if (!session) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "No session found." }, null, 2),
              },
            ],
            details: null,
          };
        }

        const exerciseNames = new Map<string, string>();
        for (const s of session.sets) {
          if (!exerciseNames.has(s.exerciseId)) {
            const ex = await workoutStore.getExercise(s.exerciseId);
            if (ex) exerciseNames.set(s.exerciseId, ex.canonicalName);
          }
        }

        const exerciseGroups = new Map<string, LoggedSet[]>();
        for (const s of session.sets) {
          const name = exerciseNames.get(s.exerciseId) ?? s.exerciseId;
          if (!exerciseGroups.has(name)) exerciseGroups.set(name, []);
          exerciseGroups.get(name)!.push(s);
        }

        const exercises = [...exerciseGroups.entries()].map(([name, sets]) => ({
          name,
          sets: sets.map((s: LoggedSet) => ({
            setNumber: s.setNumber,
            weight: s.weight,
            reps: s.reps,
          })),
          volume: sets.reduce((sum: number, s: LoggedSet) => sum + s.weight * s.reps, 0),
        }));

        const totalSets = session.sets.length;
        const totalVolume = session.sets.reduce(
          (sum: number, s: LoggedSet) => sum + s.weight * s.reps,
          0,
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  session_id: session.id,
                  date: session.date,
                  status: session.status,
                  startedAt: session.startedAt,
                  endedAt: session.endedAt,
                  exercises,
                  totalSets,
                  totalVolume,
                },
                null,
                2,
              ),
            },
          ],
          details: { session_id: session.id, exercises, totalSets, totalVolume },
        };
      }

      return {
        content: [{ type: "text" as const, text: `{"error": "Unknown action: ${action}"}` }],
        details: null,
      };
    },
  } as AnyAgentTool;
}
