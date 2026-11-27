import { Type } from "typebox";
import { AgentDatabaseAdmissionRefusalSchema } from "./agent-database-admission.js";
import { AgentCreatedViaSchema, AgentKindSchema } from "./agent-summary-enums.js";
import { closedObject } from "./closed-object.js";
import {
  GatewayAgentRuntimeSchema,
  GatewayThinkingLevelOptionSchema,
} from "./model-runtime-options.js";
import { NonEmptyString } from "./primitives.js";
import { RecommendedPromptsSchema } from "./recommended-prompts.js";
import { SessionPermissionModeSchema } from "./sessions-row.js";

/** Condensed agent record returned by list APIs. */
export const AgentSummarySchema = closedObject({
  id: NonEmptyString,
  /** Effective explicit utility model; absent for automatic or disabled utility routing. */
  utilityModel: Type.Optional(NonEmptyString),
  status: Type.Optional(Type.Literal("degraded")),
  admissionRefusal: Type.Optional(AgentDatabaseAdmissionRefusalSchema),
  kind: Type.Optional(AgentKindSchema),
  createdVia: Type.Optional(AgentCreatedViaSchema),
  creatorAgentId: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  createdAt: Type.Optional(Type.Integer({ minimum: 0 })),
  name: Type.Optional(NonEmptyString),
  description: Type.Optional(NonEmptyString),
  recommendedPrompts: Type.Optional(RecommendedPromptsSchema),
  identity: Type.Optional(
    closedObject({
      name: Type.Optional(NonEmptyString),
      theme: Type.Optional(NonEmptyString),
      emoji: Type.Optional(NonEmptyString),
      avatar: Type.Optional(NonEmptyString),
      avatarUrl: Type.Optional(NonEmptyString),
    }),
  ),
  workspace: Type.Optional(NonEmptyString),
  workspaceGit: Type.Optional(Type.Boolean()),
  model: Type.Optional(
    closedObject({
      primary: Type.Optional(NonEmptyString),
      fallbacks: Type.Optional(Type.Array(NonEmptyString)),
    }),
  ),
  agentRuntime: Type.Optional(GatewayAgentRuntimeSchema),
  thinkingLevels: Type.Optional(Type.Array(GatewayThinkingLevelOptionSchema)),
  thinkingOptions: Type.Optional(Type.Array(NonEmptyString)),
  thinkingDefault: Type.Optional(NonEmptyString),
  thinkingInheritedDefault: Type.Optional(NonEmptyString), // Only with an agent-level thinkingDefault: the level clearing it would resolve to.
  // Configured posture for display only, never an authorization decision.
  defaultPermissionMode: Type.Optional(SessionPermissionModeSchema),
  newSessionPermissionMode: Type.Optional(SessionPermissionModeSchema),
  hidden: Type.Optional(Type.Boolean()),
});
