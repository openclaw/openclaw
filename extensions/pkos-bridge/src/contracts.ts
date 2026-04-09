import { Type } from "@sinclair/typebox";

export const PkosBridgeStatusToolSchema = Type.Object({}, { additionalProperties: false });

export const PrepareTaskHandoffToolSchema = Type.Object(
  {
    task_id: Type.String({
      description: "Stable task identifier assigned by OpenClaw orchestration.",
    }),
    goal: Type.String({
      description: "What Workbench should accomplish in this run.",
    }),
    expected_output: Type.String({
      description: "What artifact or result should be handed back after the run.",
    }),
    constraints: Type.Array(Type.String(), {
      description: "Boundary conditions that the run must obey.",
      default: [],
    }),
    handoff_back_when: Type.String({
      description: "The condition that tells Workbench to hand the run back to OpenClaw.",
    }),
  },
  { additionalProperties: false },
);

export const SubmitTraceBundleToolSchema = Type.Object(
  {
    run_id: Type.String({
      description: "Workbench run identifier bound to this trace bundle.",
    }),
    task_id: Type.Optional(
      Type.String({
        description: "Optional task identifier that anchors the originating handoff.",
      }),
    ),
    trace_bundle_path: Type.String({
      description: "Filesystem path or logical path of the frozen trace bundle.",
    }),
    summary: Type.Optional(
      Type.String({
        description: "Short human-readable summary for the pending review surface.",
      }),
    ),
  },
  { additionalProperties: false },
);
