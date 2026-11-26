import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import { GitHubSetupHandleSchema } from "./secrets.js";

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
  stale: Type.Optional(Type.Boolean()),
  source: GitHubIdentitySourceSchema,
  credentialKind: Type.Union([
    Type.Literal("native"),
    Type.Literal("managed-pat"),
    Type.Literal("managed-oauth"),
    Type.Literal("app-installation"),
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

// Native clients construct this request as an object; activation remains agent-scoped.
export const ToolsGitHubAuthorizeStartParamsSchema = Object.assign(
  closedObject({
    scope: GitHubIdentityScopeSchema,
    agentId: NonEmptyString,
    activation: Type.Optional(
      closedObject({
        expectedAccountId: Type.Integer({ minimum: 1 }),
        resetGitAuthor: Type.Optional(Type.Literal(true)),
        pathPrepend: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 4096, pattern: "\\S" }), {
            maxItems: 64,
          }),
        ),
      }),
    ),
  }),
  { not: { properties: { scope: { const: "system" } }, required: ["activation"] } },
);

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
  reason: Type.Union([
    Type.Literal("identity_changed"),
    Type.Literal("setup_failed"),
    Type.Literal("config_not_applied"),
  ]),
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
