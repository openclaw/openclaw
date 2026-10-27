import { Type, type Static } from "typebox";
import { BODY_INPUT_MAX_CHARS } from "./limits.js";
import { text, name, Evidence, Envelope, id, strings, RecordAnnotations, Recall } from "./model.js";
export const requestId = Type.String({
  pattern: "^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$",
});
const mutationRequestIdDescription =
  "Generate a lowercase UUID per distinct mutation, not a source ID or slug. Reuse only with the identical payload after an uncertain response.";
const requiredMutationRequestId = Type.String({
  ...requestId,
  description: mutationRequestIdDescription,
});
export const SavePage = Type.Object(
  {
    ...RecordAnnotations.properties,
    requestId: Type.Optional(
      Type.String({
        ...requiredMutationRequestId,
        description: `${mutationRequestIdDescription} Omit only during a host pre-compaction memory flush; Knowledge derives a stable request ID from the flush and normalized title.`,
      }),
    ),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    body: Type.String({
      maxLength: BODY_INPUT_MAX_CHARS,
      description:
        "One bounded write, not durable capacity. Use knowledge_edit_body for small changes or incremental growth of large pages.",
    }),
    type: Type.Optional(name),
    fields: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description:
          "Only domain fields declared by knowledge_ontology view=definitions for this type. Replaces the entire fields object; omit to preserve.",
      }),
    ),
    id: Type.Optional(Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9_-]{7,95}$" })),
    expectedVaultId: Type.Optional(requestId),
    expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
    expectedHash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    expectedOntologyFingerprint: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
    aliases: Type.Optional(strings),
    tags: Type.Optional(strings),
    dependencies: Envelope.properties.dependencies,
    attachments: Type.Optional(Type.Array(Evidence)),
    source: Type.Optional(
      Type.Object(
        {
          text: Type.String({ minLength: 1 }),
          attribution: Type.String({ minLength: 1, maxLength: 1000 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
type SavePageInput = Static<typeof SavePage>;
export type SavePage = Omit<SavePageInput, "requestId"> & { requestId: string };
const common = {
  ...RecordAnnotations.properties,
  requestId: requiredMutationRequestId,
  expectedVaultId: Type.Optional(requestId),
  expectedOntologyFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({
    maxLength: BODY_INPUT_MAX_CHARS,
    description:
      "One bounded write, not durable capacity. Use knowledge_edit_body for small changes or incremental growth of large pages.",
  }),
  attribution: Type.String({ minLength: 1, maxLength: 1000 }),
  evidence: Type.Array(Evidence, { minItems: 1 }),
  dependencies: Envelope.properties.dependencies,
  valid_from: Envelope.properties.valid_from,
  valid_until: Envelope.properties.valid_until,
  expires_at: Envelope.properties.expires_at,
};
const CreateClaim = Type.Object(
  {
    ...common,
    ...Type.Required(Type.Pick(Envelope, ["claim_kind", "assertion_origin"])).properties,
    entities: Envelope.properties.entities,
    subject_hint: Envelope.properties.subject_hint,
    occurred_at: Envelope.properties.occurred_at,
    owner: Envelope.properties.owner,
    due_at: Envelope.properties.due_at,
  },
  { additionalProperties: false },
);
// Remove Optional markers inherited from the portable (multi-kind) envelope.
export const ClaimInput = CreateClaim;
export type ClaimInput = Static<typeof ClaimInput>;
export const RelationshipInput = Type.Object(
  {
    ...common,
    from: id,
    to: id,
    label: name,
    fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  },
  { additionalProperties: false },
);
export type RelationshipInput = Static<typeof RelationshipInput>;
/** Lifecycle changes are explicit, revision-fenced operations, not editable fields. */
const target = {
  requestId,
  id,
  expectedRevision: Type.Integer({ minimum: 1 }),
  expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
  expectedVaultId: Type.Optional(requestId),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
};
export const AnnotateInput = Type.Object(
  {
    ...target,
    annotations: RecordAnnotations,
    entities: Type.Optional(
      Type.Array(id, {
        maxItems: 100,
        uniqueItems: true,
        description:
          "Claims only. Replaces the claim's linked entity pages (active pages in this scope); [] unlinks. Assertion text, evidence and lifecycle are unchanged.",
      }),
    ),
    addEvidence: Type.Optional(Type.Array(Evidence, { minItems: 1, maxItems: 100 })),
  },
  { additionalProperties: false },
);
export type AnnotateInput = Static<typeof AnnotateInput>;
export const WithdrawInput = Type.Object(target, { additionalProperties: false });
export type WithdrawInput = Static<typeof WithdrawInput>;
const pageFence = (description: string) =>
  Type.Object(
    {
      id,
      expectedRevision: Type.Integer({ minimum: 1 }),
      expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    },
    { additionalProperties: false, description },
  );
const mergeCommon = {
  requestId,
  expectedVaultId: Type.Optional(requestId),
  reason: Type.String({ minLength: 1, maxLength: 2000 }),
};
export const MergeInput = Type.Object(
  {
    ...mergeCommon,
    survivor: pageFence(
      "The page that remains. Its ID, current revision and hash from knowledge_record.",
    ),
    absorbed: pageFence(
      "The duplicate page. It becomes merged and its ID resolves to the survivor.",
    ),
    title: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: "Rename the survivor; its old title becomes an alias.",
      }),
    ),
    body: Type.Optional(
      Type.String({
        maxLength: BODY_INPUT_MAX_CHARS,
        description:
          "Replacement survivor body. Omit to keep it; the absorbed body stays readable by exact ID.",
      }),
    ),
    evidence: Type.Optional(
      Type.Array(Evidence, {
        minItems: 1,
        maxItems: 20,
        description: "Retained identity evidence (knowledge_attach), added to the survivor.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type MergeInput = Static<typeof MergeInput>;
export const UnmergeInput = Type.Object(
  {
    ...mergeCommon,
    merged: pageFence("The merged page to restore, with its current revision and hash."),
    survivor: pageFence("The page it was merged into, with its current revision and hash."),
  },
  { additionalProperties: false },
);
export type UnmergeInput = Static<typeof UnmergeInput>;
const MergeReport = Type.Object(
  {
    survivorId: id,
    absorbedId: id,
    aliases: Type.Array(text(200), {
      maxItems: 100,
      description: "Aliases the survivor gained (merge) or lost (unmerge).",
    }),
    fieldConflicts: Type.Array(text(200), {
      maxItems: 100,
      description: "Fields both pages set differently; the survivor's values were kept.",
    }),
    redirectedRecords: Type.Integer({
      minimum: 0,
      description:
        "Current records that named the absorbed page and now resolve to the survivor (merge), or back to the restored page (unmerge).",
    }),
  },
  { additionalProperties: false },
);
const recallTarget = {
  requestId,
  id,
  expectedRevision: Type.Integer({ minimum: 1 }),
  expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
};
const RecallSet = Type.Object(
  {
    summary: Recall.properties.summary,
    triggers: Recall.properties.triggers,
    importance: Recall.properties.importance,
    projects: Recall.properties.projects,
  },
  { additionalProperties: false },
);
export const RecallInput = Type.Union([
  Type.Object({ ...recallTarget, set: RecallSet }, { additionalProperties: false }),
  Type.Object({ ...recallTarget, clear: Type.Literal(true) }, { additionalProperties: false }),
]);
export type RecallInput = Static<typeof RecallInput>;
export const CorrectInput = Type.Object(
  {
    ...target,
    expectedOntologyFingerprint: common.expectedOntologyFingerprint,
    replacement: Type.Union([
      Type.Object(
        {
          kind: Type.Literal("claim"),
          ...Type.Omit(ClaimInput, ["requestId", "expectedVaultId", "expectedOntologyFingerprint"])
            .properties,
        },
        { additionalProperties: false },
      ),
      Type.Object(
        {
          kind: Type.Literal("relationship"),
          ...Type.Omit(RelationshipInput, [
            "requestId",
            "expectedVaultId",
            "expectedOntologyFingerprint",
          ]).properties,
        },
        { additionalProperties: false },
      ),
    ]),
  },
  { additionalProperties: false },
);
export type CorrectInput = Static<typeof CorrectInput>;
const LifecycleImpact = Type.Object(
  {
    items: Type.Array(
      Type.Object(
        { id, title: text(200), kind: text(40), direct: Type.Boolean() },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
    total: Type.Integer({ minimum: 0 }),
    message: text(1000),
  },
  { additionalProperties: false },
);
export type WriteInput = SavePage | ClaimInput | RelationshipInput;
export type WriteKind = "page" | "claim" | "relationship";
const GitCheckpoint = Type.Object(
  {
    state: Type.Union([
      Type.Literal("pending"),
      Type.Literal("unavailable"),
      Type.Literal("committed"),
    ]),
    commit: Type.Optional(Type.String({ pattern: "^[a-f0-9]{40,64}$" })),
    message: text(500),
  },
  { additionalProperties: false },
);
export const GitStatus = Type.Object(
  {
    state: Type.Union([
      Type.Literal("idle"),
      Type.Literal("read-only"),
      ...GitCheckpoint.properties.state.anyOf,
    ]),
    pending: Type.Integer({ minimum: 0 }),
    message: text(500),
  },
  { additionalProperties: false },
);
export const Receipt = Type.Object(
  {
    requestId,
    state: Type.Union([
      Type.Literal("accepted"),
      Type.Literal("published"),
      Type.Literal("conflict"),
    ]),
    id: text(96),
    path: text(500),
    revision: Type.Integer(),
    hash: text(64),
    at: text(40),
    message: text(1000),
    operation: Type.Optional(
      Type.Union([
        Type.Literal("correct"),
        Type.Literal("withdraw"),
        Type.Literal("merge"),
        Type.Literal("unmerge"),
      ]),
    ),
    merge: Type.Optional(MergeReport),
    items: Type.Optional(
      Type.Array(
        Type.Object(
          { key: text(40), id, path: text(500), revision: Type.Integer(), hash: text(64) },
          { additionalProperties: false },
        ),
        { maxItems: 25 },
      ),
    ),
    targetId: Type.Optional(id),
    replacementId: Type.Optional(id),
    reason: Type.Optional(text(2000)),
    impact: Type.Optional(LifecycleImpact),
    indexed: Type.Literal(false),
    git: Type.Optional(GitCheckpoint),
  },
  { additionalProperties: false },
);
export type Receipt = Static<typeof Receipt>;
export const HistoryEntry = Type.Object(
  {
    sequence: Type.Integer(),
    id: text(96),
    provenance: text(40),
    at: text(40),
    path: text(500),
    revision: Type.Integer(),
    hash: text(64),
  },
  { additionalProperties: false },
);
