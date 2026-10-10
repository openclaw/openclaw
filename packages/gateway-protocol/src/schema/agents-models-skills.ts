// Gateway Protocol schema module defines protocol validation shapes.
import type { Static } from "typebox";
import { Type } from "typebox";
import { AgentDatabaseAdmissionRefusalSchema } from "./agent-database-admission.js";
import {
  AgentCreatedViaSchema,
  AgentKindSchema,
  AgentOwnershipSchema,
} from "./agent-summary-enums.js";
import { AgentsListPlacementProperties } from "./agents-list-session-placement.js";
import { closedObject } from "./closed-object.js";
import {
  GatewayAgentRuntimeSchema,
  GatewayThinkingLevelOptionSchema,
} from "./model-runtime-options.js";
import { NonEmptyString, Sha256String } from "./primitives.js";
import { GitHubSetupHandleSchema } from "./secrets.js";
import { SessionPermissionModeSchema } from "./sessions-row.js";
import { SkillsDetailResultSchema } from "./skill-detail.js";

export { SkillsDetailResultSchema } from "./skill-detail.js";
export { AgentKindSchema, AgentOwnershipSchema };
export { AgentsListParamsSchema, type AgentsListParams } from "./agents-list-session-placement.js";

export { SkillsSearchParamsSchema, SkillsSearchResultSchema } from "./skills-search.js";
export type { SkillsSearchParams, SkillsSearchResult } from "./skills-search.js";

export {
  ModelChoiceSchema,
  ModelRuntimeChoiceSchema,
  ModelCatalogProviderOutcomeSchema,
  ModelsListParamsSchema,
  ModelsListResultSchema,
} from "./model-catalog.js";
export type {
  ModelChoice,
  ModelRuntimeChoice,
  ModelCatalogProviderOutcome,
  ModelsListParams,
  ModelsListResult,
} from "./model-catalog.js";

/**
 * Agent, model, skill, and effective tool schemas.
 *
 * These contracts back dashboard selectors, agent management, model catalogs,
 * skill upload/install flows, skill workshop proposals, and effective tool
 * discovery. Keep public request/result schemas documented because they are
 * shared by gateway RPC, CLI, and UI clients.
 */

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
  // Configured posture for display only, never an authorization decision.
  defaultPermissionMode: Type.Optional(SessionPermissionModeSchema),
});

export const AgentsListResultSchema = closedObject({
  ...AgentsListPlacementProperties,
  defaultId: NonEmptyString,
  ownership: Type.Optional(AgentOwnershipSchema),
  selectionRequired: Type.Optional(Type.Boolean()),
  mainKey: NonEmptyString,
  scope: Type.Union([Type.Literal("per-sender"), Type.Literal("global")]),
  agents: Type.Array(AgentSummarySchema),
});

/** Creates a configured agent; the server supplies an omitted workspace. */
export const AgentsCreateParamsSchema = closedObject({
  name: NonEmptyString,
  workspace: Type.Optional(NonEmptyString),
  model: Type.Optional(NonEmptyString),
  emoji: Type.Optional(Type.String()),
  avatar: Type.Optional(Type.String()),
});

/** Result returned after creating an agent. */
export const AgentsCreateResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  name: NonEmptyString,
  workspace: NonEmptyString,
  model: Type.Optional(NonEmptyString),
});

/** Updates mutable agent identity, workspace, and model fields; null clears the model override. */
export const AgentsUpdateParamsSchema = closedObject({
  agentId: NonEmptyString,
  name: Type.Optional(NonEmptyString),
  workspace: Type.Optional(NonEmptyString),
  model: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
  /** Exact catalog runtime for a model-only selection; native authentication stays with it. */
  agentRuntime: Type.Optional(NonEmptyString),
  emoji: Type.Optional(Type.String()),
  avatar: Type.Optional(Type.String()),
});

/** Result returned after updating an agent. */
export const AgentsUpdateResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
});

/** Deletes an agent and optionally its workspace/config files. */
export const AgentsDeleteParamsSchema = closedObject({
  agentId: NonEmptyString,
  deleteFiles: Type.Optional(Type.Boolean()),
});

