import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { PluginDeclaredSurfaceSchema, PluginOperatorGrantsSchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

const OfficialClawName = Type.String({ pattern: "^@openclaw/[a-z0-9][a-z0-9._-]*$" });
const ClawArtifactIntegrity = Type.String({ pattern: "^sha256-[A-Za-z0-9+/]{43}=$" });
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

const ClawsCatalogContentsSchema = closedObject({
  instructions: Type.Array(
    closedObject({
      name: NonEmptyString,
      source: NonEmptyString,
      excerpt: Type.Optional(Type.String()),
    }),
  ),
  skills: Type.Array(
    closedObject({
      name: NonEmptyString,
      version: NonEmptyString,
      excerpt: Type.Optional(Type.String()),
    }),
  ),
  integrations: Type.Array(
    closedObject({
      name: NonEmptyString,
      kind: stringLiteralUnion(["plugin", "mcpServer"]),
      version: Type.Optional(NonEmptyString),
    }),
  ),
  automations: Type.Array(
    closedObject({
      name: NonEmptyString,
      schedule: NonEmptyString,
      timezone: NonEmptyString,
    }),
  ),
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
  contents: Type.Optional(ClawsCatalogContentsSchema),
  scanStatus: Type.Optional(NonEmptyString),
});
export const ClawsCatalogDetailResultSchema = closedObject({ detail: ClawsCatalogDetailSchema });
export const ClawsCatalogPreviewParamsSchema = closedObject({
  ...ClawCatalogCoordinateSchema.properties,
  kind: stringLiteralUnion(["instruction", "skill"]),
  name: NonEmptyString,
});
export const ClawsCatalogPreviewResultSchema = closedObject({
  preview: closedObject({
    kind: stringLiteralUnion(["instruction", "skill"]),
    name: NonEmptyString,
    content: Type.String(),
  }),
});

export const ClawsStatusParamsSchema = closedObject({
  target: Type.Optional(NonEmptyString),
});

export const ClawResourceStatusSchema = closedObject({
  kind: stringLiteralUnion([
    "agent",
    "workspace-file",
    "skill",
    "plugin",
    "mcp-server",
    "cron-job",
  ]),
  id: NonEmptyString,
  state: NonEmptyString,
  reason: Type.Optional(NonEmptyString),
  relationship: Type.Optional(stringLiteralUnion(["managed", "referenced"])),
  origin: Type.Optional(stringLiteralUnion(["claw-introduced", "pre-existing"])),
  independentOwner: Type.Optional(Type.Boolean()),
});

export const ClawStatusEntrySchema = closedObject({
  agentId: NonEmptyString,
  name: NonEmptyString,
  version: NonEmptyString,
  sourceKind: stringLiteralUnion(["package", "development"]),
  status: stringLiteralUnion([
    "pending",
    "workspace_ready",
    "config_committed",
    "complete",
    "partial",
  ]),
  agentState: stringLiteralUnion(["present", "modified", "missing"]),
  bootstrapState: stringLiteralUnion([
    "pending",
    "complete",
    "missing",
    "modified",
    "unsafe",
    "unknown",
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

export const ClawPluginGrantsByIdSchema = Type.Record(NonEmptyString, PluginOperatorGrantsSchema);

export const ClawPluginReviewSchema = closedObject({
  actionId: NonEmptyString,
  pluginId: NonEmptyString,
  ref: NonEmptyString,
  version: NonEmptyString,
  ownerAction: stringLiteralUnion(["install", "reuse"]),
  integrity: ClawArtifactIntegrity,
  declaredCapabilities: PluginDeclaredSurfaceSchema,
  capabilityGrants: PluginOperatorGrantsSchema,
  capabilityGrantsByPluginId: ClawPluginGrantsByIdSchema,
  reviewToken: NonEmptyString,
  riskWarning: Type.Optional(NonEmptyString),
});

export const ClawPluginAcknowledgementSchema = closedObject({
  actionId: NonEmptyString,
  pluginId: NonEmptyString,
  reviewToken: NonEmptyString,
  capabilityGrants: PluginOperatorGrantsSchema,
  capabilityGrantsByPluginId: ClawPluginGrantsByIdSchema,
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
  planIntegrity: Type.Optional(NonEmptyString),
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

const ClawMemorySourceSchema = stringLiteralUnion(["memory", "sessions"]);

const ClawConfiguredAccessSnapshotSchema = closedObject({
  tools: closedObject({
    allowed: Type.Array(NonEmptyString),
    excluded: Type.Array(NonEmptyString),
    explicitAllow: Type.Array(NonEmptyString),
    explicitDeny: Type.Array(NonEmptyString),
  }),
  sandbox: closedObject({
    mode: stringLiteralUnion(["off", "non-main", "all"]),
    scope: stringLiteralUnion(["session", "agent", "shared"]),
    workspaceAccess: stringLiteralUnion(["none", "ro", "rw"]),
    backend: stringLiteralUnion(["docker", "ssh", "other"]),
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
    stringLiteralUnion([
      "runtime-tools",
      "sandbox-runtime",
      "memory-runtime",
      "subagent-runtime",
      "scheduler-runtime",
    ]),
  ),
});

const ClawScheduledDeclarationSchema = closedObject({
  schedule: closedObject({ cron: NonEmptyString, timezone: NonEmptyString }),
  session: stringLiteralUnion(["main", "isolated"]),
  delivery: stringLiteralUnion(["none", "last-channel"]),
  messageDigest: NonEmptyString,
});

const ClawProposedScheduledDeclarationSchema = closedObject({
  ...ClawScheduledDeclarationSchema.properties,
  message: NonEmptyString,
});

export const ClawScheduledJobsSchema = closedObject({
  coverage: Type.Literal("package-declarations"),
  jobs: Type.Array(
    closedObject({
      id: NonEmptyString,
      action: NonEmptyString,
      blocked: Type.Boolean(),
      current: Type.Optional(ClawScheduledDeclarationSchema),
      proposed: Type.Optional(ClawProposedScheduledDeclarationSchema),
    }),
  ),
});

const ClawOwnershipEffectSchema = closedObject({
  relationship: stringLiteralUnion(["managed", "referenced"]),
  origin: stringLiteralUnion(["claw-introduced", "pre-existing"]),
  independentOwner: Type.Boolean(),
  affectedClawCount: Type.Integer({ minimum: 0 }),
});

const ClawSkillArtifactSchema = closedObject({
  source: Type.Literal("clawhub"),
  ref: NonEmptyString,
  version: NonEmptyString,
  integrity: ClawArtifactIntegrity,
});

const ClawMcpDeclarationSchema = closedObject({
  transport: stringLiteralUnion(["stdio", "sse", "streamable-http"]),
  command: Type.Optional(NonEmptyString),
  arguments: Type.Optional(Type.Array(NonEmptyString)),
  url: Type.Optional(NonEmptyString),
  urlDigest: Type.Optional(NonEmptyString),
  queryParameterNames: Type.Optional(Type.Array(NonEmptyString)),
  environment: Type.Optional(
    Type.Array(closedObject({ name: NonEmptyString, sourceName: NonEmptyString })),
  ),
  authentication: stringLiteralUnion(["none", "oauth"]),
  toolFilter: Type.Optional(
    closedObject({
      include: Type.Optional(Type.Array(NonEmptyString)),
      exclude: Type.Optional(Type.Array(NonEmptyString)),
    }),
  ),
  timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  connectTimeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
});

export const ClawActionEffectSchema = Type.Union([
  closedObject({
    type: Type.Literal("workspace-file"),
    destination: NonEmptyString,
    source: Type.Optional(NonEmptyString),
    currentDigest: Type.Optional(NonEmptyString),
    desiredDigest: Type.Optional(NonEmptyString),
    currentPresent: Type.Optional(Type.Boolean()),
  }),
  closedObject({
    type: Type.Literal("mcp-server"),
    currentDigest: Type.Optional(NonEmptyString),
    desiredDigest: Type.Optional(NonEmptyString),
    proposed: Type.Optional(ClawMcpDeclarationSchema),
    ownership: Type.Optional(ClawOwnershipEffectSchema),
  }),
  closedObject({
    type: Type.Literal("ownership"),
    ...ClawOwnershipEffectSchema.properties,
  }),
  closedObject({
    type: Type.Literal("skill-package"),
    current: Type.Optional(ClawSkillArtifactSchema),
    desired: Type.Optional(ClawSkillArtifactSchema),
    ownership: Type.Optional(ClawOwnershipEffectSchema),
  }),
]);

export const ClawManifestDisclosureSchema = closedObject({
  source: closedObject({
    packageName: OfficialClawName,
    version: NonEmptyString,
    integrity: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    byteLength: Type.Integer({ minimum: 1 }),
  }),
  manifestJson: NonEmptyString,
  openClawProfileJson: Type.Optional(NonEmptyString),
});

export const ClawLifecyclePlanResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.clawsGatewayPlan.v1"),
  operation: stringLiteralUnion(["add", "update", "remove"]),
  planIntegrity: NonEmptyString,
  target: closedObject({
    agentId: Type.Optional(NonEmptyString),
    workspace: Type.Optional(NonEmptyString),
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
      effect: Type.Optional(ClawActionEffectSchema),
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
  manifestDisclosure: Type.Optional(ClawManifestDisclosureSchema),
  riskAcknowledgementRequired: Type.Boolean(),
  configuredAccess: Type.Optional(ClawConfiguredAccessSchema),
  scheduledJobs: Type.Optional(ClawScheduledJobsSchema),
  readiness: Type.Optional(
    closedObject({
      ready: Type.Boolean(),
      requirements: Type.Array(
        closedObject({
          kind: stringLiteralUnion(["environment", "oauth", "plugin-setup"]),
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
export type ClawsCatalogPreviewParams = Static<typeof ClawsCatalogPreviewParamsSchema>;
export type ClawsCatalogPreviewResult = Static<typeof ClawsCatalogPreviewResultSchema>;
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
export type ClawActionEffect = Static<typeof ClawActionEffectSchema>;
export type ClawManifestDisclosure = Static<typeof ClawManifestDisclosureSchema>;
export type ClawLifecyclePlanResult = Static<typeof ClawLifecyclePlanResultSchema>;
