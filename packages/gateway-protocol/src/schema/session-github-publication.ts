import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { stringLiteralUnion } from "./string-literal-union.js";
import {
  PersonalGitHubAccountSchema,
  PersonalGitHubGenerationSchema,
  PersonalGitHubStatusSchema,
} from "./users.js";

const SharedGitHubPublicationSourceSchema = stringLiteralUnion([
  "system-detected",
  "system-configured",
  "agent-override",
]);
export const GitHubPublicationPublisherSchema = closedObject({
  source: Type.Union([Type.Literal("personal"), ...SharedGitHubPublicationSourceSchema.anyOf]),
  ...PersonalGitHubAccountSchema.properties,
});
const SharedGitHubPublicationPublisherSchema = closedObject({
  ...GitHubPublicationPublisherSchema.properties,
  source: SharedGitHubPublicationSourceSchema,
});
export const GitHubPublicationSelectionSchema = Type.Union([
  closedObject({
    source: Type.Literal("shared"),
    expected: Type.Optional(SharedGitHubPublicationPublisherSchema),
  }),
  closedObject({
    source: Type.Literal("personal"),
    generation: PersonalGitHubGenerationSchema,
    account: PersonalGitHubAccountSchema,
  }),
]);

export const GitHubPublicationTitleSchema = Type.String({
  minLength: 1,
  maxLength: 256,
  pattern: "^[^\\r\\n]*\\S[^\\r\\n]*$",
});
export const GitHubPublicationBodySchema = Type.String({ minLength: 1, maxLength: 8 * 1024 });

export const GitHubPullRequestInspectSchema = closedObject({
  action: Type.Literal("inspect_pr"),
  pullRequestUrl: Type.String({ minLength: 1, maxLength: 2048 }),
});
// API-observed owners include Enterprise Managed Users; linked-profile schemas stay separate.
export const GITHUB_PULL_REQUEST_LOGIN_PATTERN = "^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?$";
export const GitHubPullRequestPrepareSchema = closedObject({
  action: Type.Literal("prepare_pr"),
  pullRequestUrl: GitHubPullRequestInspectSchema.properties.pullRequestUrl,
  conflictsResolved: Type.Optional(Type.Boolean()),
  // Acknowledges returned conflicts; never selects the source to import.
  expectedHeadCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
});
const GitHubPullRequestRefSchema = closedObject({
  repository: NonEmptyString,
  repositoryId: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  branch: NonEmptyString,
  commit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
});
export const SessionGitHubPullRequestInspectResultSchema = closedObject({
  url: NonEmptyString,
  host: NonEmptyString,
  number: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  author: closedObject({
    accountId: PersonalGitHubAccountSchema.properties.accountId,
    login: Type.String({ minLength: 1, maxLength: 39, pattern: GITHUB_PULL_REQUEST_LOGIN_PATTERN }),
  }),
  state: stringLiteralUnion(["open", "draft", "closed", "merged"]),
  base: GitHubPullRequestRefSchema,
  head: Type.Union([GitHubPullRequestRefSchema, Type.Null()]),
});

export const SessionGitHubPublishParamsSchema = closedObject({
  sessionKey: Type.Optional(NonEmptyString),
  agentId: Type.Optional(NonEmptyString),
  idempotencyKey: NonEmptyString,
  title: Type.Optional(GitHubPublicationTitleSchema),
  body: Type.Optional(GitHubPublicationBodySchema),
  draft: Type.Optional(Type.Boolean()),
  selection: Type.Optional(GitHubPublicationSelectionSchema),
});