/** Result returned after deleting an agent and unbinding sessions. */
export const AgentsDeleteResultSchema = closedObject({
  ok: Type.Literal(true),
  agentId: NonEmptyString,
  removedBindings: Type.Integer({ minimum: 0 }),
  removed: Type.Optional(
    Type.Array(
      closedObject({
        path: NonEmptyString,
        method: Type.Union([Type.Literal("trash"), Type.Literal("missing")]),
      }),
    ),
  ),
  failed: Type.Optional(
    Type.Array(
      closedObject({
        path: NonEmptyString,
        reason: NonEmptyString,
      }),
    ),
  ),
  purgeFailed: Type.Optional(Type.Literal(true)),
});

/** Reads model-provider credential health for one configured agent. */
export const ModelsAuthStatusParamsSchema = closedObject({
  refresh: Type.Optional(Type.Boolean()),
  agentId: Type.Optional(Type.String()),
});

/** Rebuilds Gateway auth state after a credential or selection mutation. */
export const ModelsAuthRefreshParamsSchema = closedObject({
  operation: Type.Union([Type.Literal("login"), Type.Literal("logout"), Type.Literal("update")]),
  agentId: Type.Optional(Type.String()),
});

/** Saves a model-provider API key without changing model selection. */
export const ModelsAuthSetApiKeyParamsSchema = Type.Object(
  {
    provider: Type.String({ pattern: "\\S" }),
    apiKey: Type.String({ pattern: "\\S" }),
    agentId: Type.Optional(Type.String()),
  },
  // Existing wire clients may send extra fields; the handler ignores them.
  { additionalProperties: true },
);

export const ModelsAuthSetApiKeyResultSchema = closedObject({
  provider: NonEmptyString,
  profileId: NonEmptyString,
  warning: Type.Optional(Type.String()),
});

/** Removes saved model-provider credentials from one configured agent. */
export const ModelsAuthLogoutParamsSchema = closedObject({
  provider: NonEmptyString,
  profileIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1 })),
  credentialType: Type.Optional(Type.Literal("api_key")),
  agentId: Type.Optional(Type.String()),
});

/** Sets or clears the preferred auth-profile order for one provider and agent. */
export const ModelsAuthOrderSetParamsSchema = closedObject({
  provider: NonEmptyString,
  profileIds: Type.Optional(Type.Array(NonEmptyString, { minItems: 1, uniqueItems: true })),
  agentId: Type.Optional(Type.String()),
});

/** Runs a bounded live credential probe for one model provider. */
export const ModelsProbeParamsSchema = closedObject({
  provider: NonEmptyString,
  profileId: Type.Optional(NonEmptyString),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
  agentId: Type.Optional(Type.String()),
});

export const AuthProbeStatusSchema = Type.Union([
  Type.Literal("ok"),
  Type.Literal("auth"),
  Type.Literal("rate_limit"),
  Type.Literal("billing"),
  Type.Literal("timeout"),
  Type.Literal("format"),
  Type.Literal("unknown"),
  Type.Literal("no_model"),
]);

/** Secret-free result for one provider credential target. */
export const ModelsProbeTargetResultSchema = closedObject({
  profileId: Type.Optional(NonEmptyString),
  label: NonEmptyString,
  status: AuthProbeStatusSchema,
  latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
});

/** Provider-level live probe rollup plus per-credential results. */
export const ModelsProbeResultSchema = closedObject({
  provider: NonEmptyString,
  status: AuthProbeStatusSchema,
  latencyMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(Type.String()),
  results: Type.Array(ModelsProbeTargetResultSchema),
});

/** Reads installed skill status, optionally for a selected agent. */
export const SkillsStatusParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
});

/** Empty request payload for listing available skill bins. */
export const SkillsBinsParamsSchema = closedObject({});

/** Skill bin names available to the gateway. */
export const SkillsBinsResultSchema = closedObject({
  bins: Type.Array(NonEmptyString),
});

const SkillUploadIdempotencyKeyString = Type.String({
  minLength: 1,
  maxLength: 2048,
});
const SkillUploadDataBase64String = Type.String({
  minLength: 1,
  maxLength: 5_592_408,
});

/** Starts a chunked skill archive upload. */
export const SkillsUploadBeginParamsSchema = closedObject({
  kind: Type.Literal("skill-archive"),
  slug: NonEmptyString,
  sizeBytes: Type.Integer({ minimum: 1 }),
  sha256: Type.Optional(Sha256String),
  force: Type.Optional(Type.Boolean()),
  idempotencyKey: Type.Optional(SkillUploadIdempotencyKeyString),
});

