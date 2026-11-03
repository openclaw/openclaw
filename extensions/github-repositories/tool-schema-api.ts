import {
  GitHubBaseRefreshSchema,
  GitHubPublicationActionSchema,
  GitHubPublicationEditSchema,
  GitHubPublicationEvidenceSchema,
  GitHubPublicationTitleSchema,
  SessionGitHubPublishParamsSchema,
} from "@openclaw/gateway-protocol";
import { stringEnum } from "openclaw/plugin-sdk/channel-actions";
import { Type } from "typebox";

export const publicationOperatorActions = GitHubPublicationActionSchema.properties.action.anyOf.map(
  (action) => action.const,
);
export const publicationWorkspaceActions = [
  "publish",
  "readiness",
  "inspect_pr",
  "prepare_pr",
  "refresh_base",
  "edit",
  "ready",
  "request_review",
  "upload_evidence",
];

export const githubPublishToolDefinition = {
  name: "github_publish",
  parameters: Type.Object(
    {
      publishingSessionKey: GitHubPublicationActionSchema.properties.publishingSessionKey,
      ...GitHubBaseRefreshSchema.properties,
      ...GitHubPublicationEditSchema.properties,
      evidence: Type.Optional(GitHubPublicationEvidenceSchema),
      action: Type.Optional(stringEnum(publicationWorkspaceActions)),
      title: Type.Optional(GitHubPublicationTitleSchema),
      body: GitHubPublicationEditSchema.properties.body,
      draft: Type.Optional(Type.Boolean()),
      workspacePath: SessionGitHubPublishParamsSchema.properties.workspacePath,
    },
    { additionalProperties: false },
  ),
};
