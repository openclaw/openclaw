import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";

/** Hex digest used by skill upload, proposal, and rollback contracts. */
export const SkillSha256String = Type.String({
  minLength: 64,
  maxLength: 64,
  pattern: "^[a-fA-F0-9]{64}$",
});

/** Bounded active/proposal skill markdown accepted by Gateway methods. */
export const SkillProposalContentString = Type.String({ minLength: 1, maxLength: 1_048_576 });

/** Text support file submitted alongside a skill proposal or direct write. */
export const SkillProposalSupportFileInputSchema = closedObject({
  path: NonEmptyString,
  content: Type.String({ maxLength: 262_144 }),
});

/** Scanner lifecycle states shared by proposal records and write results. */
export const SkillProposalScanStateSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("clean"),
  Type.Literal("failed"),
  Type.Literal("quarantined"),
]);

const SkillProposalFindingSchema = closedObject({
  ruleId: NonEmptyString,
  severity: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("critical")]),
  file: NonEmptyString,
  line: Type.Integer({ minimum: 1 }),
  message: NonEmptyString,
  evidence: Type.String(),
});

/** Complete scanner report embedded in skill proposal and write results. */
export const SkillProposalScanSchema = closedObject({
  state: SkillProposalScanStateSchema,
  scannedAt: NonEmptyString,
  critical: Type.Integer({ minimum: 0 }),
  warn: Type.Integer({ minimum: 0 }),
  info: Type.Integer({ minimum: 0 }),
  findings: Type.Array(SkillProposalFindingSchema),
});
