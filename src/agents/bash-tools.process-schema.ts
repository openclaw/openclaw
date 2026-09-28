import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { defineToolOutputSchema } from "./schema/tool-output-schema.js";

const sessionProperties = {
  sessionId: Type.String(),
  name: Type.Optional(Type.String()),
};
const inputProperties = {
  stdinWritable: Type.Boolean(),
  waitingForInput: Type.Boolean(),
  idleMs: Type.Number(),
  lastOutputAt: Type.Number(),
};
const exitProperties = {
  exitCode: Type.Optional(Type.Number()),
  exitSignal: Type.Optional(Type.Union([Type.String(), Type.Number()])),
  exitReason: Type.Optional(Type.String()),
  timedOut: Type.Optional(Type.Boolean()),
  noOutputTimedOut: Type.Optional(Type.Boolean()),
};
const terminalStatus = Type.Union([Type.Literal("completed"), Type.Literal("failed")]);
const sessionListProperties = {
  ...sessionProperties,
  startedAt: Type.Number(),
  runtimeMs: Type.Number(),
  cwd: Type.Optional(Type.String()),
  command: Type.String(),
  tail: Type.String(),
  truncated: Type.Boolean(),
};
const closed = { additionalProperties: false } as const;

const ProcessFailureSchema = Type.Object(
  { status: Type.Literal("failed"), error: Type.String() },
  closed,
);
const ProcessListOutputSchema = Type.Union([
  ProcessFailureSchema,
  Type.Object(
    {
      status: Type.Literal("completed"),
      sessions: Type.Array(
        Type.Union([
          Type.Object(
            {
              ...sessionListProperties,
              status: Type.Literal("running"),
              pid: Type.Optional(Type.Number()),
              ...inputProperties,
            },
            closed,
          ),
          Type.Object(
            {
              ...sessionListProperties,
              status: Type.Union([terminalStatus, Type.Literal("killed")]),
              endedAt: Type.Number(),
              ...exitProperties,
            },
            closed,
          ),
        ]),
      ),
    },
    closed,
  ),
]);
const ProcessPollOutputSchema = Type.Union([
  ProcessFailureSchema,
  Type.Object(
    {
      status: Type.Literal("running"),
      ...sessionProperties,
      ...inputProperties,
      aggregated: Type.String(),
      retryInMs: Type.Optional(Type.Number()),
    },
    closed,
  ),
  Type.Object(
    { status: terminalStatus, ...sessionProperties, ...exitProperties, aggregated: Type.String() },
    closed,
  ),
]);
const logProperties = {
  ...sessionProperties,
  output: Type.String(),
  total: Type.Number(),
  totalLines: Type.Number(),
  totalChars: Type.Number(),
  truncated: Type.Boolean(),
};
const ProcessLogOutputSchema = Type.Union([
  ProcessFailureSchema,
  Type.Object(
    {
      ...logProperties,
      // An exited session still in the running registry retains input details.
      status: Type.Union([Type.Literal("running"), Type.Literal("completed")]),
      ...inputProperties,
    },
    closed,
  ),
  Type.Object({ ...logProperties, status: terminalStatus, ...exitProperties }, closed),
]);
const ProcessInputOutputSchema = Type.Union([
  ProcessFailureSchema,
  Type.Object({ status: Type.Literal("running"), ...sessionProperties }, closed),
]);
const ProcessControlOutputSchema = Type.Union([
  ProcessFailureSchema,
  Type.Object({ status: Type.Literal("completed"), name: Type.Optional(Type.String()) }, closed),
]);

/** Poll is the only process action that returns an aggregate for one session. */
export function isProcessPollResultDetails(value: unknown): boolean {
  const details = asOptionalRecord(value);
  return Boolean(
    details &&
    typeof details.sessionId === "string" &&
    (details.status === "running" || details.status === "completed") &&
    (typeof details.aggregated === "string" ||
      (details.persistedDetailsTruncated === true &&
        Array.isArray(details.originalDetailKeys) &&
        details.originalDetailKeys.includes("aggregated"))),
  );
}

/** Structured process details, shared by eager and lazy tool construction. */
export const ProcessToolOutputSchema = defineToolOutputSchema({
  inputProperty: "action",
  variants: {
    list: ProcessListOutputSchema,
    poll: ProcessPollOutputSchema,
    log: ProcessLogOutputSchema,
    write: ProcessInputOutputSchema,
    "send-keys": ProcessInputOutputSchema,
    submit: ProcessInputOutputSchema,
    paste: ProcessInputOutputSchema,
    kill: ProcessControlOutputSchema,
    clear: ProcessControlOutputSchema,
    remove: ProcessControlOutputSchema,
  },
});