export const GitHubPublicationActionSchema = closedObject({
  action: Type.Union([
    Type.Literal("inspect"),
    Type.Literal("ready"),
    Type.Literal("merge"),
    Type.Literal("close"),
  ]),
  publishingSessionKey: Type.Optional(NonEmptyString),
  requestId: Type.Optional(PersonalGitHubGenerationSchema),
  expectedHeadCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
  mergeMethod: Type.Optional(
    Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]),
  ),
});
export const GitHubBaseRefreshSchema = closedObject({
  action: Type.Literal("refresh_base"),
  conflictsResolved: Type.Optional(Type.Boolean()),
  // Equality check against the pending integration, never a ref selector.
  baseCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}(?:[a-f0-9]{24})?$" })),
});
export const GitHubPublicationEditSchema = closedObject({
  action: Type.Literal("edit"),
  requestId: Type.Optional(PersonalGitHubGenerationSchema),
  expectedHeadCommit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40}$" })),
  title: Type.Optional(GitHubPublicationTitleSchema),
  body: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
  expectedTitle: Type.Optional(GitHubPublicationTitleSchema),
  expectedBody: Type.Optional(Type.String({ maxLength: 64 * 1024 })),
});
export const GitHubPublicationReviewRequestSchema = closedObject({
  action: Type.Literal("request_review"),
  requestId: Type.Optional(PersonalGitHubGenerationSchema),
  expectedHeadCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
});
export const GITHUB_PUBLICATION_EVIDENCE_MAX_BYTES = 10_000_000;
export const GitHubPublicationEvidenceSchema = closedObject({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  sizeBytes: Type.Integer({ minimum: 1, maximum: GITHUB_PUBLICATION_EVIDENCE_MAX_BYTES }),
});
export const GitHubPublicationEvidenceUploadSchema = closedObject({
  action: Type.Literal("upload_evidence"),
  requestId: Type.Optional(PersonalGitHubGenerationSchema),
  expectedHeadCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  evidence: GitHubPublicationEvidenceSchema,
});
export const SessionGitHubActionParamsSchema = Type.Union([
  closedObject({
    ...GitHubPullRequestPrepareSchema.properties,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...GitHubPullRequestInspectSchema.properties,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...GitHubPublicationReviewRequestSchema.properties,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...GitHubPublicationEvidenceUploadSchema.properties,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...GitHubPublicationEditSchema.properties,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...GitHubPublicationActionSchema.properties,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  }),
  closedObject({
    ...GitHubBaseRefreshSchema.properties,
    sessionKey: NonEmptyString,
    agentId: Type.Optional(NonEmptyString),
  }),
]);
export const SessionGitHubBaseRefreshResultSchema = closedObject({
  status: stringLiteralUnion(["current", "refreshed", "conflicts"]),
  repository: NonEmptyString,
  baseBranch: NonEmptyString,
  baseCommit: NonEmptyString,
  changedPaths: Type.Array(Type.String()),
  conflictPaths: Type.Array(Type.String()),
  review: Type.Optional(closedObject({ mode: Type.Literal("local"), base: NonEmptyString })),
});
export const SessionGitHubPullRequestPrepareResultSchema = closedObject({
  status: stringLiteralUnion(["prepared", "conflicts"]),
  url: NonEmptyString,
  headCommit: Type.String({ pattern: "^[a-f0-9]{40}$" }),
  headChanged: Type.Boolean(),
  changedPaths: Type.Array(Type.String()),
  conflictPaths: Type.Array(Type.String()),
  review: Type.Optional(closedObject({ mode: Type.Literal("local"), base: NonEmptyString })),
});

const SessionGitHubPublicationBaseSchema = {
  requestId: NonEmptyString,
  // Optional for responses from older shared workers; every current Gateway response includes it.
  publisher: Type.Optional(GitHubPublicationPublisherSchema),
  effect: Type.Optional(
    closedObject({
      kind: stringLiteralUnion(["push", "pull_request"]),
      status: stringLiteralUnion(["dispatched", "observed"]),
      headCommit: Type.Optional(Type.String({ maxLength: 64 })),
      url: Type.Optional(Type.String({ maxLength: 2048 })),
    }),
  ),
};

export const SessionGitHubPublicationRequestedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("requested"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationPublishingSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("publishing"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationPublishedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("published"),
  url: NonEmptyString,
  repository: NonEmptyString,
  branch: NonEmptyString,
  headCommit: NonEmptyString,
});
const SessionGitHubActionState = {
  publishingSessionKey: NonEmptyString,
  state: Type.Union([
    Type.Literal("draft"),
    Type.Literal("open"),
    Type.Literal("closed"),
    Type.Literal("merged"),
  ]),
  headCommit: NonEmptyString,
  mergeCommit: Type.Union([Type.String(), Type.Null()]),
  mergeable: Type.Union([Type.Boolean(), Type.Null()]),
  mergeState: Type.String(),
  reviewRequest: Type.Optional(
    closedObject({
      status: Type.Literal("posted"),
      url: NonEmptyString,
      message: NonEmptyString,
    }),
  ),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  evidence: Type.Optional(
    Type.Union([
      closedObject({
        status: Type.Literal("uploaded"),
        url: NonEmptyString,
        sha256: NonEmptyString,
        sizeBytes: Type.Integer({ minimum: 1 }),
        mimeType: NonEmptyString,
        publicAccess: Type.Literal("unverified"),
      }),
      closedObject({
        status: Type.Literal("unconfirmed"),
        message: NonEmptyString,
      }),
    ]),
  ),
};
export const SessionGitHubActionResultSchema = Type.Union([
  closedObject({
    ...SessionGitHubActionState,
    publication: SessionGitHubPublicationPublishedSchema,
  }),
  closedObject({
    ...SessionGitHubActionState,
    pullRequest: closedObject({
      url: NonEmptyString,
      repository: NonEmptyString,
      branch: NonEmptyString,
    }),
  }),
]);
export const SessionGitHubPublicationFailedSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("failed"),
  code: stringLiteralUnion([
    "identity_changed",
    "identity_unavailable",
    "session_changed",
    "workspace_changed",
    "not_git",
    "not_github",
    "no_changes",
    "push_rejected",
    "github_rejected",
    "unavailable",
  ]),
  message: NonEmptyString,
  nextAction: NonEmptyString,
});

