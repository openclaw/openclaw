import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { PluginDeclaredSurfaceSchema, PluginOperatorGrantsSchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";

const OfficialClawName = Type.String({ pattern: "^@openclaw/[a-z0-9][a-z0-9._-]*$" });
const ClawPluginIntegrity = Type.String({ pattern: "^sha256-[A-Za-z0-9+/]{43}=$" });
const ClawCatalogCoordinateSchema = closedObject({
  packageName: OfficialClawName,
  version: NonEmptyString,
});

export const ClawsCatalogSearchParamsSchema = closedObject({
  query: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const ClawsCatalogEntrySchema = closedObject({
  packageName: OfficialClawName,
  displayName: NonEmptyString,
  summary: Type.Optional(Type.String()),
  latestVersion: Type.Optional(NonEmptyString),
  channel: Type.Literal("official"),
  official: Type.Literal(true),
  downloads: Type.Number({ minimum: 0 }),
  updatedAtMs: Type.Number({ minimum: 0 }),
});

export const ClawsCatalogSearchResultSchema = closedObject({
  entries: Type.Array(ClawsCatalogEntrySchema),
});

export const ClawsCatalogDetailParamsSchema = ClawCatalogCoordinateSchema;
export const ClawsCatalogDetailSchema = closedObject({
  ...ClawsCatalogEntrySchema.properties,
  version: NonEmptyString,
  agentName: Type.Optional(NonEmptyString),
  agentDescription: Type.Optional(Type.String()),
  workspaceFiles: Type.Integer({ minimum: 0 }),
  skills: Type.Integer({ minimum: 0 }),
  plugins: Type.Integer({ minimum: 0 }),
  mcpServers: Type.Integer({ minimum: 0 }),
  scheduledJobs: Type.Integer({ minimum: 0 }),
  scanStatus: Type.Optional(NonEmptyString),
});
export const ClawsCatalogDetailResultSchema = closedObject({ detail: ClawsCatalogDetailSchema });

export const ClawsStatusParamsSchema = closedObject({
  target: Type.Optional(NonEmptyString),
});

export const ClawResourceStatusSchema = closedObject({
  kind: Type.Union([
    Type.Literal("agent"),
    Type.Literal("workspace-file"),
    Type.Literal("skill"),
    Type.Literal("plugin"),
    Type.Literal("mcp-server"),
    Type.Literal("cron-job"),
  ]),
  id: NonEmptyString,
  state: NonEmptyString,
  reason: Type.Optional(NonEmptyString),
  relationship: Type.Optional(Type.Union([Type.Literal("managed"), Type.Literal("referenced")])),
  origin: Type.Optional(
    Type.Union([Type.Literal("claw-introduced"), Type.Literal("pre-existing")]),
  ),
  independentOwner: Type.Optional(Type.Boolean()),
});

export const ClawStatusEntrySchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
  version: NonEmptyString,
  sourceKind: Type.Union([Type.Literal("package"), Type.Literal("development")]),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("workspace_ready"),
    Type.Literal("config_committed"),
    Type.Literal("complete"),
    Type.Literal("partial"),
  ]),
  agentState: Type.Union([
    Type.Literal("present"),
    Type.Literal("modified"),
    Type.Literal("missing"),
  ]),
  bootstrapState: Type.Union([
    Type.Literal("pending"),
    Type.Literal("complete"),
    Type.Literal("missing"),
    Type.Literal("modified"),
    Type.Literal("unsafe"),
    Type.Literal("unknown"),
  ]),
  orphaned: Type.Boolean(),
  addedAtMs: Type.Integer({ minimum: 0 }),
  updatedAtMs: Type.Integer({ minimum: 0 }),
  resources: Type.Array(ClawResourceStatusSchema),
});

export const ClawsStatusResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayStatus.v1"),
  records: Type.Array(ClawStatusEntrySchema),
  summary: closedObject({
    claws: Type.Integer({ minimum: 0 }),
    healthy: Type.Integer({ minimum: 0 }),
    attention: Type.Integer({ minimum: 0 }),
    managed: Type.Integer({ minimum: 0 }),
    referenced: Type.Integer({ minimum: 0 }),
  }),
});

export const ClawPluginReviewSchema = closedObject({
  actionId: NonEmptyString,
  pluginId: NonEmptyString,
  ref: NonEmptyString,
  version: NonEmptyString,
  ownerAction: Type.Union([Type.Literal("install"), Type.Literal("reuse")]),
  integrity: ClawPluginIntegrity,
  declaredCapabilities: PluginDeclaredSurfaceSchema,
  capabilityGrants: PluginOperatorGrantsSchema,
  reviewToken: NonEmptyString,
  riskWarning: Type.Optional(NonEmptyString),
});