/** Uploads one base64-encoded chunk for a skill archive. */
export const SkillsUploadChunkParamsSchema = closedObject({
  uploadId: NonEmptyString,
  offset: Type.Integer({ minimum: 0 }),
  dataBase64: SkillUploadDataBase64String,
});

/** Commits a completed skill archive upload. */
export const SkillsUploadCommitParamsSchema = closedObject({
  uploadId: NonEmptyString,
  sha256: Type.Optional(Sha256String),
});

/**
 * ClawHub resolves a bare slug against every publisher, so requests that carry only the slug
 * fail with 409 AMBIGUOUS_SKILL_SLUG once two publishers share it. Clients send the reference
 * `skills.search` returned for the entry the operator picked.
 */
const CLAWHUB_SKILL_REF_DESCRIPTION =
  "ClawHub skill reference: `@owner/slug`, `skills-sh:owner/repo/slug`, or a bare `slug` when no publisher is known.";

/** Installs a skill from legacy install id, ClawHub, or uploaded archive. */
export const SkillsInstallParamsSchema = Type.Union([
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    name: NonEmptyString,
    installId: NonEmptyString,
    dangerouslyForceUnsafeInstall: Type.Optional(
      Type.Boolean({
        deprecated: true,
        description:
          "Deprecated compatibility field. Current servers ignore it; install policy is controlled by security.installPolicy.",
      }),
    ),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  }),
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    source: Type.Literal("clawhub"),
    slug: Type.String({ minLength: 1, description: CLAWHUB_SKILL_REF_DESCRIPTION }),
    version: Type.Optional(NonEmptyString),
    force: Type.Optional(Type.Boolean()),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  }),
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    source: Type.Literal("upload"),
    uploadId: NonEmptyString,
    slug: NonEmptyString,
    force: Type.Optional(Type.Boolean()),
    sha256: Type.Optional(Sha256String),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000 })),
  }),
]);

/** Updates installed skill settings or refreshes ClawHub-installed skills. */
export const SkillsUpdateParamsSchema = Type.Union([
  closedObject({
    skillKey: NonEmptyString,
    enabled: Type.Optional(Type.Boolean()),
    apiKey: Type.Optional(Type.String()),
    env: Type.Optional(Type.Record(NonEmptyString, Type.String())),
  }),
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    source: Type.Literal("clawhub"),
    slug: Type.Optional(NonEmptyString),
    all: Type.Optional(Type.Boolean()),
    force: Type.Optional(Type.Boolean()),
  }),
]);

/** Reads registry detail for one skill. */
export const SkillsDetailParamsSchema = closedObject({
  slug: Type.String({ minLength: 1, description: CLAWHUB_SKILL_REF_DESCRIPTION }),
  version: Type.Optional(NonEmptyString),
});

/** Reads current security verdicts for configured skills. */
export const SkillsSecurityVerdictsParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

/** Security verdict report for installed/requested skills. */
export const SkillsSecurityVerdictsResultSchema = closedObject({
  schema: Type.Literal("openclaw.skills.security-verdicts.v1"),
  items: Type.Array(
    closedObject({
      registry: NonEmptyString,
      ok: Type.Boolean(),
      decision: NonEmptyString,
      reasons: Type.Array(Type.String()),
      requestedSlug: NonEmptyString,
      requestedOwnerHandle: Type.Optional(NonEmptyString),
      requestedVersion: NonEmptyString,
      slug: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
      version: Type.Optional(Type.Union([NonEmptyString, Type.Null()])),
      displayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      publisherHandle: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      publisherDisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      createdAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
      checkedAt: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
      skillUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      securityAuditUrl: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      securityStatus: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      securityPassed: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
      error: Type.Optional(
        closedObject({
          code: Type.Optional(Type.String()),
          message: Type.Optional(Type.String()),
        }),
      ),
    }),
  ),
});

/** Reads the rendered skill card for one installed skill. */
export const SkillsSkillCardParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  skillKey: NonEmptyString,
});

/** Rendered skill card content and file metadata. */
export const SkillsSkillCardResultSchema = closedObject({
  schema: Type.Literal("openclaw.skills.skill-card.v1"),
  skillKey: NonEmptyString,
  path: NonEmptyString,
  sizeBytes: Type.Integer({ minimum: 0 }),
  content: Type.String(),
});

const SkillWorkshopChangeActionSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("patch"),
  Type.Literal("write_file"),
  Type.Literal("remove_file"),
  Type.Literal("archive"),
  Type.Literal("restore"),
]);
const SkillWorkshopActorSchema = Type.Union([
  Type.Literal("agent"),
  Type.Literal("review"),
  Type.Literal("curator"),
  Type.Literal("user"),
]);
const TimestampMsSchema = Type.Number({ minimum: 0 });

/** One applied Workshop change; `versionId` names the snapshot taken before it, for undo. */
export const SkillWorkshopChangeSchema = closedObject({
  id: NonEmptyString,
  agentId: NonEmptyString,
  skillName: NonEmptyString,
  action: SkillWorkshopChangeActionSchema,
  actor: SkillWorkshopActorSchema,
  summary: Type.String(),
  versionId: Type.Optional(NonEmptyString),
  sessionKey: Type.Optional(NonEmptyString),
  runId: Type.Optional(NonEmptyString),
  createdAtMs: TimestampMsSchema,
});

/** Live Workshop skill with optional usage counters. */
export const SkillWorkshopSkillSummarySchema = closedObject({
  name: NonEmptyString,
  description: Type.String(),
  updatedAtMs: TimestampMsSchema,
  sizeBytes: Type.Integer({ minimum: 0 }),
  files: Type.Array(NonEmptyString),
  useCount: Type.Optional(Type.Integer({ minimum: 0 })),
  lastUsedAtMs: Type.Optional(TimestampMsSchema),
});

/** Saved versions of one Workshop skill; `live: false` means the skill is archived. */
export const SkillWorkshopArchivedSkillSchema = closedObject({
  name: NonEmptyString,
  live: Type.Boolean(),
  versions: Type.Array(
    closedObject({
      id: NonEmptyString,
      action: SkillWorkshopChangeActionSchema,
      createdAtMs: TimestampMsSchema,
    }),
  ),
});

/** Lists the selected agent's Workshop skills and saved versions. */
export const SkillsWorkshopListParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

export const SkillsWorkshopListResultSchema = closedObject({
  agentId: NonEmptyString,
  mode: Type.Union([Type.Literal("off"), Type.Literal("auto")]),
  root: NonEmptyString,
  skills: Type.Array(SkillWorkshopSkillSummarySchema),
  archived: Type.Array(SkillWorkshopArchivedSkillSchema),
});

/** Pages the Workshop change feed newest first. */
export const SkillsWorkshopChangesParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  beforeMs: Type.Optional(TimestampMsSchema),
});

export const SkillsWorkshopChangesResultSchema = closedObject({
  changes: Type.Array(SkillWorkshopChangeSchema),
});

/** Reads one file of a live Workshop skill, or of a saved version when `versionId` is set. */
export const SkillsWorkshopReadParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  name: NonEmptyString,
  filePath: Type.Optional(NonEmptyString),
  versionId: Type.Optional(NonEmptyString),
});

export const SkillsWorkshopReadResultSchema = closedObject({
  name: NonEmptyString,
  filePath: NonEmptyString,
  content: Type.String(),
  files: Type.Array(NonEmptyString),
});

/** Archives a live Workshop skill; the snapshot stays restorable. */
export const SkillsWorkshopArchiveParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  name: NonEmptyString,
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
});

/** Restores a saved version (newest when omitted); the current live copy is versioned first. */
export const SkillsWorkshopRestoreParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  name: NonEmptyString,
  versionId: Type.Optional(NonEmptyString),
});

export const SkillsWorkshopChangeResultSchema = closedObject({
  change: SkillWorkshopChangeSchema,
});

export const GitHubIdentityScopeSchema = Type.Union([
  Type.Literal("system"),
  Type.Literal("agent"),
]);

export const ToolsGitHubStatusParamsSchema = closedObject({
  agentId: NonEmptyString,
  selectedScope: GitHubIdentityScopeSchema,
});

export const GitHubIdentitySourceSchema = Type.Union([
  Type.Literal("system-detected"),
  Type.Literal("system-configured"),
  Type.Literal("agent-override"),
]);

const GitHubAuthorValueSchema = Type.String({ minLength: 1, pattern: "\\S" });
export const GitHubAuthorSchema = closedObject({
  name: Type.Optional(GitHubAuthorValueSchema),
  email: Type.Optional(GitHubAuthorValueSchema),
});

