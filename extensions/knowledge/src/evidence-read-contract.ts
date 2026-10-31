import { Type, type Static } from "typebox";
import { text } from "./model.js";

export const EvidenceReadInput = Type.Object(
  {
    id: text(96),
    path: text(500),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    startLine: Type.Optional(Type.Integer({ minimum: 1 })),
    endLine: Type.Optional(Type.Integer({ minimum: 1 })),
    cursor: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 2000,
        description:
          "Pass the returned cursor with the same id/path/hash. Omit line bounds on continuation, or repeat them exactly.",
      }),
    ),
    maxChars: Type.Optional(Type.Integer({ minimum: 256, maximum: 3000 })),
  },
  { additionalProperties: false },
);
export type EvidenceReadInput = Static<typeof EvidenceReadInput>;
export const EvidenceReadOutput = Type.Object(
  {
    record: Type.Object({ id: text(96), revision: Type.Integer(), hash: text(64) }),
    source: Type.Object({ filename: text(500), sha256: text(64) }),
    range: Type.Object({ startLine: Type.Integer(), endLine: Type.Integer() }),
    text: text(3000),
    offset: Type.Integer(),
    verification: Type.Object({ hashMatches: Type.Literal(true), rangeValid: Type.Literal(true) }),
    nextCursor: Type.Union([text(2000), Type.Null()]),
  },
  { additionalProperties: false },
);
export type EvidenceReadOutput = Static<typeof EvidenceReadOutput>;
