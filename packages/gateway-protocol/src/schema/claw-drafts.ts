import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";

const DraftId = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
});
const Text = Type.String({ maxLength: 64_000 });
const Revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Target = { agentId: Type.String({ minLength: 1, maxLength: 64 }), draftId: DraftId };

export const ClawDraftScopeSchema = closedObject({
  input: Text,
  job: Text,
  output: Text,
  authority: Text,
});
export const ClawDraftDocumentSchema = closedObject({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
  description: Type.Optional(Text),
  version: Type.String({ minLength: 1, maxLength: 128 }),
  scope: ClawDraftScopeSchema,
  manifest: Type.String({ maxLength: 256_000 }),
  files: Type.Array(
    closedObject({
      path: Type.String({ minLength: 1, maxLength: 512 }),
      content: Type.String({ maxLength: 256_000 }),
    }),
    { maxItems: 64 },
  ),
});
export const ClawsDraftsCreateParamsSchema = closedObject({
  agentId: Target.agentId,
  sourceSessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export const ClawsDraftsReadParamsSchema = closedObject(Target);
export const ClawsDraftsSaveParamsSchema = closedObject({
  ...Target,
  content: Type.String({ maxLength: 1_000_000 }),
  expectedRevision: Revision,
});
const ReviewChoices = closedObject({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
  displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  description: Text,
  excluded: Type.Array(Type.String({ minLength: 1, maxLength: 640 }), { maxItems: 128 }),
});
export const ClawsDraftsReviewParamsSchema = closedObject({
  ...Target,
  choices: Type.Optional(ReviewChoices),
});
export const ClawsDraftsPublishParamsSchema = closedObject({
  ...Target,
  reviewToken: Revision,
  choices: Type.Optional(ReviewChoices),
});

export type ClawDraftDocument = Static<typeof ClawDraftDocumentSchema>;
export type ClawsDraftsCreateParams = Static<typeof ClawsDraftsCreateParamsSchema>;
export type ClawsDraftsReadParams = Static<typeof ClawsDraftsReadParamsSchema>;
export type ClawsDraftsSaveParams = Static<typeof ClawsDraftsSaveParamsSchema>;
export type ClawsDraftsReviewParams = Static<typeof ClawsDraftsReviewParamsSchema>;
export type ClawsDraftsPublishParams = Static<typeof ClawsDraftsPublishParamsSchema>;
export type ClawDraftReviewChoices = Static<typeof ReviewChoices>;
export type ClawDraftReviewItem = {
  id: string;
  kind: "file" | "skill" | "plugin" | "mcp" | "automation";
  label: string;
  detail: string;
  included: boolean;
};
export type ClawsDraftsReadResult = { content: string; revision: string };
export type ClawsDraftsCreateResult = { draftId: string; prompt: string };
export type ClawsDraftsReviewResult = {
  revision: string;
  reviewToken: string;
  publisher: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  items: ClawDraftReviewItem[];
  files: Array<{ path: string; content: string }>;
  scope: ClawDraftDocument["scope"];
};
export type ClawsDraftsPublishResult = {
  name: string;
  version: string;
  url: string;
  publicationStatus: "pending" | "published";
};