export const GitHubIdentityFactsSchema = closedObject({
  source: GitHubIdentitySourceSchema,
  credentialKind: Type.Union([
    Type.Literal("native"),
    Type.Literal("managed-pat"),
    Type.Literal("managed-oauth"),
  ]),
  credentialState: Type.Union([
    Type.Literal("available"),
    Type.Literal("unavailable"),
    Type.Literal("configured_unavailable"),
    Type.Literal("unverified"),
    Type.Literal("rate_limited"),
  ]),
  account: Type.Union([
    closedObject({
      login: NonEmptyString,
    }),
    Type.Null(),
  ]),
  gitAuthor: closedObject({
    name: Type.Union([Type.String(), Type.Null()]),
    email: Type.Union([Type.String(), Type.Null()]),
  }),
  evidence: Type.Union([
    Type.Literal("github-api"),
    Type.Literal("none"),
    Type.Literal("unverified"),
    Type.Literal("rate-limited"),
  ]),
  accessExpiresAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  refreshState: Type.Union([
    Type.Literal("not_applicable"),
    Type.Literal("available"),
    Type.Literal("expired"),
    Type.Literal("unavailable"),
    Type.Literal("refreshing"),
    Type.Literal("failed"),
  ]),
  oauthScopes: Type.Array(Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" }), {
    maxItems: 32,
  }),
  repositoryGrants: Type.Literal("unknown"),
});

export const GitHubSelectedIdentitySchema = closedObject({
  scope: GitHubIdentityScopeSchema,
  configured: Type.Boolean(),
  identity: Type.Union([GitHubIdentityFactsSchema, Type.Null()]),
});

export const ToolsGitHubStatusResultSchema = closedObject({
  agentId: NonEmptyString,
  selectedScope: GitHubIdentityScopeSchema,
  selected: GitHubSelectedIdentitySchema,
  effective: GitHubIdentityFactsSchema,
});

export const ToolsGitHubManagedConfigureParamsSchema = closedObject({
  scope: GitHubIdentityScopeSchema,
  agentId: NonEmptyString,
  mode: Type.Literal("managed"),
  secretName: GitHubSetupHandleSchema,
  gitAuthor: Type.Optional(GitHubAuthorSchema),
});

export const ToolsGitHubInheritConfigureParamsSchema = closedObject({
  scope: GitHubIdentityScopeSchema,
  agentId: NonEmptyString,
  mode: Type.Literal("inherit"),
});

export const ToolsGitHubConfigureParamsSchema = Type.Union([
  ToolsGitHubManagedConfigureParamsSchema,
  ToolsGitHubInheritConfigureParamsSchema,
]);

const GitHubDeviceRequestIdSchema = Type.String({
  pattern: "^github-device-[a-f0-9]{32}$",
});

export const ToolsGitHubAuthorizeStartParamsSchema = closedObject({
  scope: GitHubIdentityScopeSchema,
  agentId: NonEmptyString,
});

export const ToolsGitHubAuthorizeStartResultSchema = closedObject({
  requestId: GitHubDeviceRequestIdSchema,
  userCode: Type.String({ pattern: "^[A-Z0-9]{4}-[A-Z0-9]{4}$" }),
  verificationUri: Type.Literal("https://github.com/login/device"),
  expiresInMs: Type.Integer({ minimum: 1, maximum: 900_000 }),
  pollAfterMs: Type.Integer({ minimum: 1_000, maximum: 60_000 }),
});

export const ToolsGitHubAuthorizePollParamsSchema = closedObject({
  requestId: GitHubDeviceRequestIdSchema,
});

export const ToolsGitHubAuthorizePendingResultSchema = closedObject({
  status: Type.Literal("pending"),
  retryAfterMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
});

export const ToolsGitHubAuthorizeSlowDownResultSchema = closedObject({
  status: Type.Literal("slow_down"),
  retryAfterMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
});

export const ToolsGitHubAuthorizeAccessDeniedResultSchema = closedObject({
  status: Type.Literal("access_denied"),
});

export const ToolsGitHubAuthorizeExpiredResultSchema = closedObject({
  status: Type.Literal("expired"),
});

export const ToolsGitHubAuthorizeIncorrectDeviceCodeResultSchema = closedObject({
  status: Type.Literal("incorrect_device_code"),
});

export const ToolsGitHubAuthorizeNetworkErrorResultSchema = closedObject({
  status: Type.Literal("network_error"),
  retryAfterMs: Type.Integer({ minimum: 1, maximum: 60_000 }),
});

export const ToolsGitHubAuthorizeFailedResultSchema = closedObject({
  status: Type.Literal("failed"),
  reason: Type.Union([Type.Literal("identity_changed"), Type.Literal("setup_failed")]),
});

