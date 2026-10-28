import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import {
  SessionGitLabConfirmParamsSchema,
  SessionGitLabPublishParamsSchema,
} from "./schema/gitlab.js";

const text = Type.String({ minLength: 1 });
const publish = SessionGitLabPublishParamsSchema.properties;
const confirm = SessionGitLabConfirmParamsSchema.properties;

/** The host chooses the requester and session; model input cannot select a publisher. */
export const GitLabPublicationOperationSchema = Type.Union([
  Type.Object(
    {
      action: Type.Literal("publish"),
      title: publish.title,
      body: publish.body,
      draft: publish.draft,
      bootstrapDraft: publish.bootstrapDraft,
      baseBranch: publish.baseBranch,
      workspacePath: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Literal("status"), requestId: confirm.requestId },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("confirm"),
      requestId: confirm.requestId,
      requestDigest: confirm.requestDigest,
      generation: confirm.generation,
      account: confirm.account,
    },
    { additionalProperties: false },
  ),
]);

export type GitLabPublicationOperation = Static<typeof GitLabPublicationOperationSchema>;
export const GitLabPublicationToolRequestSchema = Type.Object(
  {
    sessionKey: text,
    agentId: text,
    idempotencyKey: text,
    operation: GitLabPublicationOperationSchema,
  },
  { additionalProperties: false },
);
export type GitLabPublicationToolRequest = Static<typeof GitLabPublicationToolRequestSchema>;

export function parseGitLabPublicationOperation(value: unknown): GitLabPublicationOperation | null {
  return Value.Check(GitLabPublicationOperationSchema, value) ? value : null;
}

export function parseGitLabPublicationToolRequest(
  value: unknown,
): GitLabPublicationToolRequest | null {
  return Value.Check(GitLabPublicationToolRequestSchema, value) ? value : null;
}
