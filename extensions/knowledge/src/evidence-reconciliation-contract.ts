import { Type, type Static } from "typebox";
import { Evidence, id } from "./model.js";
import { requestId, Receipt } from "./mutation-contract.js";

/** Explicit, fenced representation migration or reviewed current page support replacement. */
export const ReconcileEvidenceInput = Type.Object(
  {
    requestId,
    id,
    expectedVaultId: requestId,
    expectedRevision: Type.Integer({ minimum: 1 }),
    expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    expectedOntologyFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
    dryRun: Type.Boolean(),
    representation: Type.Union([Type.Literal("compact"), Type.Literal("expanded")]),
    evidence: Type.Optional(
      Type.Array(Evidence, {
        description:
          "Reviewed replacement current evidence set, only for active pages. Omit for representation-only migration. Annotation support remains attached. Never infer removal from absence in prose.",
      }),
    ),
  },
  { additionalProperties: false },
);
export type ReconcileEvidenceInput = Static<typeof ReconcileEvidenceInput>;
export const EvidencePreview = Type.Object(
  {
    state: Type.Literal("preview"),
    id,
    revision: Type.Integer(),
    hash: Type.String(),
    beforeBytes: Type.Integer(),
    afterBytes: Type.Integer(),
    descriptors: Type.Integer(),
    beforeEvidence: Type.Integer(),
    afterEvidence: Type.Integer(),
    representation: ReconcileEvidenceInput.properties.representation,
  },
  { additionalProperties: false },
);
export type EvidencePreview = Static<typeof EvidencePreview>;
export const ReconcileEvidenceOutput = Type.Union([Receipt, EvidencePreview]);
