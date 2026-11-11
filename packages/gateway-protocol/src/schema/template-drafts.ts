import { Type, type Static } from "typebox";
import { closedObject } from "./closed-object.js";

const DraftId = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
});
const Text = Type.String({ maxLength: 64_000 });
const Revision = Type.String({ pattern: "^[a-f0-9]{64}$" });
const Target = { agentId: Type.String({ minLength: 1, maxLength: 64 }), draftId: DraftId };

export const TemplateDraftScopeSchema = closedObject({
  input: Text,
  job: Text,
  output: Text,
  authority: Text,
});
export const TemplateDraftDocumentSchema = closedObject({
  name: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
  description: Type.Optional(Text),
  version: Type.String({ minLength: 1, maxLength: 128 }),
  scope: TemplateDraftScopeSchema,
  manifest: Type.String({ maxLength: 256_000 }),
  files: Type.Array(
    closedObject({
      path: Type.String({ minLength: 1, maxLength: 512 }),
      content: Type.String({ maxLength: 256_000 }),
    }),
    { maxItems: 64 },
  ),
});
export const TemplatesDraftsCreateParamsSchema = closedObject({
  agentId: Target.agentId,
  sourceSessionKey: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export const TemplatesDraftsReadParamsSchema = closedObject(Target);
export const TemplatesDraftsSaveParamsSchema = closedObject({
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
export const TemplatesDraftsReviewParamsSchema = closedObject({
  ...Target,
  choices: Type.Optional(ReviewChoices),
});
export const TemplatesDraftsPublishParamsSchema = closedObject({
  ...Target,
  reviewToken: Revision,
  choices: Type.Optional(ReviewChoices),
});

export type TemplateDraftDocument = Static<typeof TemplateDraftDocumentSchema>;
export type TemplatesDraftsCreateParams = Static<typeof TemplatesDraftsCreateParamsSchema>;
export type TemplatesDraftsReadParams = Static<typeof TemplatesDraftsReadParamsSchema>;
export type TemplatesDraftsSaveParams = Static<typeof TemplatesDraftsSaveParamsSchema>;
export type TemplatesDraftsReviewParams = Static<typeof TemplatesDraftsReviewParamsSchema>;
export type TemplatesDraftsPublishParams = Static<typeof TemplatesDraftsPublishParamsSchema>;
export type TemplateDraftReviewChoices = Static<typeof ReviewChoices>;
export type TemplateDraftReviewItem = {
  id: string;
  kind: "file" | "skill" | "plugin" | "mcp" | "automation";
  label: string;
  detail: string;
  included: boolean;
};
export type TemplatesDraftsReadResult = { content: string; revision: string };
export type TemplatesDraftsCreateResult = { draftId: string; prompt: string };
export type TemplatesDraftsReviewResult = {
  revision: string;
  reviewToken: string;
  publisher: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  items: TemplateDraftReviewItem[];
  files: Array<{ path: string; content: string }>;
  scope: TemplateDraftDocument["scope"];
};
export type TemplatesDraftsPublishResult = {
  name: string;
  version: string;
  url: string;
  publicationStatus: "pending" | "published";
};