export const ClawPluginAcknowledgementSchema = closedObject({
  actionId: NonEmptyString,
  pluginId: NonEmptyString,
  reviewToken: NonEmptyString,
  capabilityGrants: PluginOperatorGrantsSchema,
  acknowledgeRiskWarning: Type.Optional(Type.Literal(true)),
});

export const ClawSkillReviewSchema = closedObject({
  actionId: NonEmptyString,
  ref: NonEmptyString,
  version: NonEmptyString,
  integrity: NonEmptyString,
  riskWarning: NonEmptyString,
  reviewToken: NonEmptyString,
});

export const ClawSkillAcknowledgementSchema = closedObject({
  actionId: NonEmptyString,
  ref: NonEmptyString,
  reviewToken: NonEmptyString,
  acknowledgeRiskWarning: Type.Literal(true),
});

export const ClawsAddPlanParamsSchema = closedObject({
  source: ClawCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
});

export const ClawsAddApplyParamsSchema = closedObject({
  source: ClawCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
  planIntegrity: NonEmptyString,
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
  acknowledgeCapabilities: Type.Optional(Type.Array(ClawPluginAcknowledgementSchema)),
  acknowledgeSkillWarnings: Type.Optional(Type.Array(ClawSkillAcknowledgementSchema)),
});

export const ClawsUpdatePlanParamsSchema = closedObject({
  agentId: NonEmptyString,
  source: ClawCatalogCoordinateSchema,
});

export const ClawsUpdateApplyParamsSchema = closedObject({
  agentId: NonEmptyString,
  source: ClawCatalogCoordinateSchema,
  planIntegrity: NonEmptyString,
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
  acknowledgeCapabilities: Type.Optional(Type.Array(ClawPluginAcknowledgementSchema)),
  acknowledgeSkillWarnings: Type.Optional(Type.Array(ClawSkillAcknowledgementSchema)),
});

export const ClawsRemovePlanParamsSchema = closedObject({ agentId: NonEmptyString });
export const ClawsRemoveApplyParamsSchema = closedObject({
  agentId: NonEmptyString,
  planIntegrity: NonEmptyString,
});

const ClawMemorySourceSchema = Type.Union([Type.Literal("memory"), Type.Literal("sessions")]);

const ClawConfiguredAccessSnapshotSchema = closedObject({
  tools: closedObject({
    allowed: Type.Array(NonEmptyString),
    excluded: Type.Array(NonEmptyString),
  }),
  sandbox: closedObject({
    mode: Type.Union([Type.Literal("off"), Type.Literal("non-main"), Type.Literal("all")]),
    scope: Type.Union([Type.Literal("session"), Type.Literal("agent"), Type.Literal("shared")]),
    workspaceAccess: Type.Union([Type.Literal("none"), Type.Literal("ro"), Type.Literal("rw")]),
    backend: Type.Union([Type.Literal("docker"), Type.Literal("ssh"), Type.Literal("other")]),
  }),
  filesystem: closedObject({ workspaceOnly: Type.Boolean() }),
  heartbeat: closedObject({
    enabled: Type.Boolean(),
    intervalMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
    activeHours: Type.Optional(
      closedObject({
        start: Type.Optional(NonEmptyString),
        end: Type.Optional(NonEmptyString),
        timezone: Type.Optional(NonEmptyString),
      }),
    ),
    isolatedSession: Type.Optional(Type.Boolean()),
  }),
  memorySearch: Type.Union([
    closedObject({ state: Type.Literal("disabled") }),
    closedObject({ state: Type.Literal("unresolved") }),
    closedObject({
      state: Type.Literal("configured"),
      rememberAcrossConversations: Type.Boolean(),
      sessionMemory: Type.Boolean(),
      indexedSources: Type.Array(ClawMemorySourceSchema),
      searchSources: Type.Array(ClawMemorySourceSchema),
      extraPathCount: Type.Integer({ minimum: 0 }),
    }),
  ]),
  subagentTargets: closedObject({
    allowedAgentIds: Type.Array(NonEmptyString),
    allowAnyConfiguredAgent: Type.Boolean(),
    implicitSelfAllowed: Type.Boolean(),
    requireAgentId: Type.Boolean(),
  }),
});

export const ClawConfiguredAccessSchema = closedObject({
  coverage: Type.Literal("configuration-only"),
  current: Type.Optional(ClawConfiguredAccessSnapshotSchema),
  desired: Type.Optional(ClawConfiguredAccessSnapshotSchema),
  unresolved: Type.Array(
    Type.Union([
      Type.Literal("runtime-tools"),
      Type.Literal("sandbox-runtime"),
      Type.Literal("memory-runtime"),
      Type.Literal("subagent-runtime"),
      Type.Literal("scheduler-runtime"),
    ]),
  ),
});

