import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";

const managedScope = Type.Union([Type.Literal("system"), Type.Literal("agent")]);
const managedRequestId = Type.String({ pattern: "^gitlab-setup-[a-f0-9]{32}$" });
export const ToolsGitLabStatusParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  selectedScope: Type.Optional(managedScope),
});
export const ToolsGitLabConfigureParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  scope: managedScope,
  mode: Type.Literal("inherit"),
});
export const ToolsGitLabAuthorizeStartParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  scope: managedScope,
});
export const ToolsGitLabAuthorizeCompleteParamsSchema = closedObject({
  requestId: managedRequestId,
  callbackUrl: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const ToolsGitLabAuthorizeCancelParamsSchema = closedObject({
  requestId: managedRequestId,
});

export const UsersGitLabStatusParamsSchema = closedObject({});
export const UsersGitLabAuthorizeStartParamsSchema = closedObject({});
export const UsersGitLabAuthorizeCompleteParamsSchema = closedObject({
  requestId: Type.String({ format: "uuid" }),
  callbackUrl: Type.String({ minLength: 1, maxLength: 4096 }),
});
export const UsersGitLabDisconnectParamsSchema = closedObject({});
const id = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const GitLabPublicationGenerationSchema = Type.String({ format: "uuid", maxLength: 36 });
export const GitLabPublicationAccountSchema = closedObject({
  accountId: id,
  login: Type.String({ minLength: 1, maxLength: 255 }),
});
const managedIdentityStatus = closedObject({
  configured: Type.Literal(true),
  profileId: Type.String({ pattern: "^glp_[a-f0-9]{32}$" }),
  issuer: NonEmptyString,
  credentialState: Type.Union([Type.Literal("available"), Type.Literal("unavailable")]),
  account: Type.Union([Type.Null(), GitLabPublicationAccountSchema]),
  accessExpiresAtMs: Type.Union([Type.Null(), Type.Integer({ minimum: 0 })]),
  refreshState: Type.Union([
    Type.Literal("available"),
    Type.Literal("unavailable"),
    Type.Literal("reconnect_required"),
    Type.Literal("expired"),
    Type.Literal("failed"),
  ]),
});
export const ToolsGitLabStatusResultSchema = Type.Union([
  closedObject({ configured: Type.Literal(false) }),
  closedObject({
    configured: Type.Literal(true),
    issuer: NonEmptyString,
    selectedScope: managedScope,
    selected: Type.Union([Type.Null(), managedIdentityStatus]),
    effective: Type.Union([Type.Null(), managedIdentityStatus]),
    effectiveSource: Type.Union([
      Type.Literal("system-configured"),
      Type.Literal("agent-override"),
      Type.Literal("unavailable"),
    ]),
  }),
]);
export type ToolsGitLabStatusResult = Static<typeof ToolsGitLabStatusResultSchema>;

export const GitLabPublicationSelectionSchema = Type.Union([
  closedObject({
    source: Type.Literal("shared"),
    expected: Type.Optional(
      closedObject({
        source: Type.Union([Type.Literal("system-configured"), Type.Literal("agent-override")]),
        ...GitLabPublicationAccountSchema.properties,
      }),
    ),
  }),
  closedObject({
    source: Type.Literal("personal"),
    generation: GitLabPublicationGenerationSchema,
    account: GitLabPublicationAccountSchema,
  }),
]);
export const SessionGitLabPublishParamsSchema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  idempotencyKey: NonEmptyString,
  title: Type.Optional(
    Type.String({ minLength: 1, maxLength: 256, pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$" }),
  ),
  body: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  draft: Type.Optional(Type.Boolean()),
  bootstrapDraft: Type.Optional(Type.Boolean()),
  baseBranch: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  selection: Type.Optional(GitLabPublicationSelectionSchema),
});
export const SessionGitLabOptionsParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  idempotencyKey: Type.Optional(NonEmptyString),
});
export const SessionGitLabStatusParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  requestId: GitLabPublicationGenerationSchema,
});
export const SessionGitLabConfirmParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  requestId: GitLabPublicationGenerationSchema,
  generation: GitLabPublicationGenerationSchema,
  account: GitLabPublicationAccountSchema,
  requestDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
});