export const ToolsGitHubAuthorizeSuccessResultSchema = closedObject({
  status: Type.Literal("success"),
  githubStatus: ToolsGitHubStatusResultSchema,
});

export const ToolsGitHubAuthorizePollResultSchema = Type.Union([
  ToolsGitHubAuthorizePendingResultSchema,
  ToolsGitHubAuthorizeSlowDownResultSchema,
  ToolsGitHubAuthorizeAccessDeniedResultSchema,
  ToolsGitHubAuthorizeExpiredResultSchema,
  ToolsGitHubAuthorizeIncorrectDeviceCodeResultSchema,
  ToolsGitHubAuthorizeNetworkErrorResultSchema,
  ToolsGitHubAuthorizeFailedResultSchema,
  ToolsGitHubAuthorizeSuccessResultSchema,
]);

export const ToolsGitHubAuthorizeCancelParamsSchema = closedObject({
  requestId: GitHubDeviceRequestIdSchema,
});

export const ToolsGitHubAuthorizeCancelResultSchema = closedObject({
  cancelled: Type.Boolean(),
});

/** Invokes one tool through the gateway tool dispatcher. */
export const ToolsInvokeParamsSchema = closedObject({
  name: NonEmptyString,
  args: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  confirm: Type.Optional(Type.Boolean()),
  idempotencyKey: Type.Optional(NonEmptyString),
  /**
   * Explicit operation-local marker for an authenticated direct operator.
   * Missing values remain delegated, and agent runtime identity wins server-side.
   */
  conversationReadOrigin: Type.Optional(Type.Literal("direct-operator")),
});

/** Normalized error shape for tool invocation failures. */
export const ToolsInvokeErrorSchema = closedObject({
  code: NonEmptyString,
  message: NonEmptyString,
  details: Type.Optional(Type.Unknown()),
});

/** Tool invocation result, including approval handoff when required. */
export const ToolsInvokeResultSchema = closedObject({
  ok: Type.Boolean(),
  toolName: NonEmptyString,
  output: Type.Optional(Type.Unknown()),
  requiresApproval: Type.Optional(Type.Boolean()),
  approvalId: Type.Optional(NonEmptyString),
  source: Type.Optional(
    Type.Union([
      Type.Literal("core"),
      Type.Literal("plugin"),
      Type.Literal("mcp"),
      Type.Literal("channel"),
      Type.String(),
    ]),
  ),
  error: Type.Optional(ToolsInvokeErrorSchema),
});

// Wire types derive directly from local schema consts so public d.ts graphs never
// pull in the ProtocolSchemas registry.
export type AgentKind = Static<typeof AgentKindSchema>;
export type AgentSummary = Static<typeof AgentSummarySchema>;
export type GatewayAgentRuntime = Static<typeof GatewayAgentRuntimeSchema>;
export type AgentsCreateParams = Static<typeof AgentsCreateParamsSchema>;
export type AgentsCreateResult = Static<typeof AgentsCreateResultSchema>;
export type AgentsUpdateParams = Static<typeof AgentsUpdateParamsSchema>;
export type AgentsUpdateResult = Static<typeof AgentsUpdateResultSchema>;
export type AgentsDeleteParams = Static<typeof AgentsDeleteParamsSchema>;
export type AgentsDeleteResult = Static<typeof AgentsDeleteResultSchema>;
export type AgentsListResult = Static<typeof AgentsListResultSchema>;
export type ModelsAuthSetApiKeyParams = Static<typeof ModelsAuthSetApiKeyParamsSchema>;
export type ModelsAuthSetApiKeyResult = Static<typeof ModelsAuthSetApiKeyResultSchema>;
export type ModelsAuthStatusParams = Static<typeof ModelsAuthStatusParamsSchema>;
export type ModelsAuthLogoutParams = Static<typeof ModelsAuthLogoutParamsSchema>;
export type ModelsAuthOrderSetParams = Static<typeof ModelsAuthOrderSetParamsSchema>;
export type ModelsAuthRefreshParams = Static<typeof ModelsAuthRefreshParamsSchema>;
export type AuthProbeStatus = Static<typeof AuthProbeStatusSchema>;
export type ModelsProbeParams = Static<typeof ModelsProbeParamsSchema>;
export type ModelsProbeTargetResult = Static<typeof ModelsProbeTargetResultSchema>;
export type ModelsProbeResult = Static<typeof ModelsProbeResultSchema>;
export type SkillsStatusParams = Static<typeof SkillsStatusParamsSchema>;
export type GitHubIdentityFacts = Static<typeof GitHubIdentityFactsSchema>;
export type GitHubSelectedIdentity = Static<typeof GitHubSelectedIdentitySchema>;
export type ToolsGitHubStatusParams = Static<typeof ToolsGitHubStatusParamsSchema>;
export type ToolsGitHubStatusResult = Static<typeof ToolsGitHubStatusResultSchema>;
export type ToolsGitHubManagedConfigureParams = Static<
  typeof ToolsGitHubManagedConfigureParamsSchema