const ClawScheduledDeclarationSchema = closedObject({
  schedule: closedObject({ cron: NonEmptyString, timezone: NonEmptyString }),
  session: Type.Union([Type.Literal("main"), Type.Literal("isolated")]),
  delivery: Type.Union([Type.Literal("none"), Type.Literal("last-channel")]),
});

export const ClawScheduledJobsSchema = closedObject({
  coverage: Type.Literal("package-declarations"),
  jobs: Type.Array(
    closedObject({
      id: NonEmptyString,
      action: NonEmptyString,
      blocked: Type.Boolean(),
      current: Type.Optional(ClawScheduledDeclarationSchema),
      proposed: Type.Optional(ClawScheduledDeclarationSchema),
    }),
  ),
});

export const ClawLifecyclePlanResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayPlan.v1"),
  operation: Type.Union([Type.Literal("add"), Type.Literal("update"), Type.Literal("remove")]),
  planIntegrity: NonEmptyString,
  target: closedObject({
    agentId: Type.Optional(NonEmptyString),
    name: Type.Optional(NonEmptyString),
    currentVersion: Type.Optional(NonEmptyString),
    targetVersion: Type.Optional(NonEmptyString),
  }),
  actions: Type.Array(
    closedObject({
      kind: NonEmptyString,
      id: NonEmptyString,
      action: NonEmptyString,
      blocked: Type.Boolean(),
      reason: Type.Optional(NonEmptyString),
    }),
  ),
  capabilities: Type.Array(
    closedObject({
      kind: NonEmptyString,
      id: NonEmptyString,
      action: NonEmptyString,
      reason: NonEmptyString,
    }),
  ),
  pluginReviews: Type.Array(ClawPluginReviewSchema),
  skillReviews: Type.Array(ClawSkillReviewSchema),
  blockers: Type.Array(
    closedObject({
      code: NonEmptyString,
      path: NonEmptyString,
      message: NonEmptyString,
    }),
  ),
  trustWarning: Type.Optional(NonEmptyString),
  riskAcknowledgementRequired: Type.Boolean(),
  configuredAccess: Type.Optional(ClawConfiguredAccessSchema),
  scheduledJobs: Type.Optional(ClawScheduledJobsSchema),
  readiness: Type.Optional(
    closedObject({
      ready: Type.Boolean(),
      requirements: Type.Array(
        closedObject({
          kind: Type.Union([
            Type.Literal("environment"),
            Type.Literal("oauth"),
            Type.Literal("plugin-setup"),
          ]),
          owner: NonEmptyString,
        }),
      ),
    }),
  ),
});

export type ClawsCatalogSearchParams = Static<typeof ClawsCatalogSearchParamsSchema>;
export type ClawsCatalogEntry = Static<typeof ClawsCatalogEntrySchema>;
export type ClawsCatalogSearchResult = Static<typeof ClawsCatalogSearchResultSchema>;
export type ClawsCatalogDetailParams = Static<typeof ClawsCatalogDetailParamsSchema>;
export type ClawsCatalogDetailResult = Static<typeof ClawsCatalogDetailResultSchema>;
export type ClawsStatusParams = Static<typeof ClawsStatusParamsSchema>;
export type ClawResourceStatus = Static<typeof ClawResourceStatusSchema>;
export type ClawStatusEntry = Static<typeof ClawStatusEntrySchema>;
export type ClawsStatusResult = Static<typeof ClawsStatusResultSchema>;
export type ClawsAddApplyParams = Static<typeof ClawsAddApplyParamsSchema>;
export type ClawsAddPlanParams = Static<typeof ClawsAddPlanParamsSchema>;
export type ClawsUpdatePlanParams = Static<typeof ClawsUpdatePlanParamsSchema>;
export type ClawsUpdateApplyParams = Static<typeof ClawsUpdateApplyParamsSchema>;
export type ClawsRemovePlanParams = Static<typeof ClawsRemovePlanParamsSchema>;
export type ClawsRemoveApplyParams = Static<typeof ClawsRemoveApplyParamsSchema>;
export type ClawPluginReview = Static<typeof ClawPluginReviewSchema>;
export type ClawPluginAcknowledgement = Static<typeof ClawPluginAcknowledgementSchema>;
export type ClawSkillReview = Static<typeof ClawSkillReviewSchema>;
export type ClawSkillAcknowledgement = Static<typeof ClawSkillAcknowledgementSchema>;
export type ClawConfiguredAccess = Static<typeof ClawConfiguredAccessSchema>;
export type ClawScheduledJobs = Static<typeof ClawScheduledJobsSchema>;
export type ClawLifecyclePlanResult = Static<typeof ClawLifecyclePlanResultSchema>;
