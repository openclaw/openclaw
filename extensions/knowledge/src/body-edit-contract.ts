import { Type, type Static } from "typebox";
import { BODY_INPUT_MAX_CHARS } from "./limits.js";
import { id } from "./model.js";
import { requestId } from "./mutation-contract.js";
/** One exact body range, using UTF-16 offsets from knowledge_record content reads. */
export const EditBodyInput = Type.Object(
  {
    requestId,
    id,
    expectedVaultId: requestId,
    expectedRevision: Type.Integer({ minimum: 1 }),
    expectedHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    expectedOntologyFingerprint: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    start: Type.Integer({ minimum: 0 }),
    end: Type.Integer({ minimum: 0 }),
    replacement: Type.String({ maxLength: BODY_INPUT_MAX_CHARS }),
    reason: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);
export type EditBodyInput = Static<typeof EditBodyInput>;