>;
export type ToolsGitHubInheritConfigureParams = Static<
  typeof ToolsGitHubInheritConfigureParamsSchema
>;
export type ToolsGitHubConfigureParams = Static<typeof ToolsGitHubConfigureParamsSchema>;
export type ToolsGitHubAuthorizeStartParams = Static<typeof ToolsGitHubAuthorizeStartParamsSchema>;
export type ToolsGitHubAuthorizeStartResult = Static<typeof ToolsGitHubAuthorizeStartResultSchema>;
export type ToolsGitHubAuthorizePollParams = Static<typeof ToolsGitHubAuthorizePollParamsSchema>;
export type ToolsGitHubAuthorizePollResult = Static<typeof ToolsGitHubAuthorizePollResultSchema>;
export type ToolsGitHubAuthorizeCancelParams = Static<
  typeof ToolsGitHubAuthorizeCancelParamsSchema
>;
export type ToolsGitHubAuthorizeCancelResult = Static<
  typeof ToolsGitHubAuthorizeCancelResultSchema
>;
export type ToolsInvokeParams = Static<typeof ToolsInvokeParamsSchema>;
export type ToolsInvokeResult = Static<typeof ToolsInvokeResultSchema>;
export type SkillsBinsParams = Static<typeof SkillsBinsParamsSchema>;
export type SkillsBinsResult = Static<typeof SkillsBinsResultSchema>;
export type SkillsDetailParams = Static<typeof SkillsDetailParamsSchema>;
export type SkillsDetailResult = Static<typeof SkillsDetailResultSchema>;
export type SkillWorkshopChange = Static<typeof SkillWorkshopChangeSchema>;
export type SkillWorkshopSkillSummary = Static<typeof SkillWorkshopSkillSummarySchema>;
export type SkillWorkshopArchivedSkill = Static<typeof SkillWorkshopArchivedSkillSchema>;
export type SkillsWorkshopListParams = Static<typeof SkillsWorkshopListParamsSchema>;
export type SkillsWorkshopListResult = Static<typeof SkillsWorkshopListResultSchema>;
export type SkillsWorkshopChangesParams = Static<typeof SkillsWorkshopChangesParamsSchema>;
export type SkillsWorkshopChangesResult = Static<typeof SkillsWorkshopChangesResultSchema>;
export type SkillsWorkshopReadParams = Static<typeof SkillsWorkshopReadParamsSchema>;
export type SkillsWorkshopReadResult = Static<typeof SkillsWorkshopReadResultSchema>;
export type SkillsWorkshopArchiveParams = Static<typeof SkillsWorkshopArchiveParamsSchema>;
export type SkillsWorkshopRestoreParams = Static<typeof SkillsWorkshopRestoreParamsSchema>;
export type SkillsWorkshopChangeResult = Static<typeof SkillsWorkshopChangeResultSchema>;
export type SkillsSecurityVerdictsParams = Static<typeof SkillsSecurityVerdictsParamsSchema>;
export type SkillsSecurityVerdictsResult = Static<typeof SkillsSecurityVerdictsResultSchema>;
export type SkillsSkillCardParams = Static<typeof SkillsSkillCardParamsSchema>;
export type SkillsSkillCardResult = Static<typeof SkillsSkillCardResultSchema>;
export type SkillsUploadBeginParams = Static<typeof SkillsUploadBeginParamsSchema>;
export type SkillsUploadChunkParams = Static<typeof SkillsUploadChunkParamsSchema>;
export type SkillsUploadCommitParams = Static<typeof SkillsUploadCommitParamsSchema>;
export type SkillsInstallParams = Static<typeof SkillsInstallParamsSchema>;
export type SkillsUpdateParams = Static<typeof SkillsUpdateParamsSchema>;
