import { optionalNonNegativeIntegerSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

export const COMPUTER_TOOL_ACTIONS = [
  "screenshot",
  "cursor_position",
  "move",
  "click",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "mouse_down",
  "mouse_up",
  "drag",
  "scroll",
  "key",
  "type",
  "hold",
  "wait",
] as const;

const CoordinateSchema = Type.Tuple([Type.Number(), Type.Number()]);

export const ComputerToolSchema = Type.Object({
  node: Type.Optional(
    Type.String({
      description:
        "Paired macOS node id or display name. Omit only when exactly one connected eligible node exists.",
    }),
  ),
  action: stringEnum(COMPUTER_TOOL_ACTIONS),
  coordinate: Type.Optional(
    Type.Tuple([Type.Number(), Type.Number()], {
      description: "[x, y] pixels in the most recent screenshot coordinate space.",
    }),
  ),
  path: Type.Optional(
    Type.Array(CoordinateSchema, {
      minItems: 2,
      description: "Drag path as screenshot-space [x, y] points.",
    }),
  ),
  button: Type.Optional(stringEnum(["left", "right", "middle"] as const)),
  clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  text: Type.Optional(Type.String()),
  keys: Type.Optional(Type.String()),
  scrollDirection: Type.Optional(stringEnum(["up", "down", "left", "right"] as const)),
  scrollAmount: Type.Optional(Type.Number({ minimum: 0 })),
  dx: Type.Optional(Type.Number()),
  dy: Type.Optional(Type.Number()),
  duration: Type.Optional(Type.Integer({ minimum: 1 })),
  screenIndex: optionalNonNegativeIntegerSchema(),
});