export const SessionGitHubPublicationNeedsConfirmationSchema = closedObject({
  ...SessionGitHubPublicationBaseSchema,
  status: Type.Literal("needs_confirmation"),
  message: NonEmptyString,
});
export const SessionGitHubPublicationResultSchema = Type.Union([
  SessionGitHubPublicationRequestedSchema,
  SessionGitHubPublicationPublishingSchema,
  SessionGitHubPublicationPublishedSchema,
  SessionGitHubPublicationFailedSchema,
  SessionGitHubPublicationNeedsConfirmationSchema,
]);

export const SessionGitHubOptionsParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  // Narrows shared receipt recovery to the original invocation after a lost acknowledgement.
  idempotencyKey: Type.Optional(NonEmptyString),
});
export const SessionGitHubStatusParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  requestId: PersonalGitHubGenerationSchema,
});
export const SessionGitHubConfirmParamsSchema = closedObject({
  sessionKey: NonEmptyString,
  agentId: Type.Optional(NonEmptyString),
  requestId: PersonalGitHubGenerationSchema,
  generation: PersonalGitHubGenerationSchema,
  account: PersonalGitHubAccountSchema,
  requestDigest: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]+$" }),
});
export const SessionGitHubStatusResultSchema = closedObject({
  result: SessionGitHubPublicationResultSchema,
  confirmation: Type.Union([
    Type.Null(),
    closedObject({
      requestDigest: Type.String({ minLength: 64, maxLength: 64 }),
      generation: PersonalGitHubGenerationSchema,
      account: PersonalGitHubAccountSchema,
      pushRepository: Type.String({ maxLength: 256 }),
      repository: Type.String({ maxLength: 256 }),
      branch: Type.String({ maxLength: 256 }),
      baseBranch: Type.String({ maxLength: 256 }),
      sourceHeadCommit: Type.String({ maxLength: 64 }),
      sourceIndexTree: Type.String({ maxLength: 64 }),
      workspaceTree: Type.String({ maxLength: 64 }),
    }),
  ]),
});

export const SessionGitHubOptionsResultSchema = closedObject({
  stale: Type.Optional(Type.Boolean()),
  personal: Type.Union([PersonalGitHubStatusSchema, Type.Null()]),
  shared: Type.Union([SharedGitHubPublicationPublisherSchema, Type.Null()]),
  sharedUnavailableReason: Type.Optional(
    stringLiteralUnion([
      "unavailable",
      "changed",
      "rate_limited",
      "unverified",
      "unsupported_workspace",
    ]),
  ),
  pendingPersonal: Type.Union([SessionGitHubStatusResultSchema, Type.Null()]),
  latestShared: Type.Union([SessionGitHubStatusResultSchema, Type.Null()]),
});

export type SessionGitHubBaseRefreshResult = Static<typeof SessionGitHubBaseRefreshResultSchema>;
export type SessionGitHubPullRequestInspectResult = Static<
  typeof SessionGitHubPullRequestInspectResultSchema
>;
export type SessionGitHubPullRequestPrepareResult = Static<
  typeof SessionGitHubPullRequestPrepareResultSchema
>;
export type GitHubPublicationPublisher = Static<typeof GitHubPublicationPublisherSchema>;
export type GitHubPublicationAction = Static<typeof GitHubPublicationActionSchema>;
export type GitHubPublicationEdit = Static<typeof GitHubPublicationEditSchema>;
export type GitHubPublicationEvidence = Static<typeof GitHubPublicationEvidenceSchema>;
export type SessionGitHubActionParams = Static<typeof SessionGitHubActionParamsSchema>;
export type SessionGitHubActionResult = Static<typeof SessionGitHubActionResultSchema>;
export type GitHubPublicationSelection = Static<typeof GitHubPublicationSelectionSchema>;
export type SessionGitHubConfirmParams = Static<typeof SessionGitHubConfirmParamsSchema>;
export type SessionGitHubOptionsResult = Static<typeof SessionGitHubOptionsResultSchema>;
export type SessionGitHubStatusResult = Static<typeof SessionGitHubStatusResultSchema>;

export type SessionGitHubPublishParams = Static<typeof SessionGitHubPublishParamsSchema>;
export type SessionGitHubPublicationRequested = Static<
  typeof SessionGitHubPublicationRequestedSchema
>;
export type SessionGitHubPublicationPublishing = Static<
  typeof SessionGitHubPublicationPublishingSchema
>;
export type SessionGitHubPublicationPublished = Static<
  typeof SessionGitHubPublicationPublishedSchema
>;
export type SessionGitHubPublicationFailed = Static<typeof SessionGitHubPublicationFailedSchema>;
export type SessionGitHubPublicationResult = Static<typeof SessionGitHubPublicationResultSchema>;
