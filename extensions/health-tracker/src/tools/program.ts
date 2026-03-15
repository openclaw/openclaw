import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "openclaw/plugin-sdk/health-tracker";
import { uuid } from "../date-utils.js";
import type { WorkoutStore } from "../workout-store.js";
import type { Program, ProgramDay, ProgramDayExercise } from "../workout-types.js";

const PROGRAM_ACTIONS = ["list", "create", "view"] as const;

const ProgramSchema = Type.Object({
  action: Type.Unsafe<(typeof PROGRAM_ACTIONS)[number]>({
    type: "string",
    enum: [...PROGRAM_ACTIONS],
    description:
      "Action to perform. " +
      "'list' shows all programs. " +
      "'create' creates a new program with days and exercises. " +
      "'view' shows full details of a program.",
  }),
  program_id: Type.Optional(Type.String({ description: "Program ID (for 'view' action)" })),
  name: Type.Optional(Type.String({ description: "Program name (for 'create' action)" })),
  code: Type.Optional(Type.String({ description: "Short program code (for 'create' action)" })),
  days: Type.Optional(
    Type.String({
      description:
        "JSON string describing program days for 'create'. " +
        "Each day: { dayLabel, focus, exercises: [{ name, sets, repRanges, style, slot, variations }] }",
    }),
  ),
});

type DayInput = {
  dayLabel: string;
  focus?: string;
  exercises: {
    name: string;
    sets: number;
    repRanges: string[];
    style?: string;
    slot?: string;
    variations?: string[];
  }[];
};

export function createProgramTool(workoutStore: WorkoutStore): AnyAgentTool {
  return {
    name: "health_program",
    label: "Program",
    description:
      "Manage workout programs: list existing programs, create new programs " +
      "with training days and exercises, or view program details.",
    parameters: ProgramSchema,
    async execute(_toolCallId, params) {
      const action = params.action;

      if (action === "list") {
        const programs = await workoutStore.getPrograms();
        const summary = programs.map((p) => ({
          id: p.id,
          name: p.name,
          code: p.code,
          dayCount: p.days.length,
          exerciseCount: p.days.reduce((sum, d) => sum + d.exercises.length, 0),
        }));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ programs: summary }, null, 2),
            },
          ],
          details: summary,
        };
      }

      if (action === "create") {
        if (!params.name) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "name is required to create a program." }, null, 2),
              },
            ],
            details: null,
          };
        }

        if (!params.days) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(
                  { error: "days JSON string is required to create a program." },
                  null,
                  2,
                ),
              },
            ],
            details: null,
          };
        }

        let daysInput: DayInput[];
        try {
          daysInput = JSON.parse(params.days) as DayInput[];
        } catch {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: "Failed to parse days JSON." }, null, 2),
              },
            ],
            details: null,
          };
        }

        const programId = uuid();
        const programDays: ProgramDay[] = [];

        for (let i = 0; i < daysInput.length; i++) {
          const dayInput = daysInput[i]!;
          const dayId = uuid();
          const exercises: ProgramDayExercise[] = [];

          for (let j = 0; j < dayInput.exercises.length; j++) {
            const exInput = dayInput.exercises[j]!;
            const resolved = await workoutStore.resolveExercise(exInput.name);
            const exerciseId = resolved.id;

            exercises.push({
              exerciseId,
              position: j + 1,
              sets: exInput.sets,
              repRanges: exInput.repRanges,
              style: exInput.style,
              variations: exInput.variations,
            });
          }

          programDays.push({
            id: dayId,
            dayLabel: dayInput.dayLabel,
            rotationOrder: i + 1,
            focus: dayInput.focus,
            exercises,
          });
        }

        const program: Program = {
          id: programId,
          name: params.name,
          code: params.code,
          days: programDays,
        };

        await workoutStore.saveProgram(program);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  status: "program_created",
                  program,
                },
                null,
                2,
              ),
            },
          ],
          details: program,
        };
      }

      if (action === "view") {
        if (!params.program_id) {
          // Show first program if no ID given
          const programs = await workoutStore.getPrograms();
          if (programs.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ error: "No programs found." }, null, 2),
                },
              ],
              details: null,
            };
          }

          const program = programs[0]!;
          return {
            content: [{ type: "text" as const, text: JSON.stringify(program, null, 2) }],
            details: program,
          };
        }

        const program = await workoutStore.getProgram(params.program_id);
        if (!program) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Program not found: ${params.program_id}` }, null, 2),
              },
            ],
            details: null,
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(program, null, 2) }],
          details: program,
        };
      }

      return {
        content: [{ type: "text" as const, text: `{"error": "Unknown action: ${action}"}` }],
        details: null,
      };
    },
  } as AnyAgentTool;
}
