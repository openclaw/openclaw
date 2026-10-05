import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
export const GitHubIdentityFactsSchema = closedObject({
  source: Type.Union([
    Type.Literal("system-detected"),
    Type.Literal("system-configured"),
    Type.Literal("agent-override"),
    Type.Literal("personal"),
  ]),
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
  appInstallation: Type.Optional(
    closedObject({
      appId: Type.Integer({ minimum: 1 }),
      installationId: Type.Integer({ minimum: 1 }),
      accountId: Type.Integer({ minimum: 1 }),
      repositories: Type.Array(
        closedObject({ id: Type.Integer({ minimum: 1 }), fullName: NonEmptyString }),
        { maxItems: 100 },
      ),
      permissions: Type.Record(
        Type.String(),
        Type.Union([Type.Literal("read"), Type.Literal("write")]),
      ),
      suspended: Type.Literal(false),
    }),
  ),
  repositoryGrants: Type.Literal("unknown"),
});
