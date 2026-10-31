import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { PluginDeclaredSurfaceSchema, PluginOperatorGrantsSchema } from "./plugins.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

const TemplatePackageName = Type.String({
  pattern: "^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$",
});
const TemplateArtifactIntegrity = Type.String({ pattern: "^sha256-[A-Za-z0-9+/]{43}=$" });
const TemplateCatalogCoordinateSchema = closedObject({
  packageName: TemplatePackageName,
  version: NonEmptyString,
});

export const TemplatesCatalogSearchParamsSchema = closedObject({
  query: Type.Optional(Type.String({ maxLength: 200 })),
  category: Type.Optional(Type.String({ maxLength: 40 })),
  featured: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const TemplatesCatalogEntrySchema = closedObject({
  packageName: TemplatePackageName,
  displayName: NonEmptyString,
  iconUrl: Type.Optional(NonEmptyString),
  summary: Type.Optional(Type.String()),
  latestVersion: Type.Optional(NonEmptyString),
  channel: Type.Union([Type.Literal("official"), Type.Literal("community")]),
  official: Type.Boolean(),
  ownerHandle: Type.Optional(NonEmptyString),
  downloads: Type.Number({ minimum: 0 }),
  installs: Type.Number({ minimum: 0 }),
  featuredAt: Type.Optional(Type.Number({ minimum: 0 })),
  updatedAtMs: Type.Number({ minimum: 0 }),
});

export const TemplatesCatalogSearchResultSchema = closedObject({
  entries: Type.Array(TemplatesCatalogEntrySchema),
});

const TemplatesCatalogContentsSchema = closedObject({
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

export const TemplatesCatalogDetailParamsSchema = TemplateCatalogCoordinateSchema;
export const TemplatesCatalogDetailSchema = closedObject({
  ...TemplatesCatalogEntrySchema.properties,
  version: NonEmptyString,
  agentName: Type.Optional(NonEmptyString),
  agentDescription: Type.Optional(Type.String()),
  workspaceFiles: Type.Integer({ minimum: 0 }),
  skills: Type.Integer({ minimum: 0 }),
  plugins: Type.Integer({ minimum: 0 }),
  mcpServers: Type.Integer({ minimum: 0 }),
  scheduledJobs: Type.Integer({ minimum: 0 }),
  contents: Type.Optional(TemplatesCatalogContentsSchema),
  scanStatus: Type.Optional(NonEmptyString),
});
export const TemplatesCatalogDetailResultSchema = closedObject({
  detail: TemplatesCatalogDetailSchema,
});
export const TemplatesCatalogPreviewParamsSchema = closedObject({
  ...TemplateCatalogCoordinateSchema.properties,
  kind: stringLiteralUnion(["instruction", "skill"]),
  name: NonEmptyString,
});
export const TemplatesCatalogPreviewResultSchema = closedObject({
  preview: closedObject({
    kind: stringLiteralUnion(["instruction", "skill"]),
    name: NonEmptyString,
    content: Type.String(),
  }),
});

export const TemplatesStatusParamsSchema = closedObject({
  target: Type.Optional(NonEmptyString),
});

export const TemplateResourceStatusSchema = closedObject({
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
  origin: Type.Optional(stringLiteralUnion(["template-introduced", "pre-existing"])),
  independentOwner: Type.Optional(Type.Boolean()),
});

export const TemplateStatusEntrySchema = closedObject({
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
  resources: Type.Array(TemplateResourceStatusSchema),
});

export const TemplatesStatusResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.templatesGatewayStatus.v1"),
  records: Type.Array(TemplateStatusEntrySchema),
  summary: closedObject({
    templates: Type.Integer({ minimum: 0 }),
    healthy: Type.Integer({ minimum: 0 }),
    attention: Type.Integer({ minimum: 0 }),
    managed: Type.Integer({ minimum: 0 }),
    referenced: Type.Integer({ minimum: 0 }),
  }),
});

export const TemplatePluginGrantsByIdSchema = Type.Record(
  NonEmptyString,
  PluginOperatorGrantsSchema,
);

export const TemplatePluginReviewSchema = closedObject({
  actionId: NonEmptyString,
  pluginId: NonEmptyString,
  ref: NonEmptyString,
  version: NonEmptyString,
  ownerAction: stringLiteralUnion(["install", "reuse"]),
  integrity: TemplateArtifactIntegrity,
  declaredCapabilities: PluginDeclaredSurfaceSchema,
  capabilityGrants: PluginOperatorGrantsSchema,
  capabilityGrantsByPluginId: TemplatePluginGrantsByIdSchema,
  reviewToken: NonEmptyString,
  riskWarning: Type.Optional(NonEmptyString),
});

export const TemplatePluginAcknowledgementSchema = closedObject({
  actionId: NonEmptyString,
  pluginId: NonEmptyString,
  reviewToken: NonEmptyString,
  capabilityGrants: PluginOperatorGrantsSchema,
  capabilityGrantsByPluginId: TemplatePluginGrantsByIdSchema,
  acknowledgeRiskWarning: Type.Optional(Type.Literal(true)),
});

export const TemplateSkillReviewSchema = closedObject({
  actionId: NonEmptyString,
  ref: NonEmptyString,
  version: NonEmptyString,
  integrity: NonEmptyString,
  riskWarning: NonEmptyString,
  reviewToken: NonEmptyString,
});

export const TemplateSkillAcknowledgementSchema = closedObject({
  actionId: NonEmptyString,
  ref: NonEmptyString,
  reviewToken: NonEmptyString,
  acknowledgeRiskWarning: Type.Literal(true),
});

export const TemplatesAddPlanParamsSchema = closedObject({
  source: TemplateCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
});

export const TemplatesAddApplyParamsSchema = closedObject({
  source: TemplateCatalogCoordinateSchema,
  agentId: Type.Optional(NonEmptyString),
  planIntegrity: Type.Optional(NonEmptyString),
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
  acknowledgeCapabilities: Type.Optional(Type.Array(TemplatePluginAcknowledgementSchema)),
  acknowledgeSkillWarnings: Type.Optional(Type.Array(TemplateSkillAcknowledgementSchema)),
});

export const TemplatesUpdatePlanParamsSchema = closedObject({
  agentId: NonEmptyString,
  source: TemplateCatalogCoordinateSchema,
});

export const TemplatesUpdateApplyParamsSchema = closedObject({
  agentId: NonEmptyString,
  source: TemplateCatalogCoordinateSchema,
  planIntegrity: NonEmptyString,
  acknowledgeClawHubRisk: Type.Optional(Type.Boolean()),
  acknowledgeCapabilities: Type.Optional(Type.Array(TemplatePluginAcknowledgementSchema)),
  acknowledgeSkillWarnings: Type.Optional(Type.Array(TemplateSkillAcknowledgementSchema)),
});

export const TemplatesRemovePlanParamsSchema = closedObject({ agentId: NonEmptyString });
export const TemplatesRemoveApplyParamsSchema = closedObject({
  agentId: NonEmptyString,
  planIntegrity: NonEmptyString,
});

const TemplateMemorySourceSchema = stringLiteralUnion(["memory", "sessions"]);

const TemplateConfiguredAccessSnapshotSchema = closedObject({
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
      indexedSources: Type.Array(TemplateMemorySourceSchema),
      searchSources: Type.Array(TemplateMemorySourceSchema),
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

export const TemplateConfiguredAccessSchema = closedObject({
  coverage: Type.Literal("configuration-only"),
  current: Type.Optional(TemplateConfiguredAccessSnapshotSchema),
  desired: Type.Optional(TemplateConfiguredAccessSnapshotSchema),
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

const TemplateScheduledDeclarationSchema = closedObject({
  schedule: Type.Union([
    closedObject({ cron: NonEmptyString, timezone: NonEmptyString }),
    closedObject({ everyMs: Type.Integer({ minimum: 1 }) }),
  ]),
  session: stringLiteralUnion(["main", "isolated"]),
  delivery: stringLiteralUnion(["none", "last-channel", "owner"]),
  messageDigest: NonEmptyString,
});

const TemplateProposedScheduledDeclarationSchema = closedObject({
  ...TemplateScheduledDeclarationSchema.properties,
  message: NonEmptyString,
});

export const TemplateScheduledJobsSchema = closedObject({
  coverage: Type.Literal("package-declarations"),
  jobs: Type.Array(
    closedObject({
      id: NonEmptyString,
      action: NonEmptyString,
      blocked: Type.Boolean(),
      current: Type.Optional(TemplateScheduledDeclarationSchema),
      proposed: Type.Optional(TemplateProposedScheduledDeclarationSchema),
    }),
  ),
});

const TemplateOwnershipEffectSchema = closedObject({
  relationship: stringLiteralUnion(["managed", "referenced"]),
  origin: stringLiteralUnion(["template-introduced", "pre-existing"]),
  independentOwner: Type.Boolean(),
  affectedTemplateCount: Type.Integer({ minimum: 0 }),
});

const TemplateSkillArtifactSchema = closedObject({
  source: Type.Literal("clawhub"),
  ref: NonEmptyString,
  version: NonEmptyString,
  integrity: TemplateArtifactIntegrity,
});

const TemplateMcpDeclarationSchema = closedObject({
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

export const TemplateActionEffectSchema = Type.Union([
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
    proposed: Type.Optional(TemplateMcpDeclarationSchema),
    ownership: Type.Optional(TemplateOwnershipEffectSchema),
  }),
  closedObject({
    type: Type.Literal("ownership"),
    ...TemplateOwnershipEffectSchema.properties,
  }),
  closedObject({
    type: Type.Literal("skill-package"),
    current: Type.Optional(TemplateSkillArtifactSchema),
    desired: Type.Optional(TemplateSkillArtifactSchema),
    ownership: Type.Optional(TemplateOwnershipEffectSchema),
  }),
]);

export const TemplateManifestDisclosureSchema = closedObject({
  source: closedObject({
    packageName: TemplatePackageName,
    version: NonEmptyString,
    integrity: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
    byteLength: Type.Integer({ minimum: 1 }),
  }),
  manifestJson: NonEmptyString,
  openClawProfileJson: Type.Optional(NonEmptyString),
});

export const TemplateLifecyclePlanResultSchema = closedObject({
  schemaVersion: Type.Literal("openclaw.templatesGatewayPlan.v1"),
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
      effect: Type.Optional(TemplateActionEffectSchema),
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
  pluginReviews: Type.Array(TemplatePluginReviewSchema),
  skillReviews: Type.Array(TemplateSkillReviewSchema),
  blockers: Type.Array(
    closedObject({
      code: NonEmptyString,
      path: NonEmptyString,
      message: NonEmptyString,
    }),
  ),
  trustWarning: Type.Optional(NonEmptyString),
  manifestDisclosure: Type.Optional(TemplateManifestDisclosureSchema),
  riskAcknowledgementRequired: Type.Boolean(),
  configuredAccess: Type.Optional(TemplateConfiguredAccessSchema),
  scheduledJobs: Type.Optional(TemplateScheduledJobsSchema),
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

export type TemplatesCatalogSearchParams = Static<typeof TemplatesCatalogSearchParamsSchema>;
export type TemplatesCatalogEntry = Static<typeof TemplatesCatalogEntrySchema>;
export type TemplatesCatalogSearchResult = Static<typeof TemplatesCatalogSearchResultSchema>;
export type TemplatesCatalogDetailParams = Static<typeof TemplatesCatalogDetailParamsSchema>;
export type TemplatesCatalogDetailResult = Static<typeof TemplatesCatalogDetailResultSchema>;
export type TemplatesCatalogPreviewParams = Static<typeof TemplatesCatalogPreviewParamsSchema>;
export type TemplatesCatalogPreviewResult = Static<typeof TemplatesCatalogPreviewResultSchema>;
export type TemplatesStatusParams = Static<typeof TemplatesStatusParamsSchema>;
export type TemplateResourceStatus = Static<typeof TemplateResourceStatusSchema>;
export type TemplateStatusEntry = Static<typeof TemplateStatusEntrySchema>;
export type TemplatesStatusResult = Static<typeof TemplatesStatusResultSchema>;
export type TemplatesAddApplyParams = Static<typeof TemplatesAddApplyParamsSchema>;
export type TemplatesAddPlanParams = Static<typeof TemplatesAddPlanParamsSchema>;
export type TemplatesUpdatePlanParams = Static<typeof TemplatesUpdatePlanParamsSchema>;
export type TemplatesUpdateApplyParams = Static<typeof TemplatesUpdateApplyParamsSchema>;
export type TemplatesRemovePlanParams = Static<typeof TemplatesRemovePlanParamsSchema>;
export type TemplatesRemoveApplyParams = Static<typeof TemplatesRemoveApplyParamsSchema>;
export type TemplatePluginReview = Static<typeof TemplatePluginReviewSchema>;
export type TemplatePluginAcknowledgement = Static<typeof TemplatePluginAcknowledgementSchema>;
export type TemplateSkillReview = Static<typeof TemplateSkillReviewSchema>;
export type TemplateSkillAcknowledgement = Static<typeof TemplateSkillAcknowledgementSchema>;
export type TemplateConfiguredAccess = Static<typeof TemplateConfiguredAccessSchema>;
export type TemplateScheduledJobs = Static<typeof TemplateScheduledJobsSchema>;
export type TemplateActionEffect = Static<typeof TemplateActionEffectSchema>;
export type TemplateManifestDisclosure = Static<typeof TemplateManifestDisclosureSchema>;
export type TemplateLifecyclePlanResult = Static<typeof TemplateLifecyclePlanResultSchema>;
