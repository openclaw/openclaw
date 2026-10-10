import { Type } from "typebox";

export const AgentKindSchema = Type.Union([Type.Literal("agent"), Type.Literal("system")]);

export const AgentCreatedViaSchema = Type.Union([
  Type.Literal("operator"),
  Type.Literal("agent"),
  Type.Literal("claw"),
]);

export const AgentOwnershipSchema = Type.Union([
  Type.Literal("sole"),
  Type.Literal("legacy"),
  Type.Literal("explicit"),
]);