export const GitLabPublicationPublisherSchema = closedObject({
  source: Type.Union([
    Type.Literal("personal"),
    Type.Literal("system-configured"),
    Type.Literal("agent-override"),
  ]),
  ...GitLabPublicationAccountSchema.properties,
});
const GitLabPublicationResultBase = {
  requestId: NonEmptyString,
  publisher: Type.Optional(GitLabPublicationPublisherSchema),
  effect: Type.Optional(
    closedObject({
      kind: Type.Union([Type.Literal("push"), Type.Literal("pull_request")]),
      status: Type.Union([Type.Literal("dispatched"), Type.Literal("observed")]),
      headCommit: Type.Optional(Type.String({ maxLength: 64 })),
      url: Type.Optional(Type.String({ maxLength: 2048 })),
    }),
  ),
};
export const SessionGitLabPublicationResultSchema = Type.Union([
  closedObject({
    ...GitLabPublicationResultBase,
    status: Type.Literal("requested"),
    message: NonEmptyString,
  }),
  closedObject({
    ...GitLabPublicationResultBase,
    status: Type.Literal("publishing"),
    message: NonEmptyString,
  }),
  closedObject({
    ...GitLabPublicationResultBase,
    status: Type.Literal("needs_confirmation"),
    message: NonEmptyString,
  }),
  closedObject({
    ...GitLabPublicationResultBase,
    status: Type.Literal("published"),
    url: NonEmptyString,
    repository: NonEmptyString,
    branch: NonEmptyString,
    headCommit: NonEmptyString,
  }),
  closedObject({
    ...GitLabPublicationResultBase,
    status: Type.Literal("failed"),
    code: stringLiteralUnion([
      "identity_changed",
      "identity_unavailable",
      "session_changed",
      "workspace_changed",
      "not_git",
      "not_gitlab",
      "no_changes",
      "push_rejected",
      "gitlab_rejected",
      "unavailable",
    ]),
    message: NonEmptyString,
    nextAction: NonEmptyString,
  }),
]);
export const SessionGitLabStatusResultSchema = closedObject({
  result: SessionGitLabPublicationResultSchema,
  confirmation: Type.Union([
    Type.Null(),
    closedObject({
      requestDigest: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      generation: GitLabPublicationGenerationSchema,
      account: GitLabPublicationAccountSchema,
      pushRepository: NonEmptyString,
      repository: NonEmptyString,
      branch: NonEmptyString,
      baseBranch: NonEmptyString,
      sourceHeadCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
      sourceIndexTree: Type.String({ pattern: "^[a-f0-9]{40}$" }),
      workspaceTree: Type.String({ pattern: "^[a-f0-9]{40}$" }),
    }),
  ]),
});
export const PersonalGitLabPublicationStatusSchema = closedObject({
  state: Type.Union([
    Type.Literal("connected"),
    Type.Literal("disconnected"),
    Type.Literal("unavailable"),
  ]),
  generation: Type.Union([GitLabPublicationGenerationSchema, Type.Null()]),
  account: Type.Union([GitLabPublicationAccountSchema, Type.Null()]),
  accessExpiresAtMs: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  refreshState: Type.Union([
    Type.Literal("available"),
    Type.Literal("refreshing"),
    Type.Literal("expired"),
    Type.Literal("failed"),
    Type.Literal("not_applicable"),
  ]),
  pending: Type.Union([
    Type.Null(),
    closedObject({
      requestId: Type.Optional(GitLabPublicationGenerationSchema),
      authorizationUrl: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
      expiresAtMs: Type.Integer({ minimum: 0 }),
    }),
  ]),
});
export const SessionGitLabOptionsResultSchema = closedObject({
  issuer: Type.Union([NonEmptyString, Type.Null()]),
  personal: Type.Union([PersonalGitLabPublicationStatusSchema, Type.Null()]),
  shared: Type.Union([GitLabPublicationPublisherSchema, Type.Null()]),
  sharedUnavailableReason: Type.Optional(
    Type.Union([
      Type.Literal("unavailable"),
      Type.Literal("changed"),
      Type.Literal("unverified"),
      Type.Literal("unsupported_workspace"),
    ]),
  ),
  pendingPersonal: Type.Union([SessionGitLabStatusResultSchema, Type.Null()]),
  latestShared: Type.Union([SessionGitLabStatusResultSchema, Type.Null()]),
  target: Type.Union([
    Type.Null(),
    closedObject({ repository: NonEmptyString, branch: NonEmptyString }),
  ]),
});
export type GitLabPublicationSelection = Static<typeof GitLabPublicationSelectionSchema>;
export type SessionGitLabPublishParams = Static<typeof SessionGitLabPublishParamsSchema>;
export type SessionGitLabOptionsParams = Static<typeof SessionGitLabOptionsParamsSchema>;
export type SessionGitLabStatusParams = Static<typeof SessionGitLabStatusParamsSchema>;
export type SessionGitLabConfirmParams = Static<typeof SessionGitLabConfirmParamsSchema>;
export type SessionGitLabPublicationResult = Static<typeof SessionGitLabPublicationResultSchema>;
export type SessionGitLabStatusResult = Static<typeof SessionGitLabStatusResultSchema>;
export type SessionGitLabOptionsResult = Static<typeof SessionGitLabOptionsResultSchema>;
