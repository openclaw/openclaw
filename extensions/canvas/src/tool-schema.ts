import {
  optionalFiniteNumberSchema,
  optionalPositiveIntegerSchema,
  stringEnum,
} from "openclaw/plugin-sdk/channel-actions";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

const CanvasToolSchema = Type.Object({
  action: stringEnum(["present", "hide", "navigate"]),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: optionalPositiveIntegerSchema(),
  node: Type.Optional(Type.String()),
  target: Type.Optional(Type.String()),
  x: optionalFiniteNumberSchema(),
  y: optionalFiniteNumberSchema(),
  width: optionalFiniteNumberSchema(),
  height: optionalFiniteNumberSchema(),
  url: Type.Optional(Type.String()),
});

export const canvasToolDefinition = {
  label: "Canvas",
  name: "canvas",
  resultContentSource: "network",
  description: "Present, hide, or navigate the widget panel on a paired macOS node.",
  parameters: CanvasToolSchema,
} satisfies Omit<AnyAgentTool, "execute">;
