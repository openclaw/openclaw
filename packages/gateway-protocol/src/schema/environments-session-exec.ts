import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";

/** Commands always run in the environment attached to the authenticated conversation. */
export const EnvironmentsSessionExecParamsSchema = Type.Refine(
  closedObject({
    sessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 1_024 })),
    agentId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    environmentId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    action: Type.Optional(
      Type.Union([
        Type.Literal("run"),
        Type.Literal("start"),
        Type.Literal("status"),
        Type.Literal("stop"),
      ]),
    ),
    processId: Type.Optional(
      Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$" }),
    ),
    argv: Type.Optional(
      Type.Array(Type.String({ minLength: 1, maxLength: 131_072 }), { minItems: 1, maxItems: 128 }),
    ),
    input: Type.Optional(Type.String({ maxLength: 131_072 })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 600_000 })),
  }),
  (value) => {
    const action = value.action ?? "run";
    return action === "run"
      ? value.argv !== undefined && value.processId === undefined
      : action === "start"
        ? value.argv !== undefined && value.processId !== undefined
        : value.processId !== undefined &&
          value.argv === undefined &&
          value.input === undefined &&
          value.timeoutMs === undefined;
  },
  () =>
    "run/start require argv; start/status/stop require processId; status/stop accept no command",
);

export type EnvironmentsSessionExecParams = Static<typeof EnvironmentsSessionExecParamsSchema>;
