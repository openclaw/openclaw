// Gateway Protocol schema module for the operator terminal surface.
// Terminal methods open a PTY-backed shell session bound to one authenticated
// operator connection and stream its bytes back over the existing WebSocket.
import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

// PTY grids are bounded so a hostile client cannot request an allocation that
// overflows the terminal backend's row/column math.
const TerminalDimension = Type.Integer({ minimum: 1, maximum: 2000 });

/** Opens a shell session; the server picks the shell, cwd, and confinement. */
export const TerminalOpenParamsSchema = Type.Object(
  {
    // Optional agent selector; defaults to the gateway's default agent. The
    // session starts in that agent's workspace and inherits its isolation.
    agentId: Type.Optional(NonEmptyString),
    cols: TerminalDimension,
    rows: TerminalDimension,
  },
  { additionalProperties: false },
);
export type TerminalOpenParams = Static<typeof TerminalOpenParamsSchema>;

/** Result of a successful open; carries the facts the UI header renders. */
export const TerminalOpenResultSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    agentId: NonEmptyString,
    shell: NonEmptyString,
    cwd: NonEmptyString,
    // True when the shell runs inside the agent's sandbox and cannot escape the
    // workspace; false for a host shell that can navigate the whole filesystem.
    confined: Type.Boolean(),
  },
  { additionalProperties: false },
);
export type TerminalOpenResult = Static<typeof TerminalOpenResultSchema>;

/** Writes client keystrokes to the session stdin. */
export const TerminalInputParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    // Raw terminal input (already-encoded escape sequences from the emulator).
    data: Type.String(),
  },
  { additionalProperties: false },
);
export type TerminalInputParams = Static<typeof TerminalInputParamsSchema>;

/** Resizes the PTY grid after the client viewport changes. */
export const TerminalResizeParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    cols: TerminalDimension,
    rows: TerminalDimension,
  },
  { additionalProperties: false },
);
export type TerminalResizeParams = Static<typeof TerminalResizeParamsSchema>;

/** Closes a session and kills its process tree. */
export const TerminalCloseParamsSchema = Type.Object(
  { sessionId: NonEmptyString },
  { additionalProperties: false },
);
export type TerminalCloseParams = Static<typeof TerminalCloseParamsSchema>;

/** Shared ok/void result for input, resize, and close. */
export const TerminalAckResultSchema = Type.Object(
  { ok: Type.Boolean() },
  { additionalProperties: false },
);
export type TerminalAckResult = Static<typeof TerminalAckResultSchema>;

/** Streamed output chunk; seq lets the client detect gaps and preserve order. */
export const TerminalDataEventSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    seq: Type.Integer({ minimum: 0 }),
    data: Type.String(),
  },
  { additionalProperties: false },
);
export type TerminalDataEvent = Static<typeof TerminalDataEventSchema>;

/** Terminal end-of-life notice; the session id is invalid after this event. */
export const TerminalExitEventSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    signal: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    // Stable reason code so clients can distinguish process exit from a
    // server-side teardown (disconnect, idle sweep, config disable).
    reason: Type.Optional(
      Type.Union([
        Type.Literal("process_exit"),
        Type.Literal("closed"),
        Type.Literal("disconnected"),
        Type.Literal("error"),
      ]),
    ),
    error: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type TerminalExitEvent = Static<typeof TerminalExitEventSchema>;

/** Union of every event a terminal session can emit. */
export const TerminalEventSchema = Type.Union([TerminalDataEventSchema, TerminalExitEventSchema]);
export type TerminalEvent = Static<typeof TerminalEventSchema>;
