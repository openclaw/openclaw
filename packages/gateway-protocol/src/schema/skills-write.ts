import type { Static } from "typebox";
import { Type } from "typebox";
import {
  SkillsProposalActionParamsSchema,
  SkillsProposalApplyResultSchema,
  SkillsProposalInspectResultSchema,
} from "./agents-models-skills.js";
import { closedObject } from "./closed-object.js";
import { NonEmptyString } from "./primitives.js";
import {
  SkillProposalContentString,
  SkillProposalScanSchema,
  SkillProposalSupportFileInputSchema,
  SkillSha256String,
} from "./skill-shared.js";

/** Validates an active SKILL.md bundle without writing it. */
export const SkillsWriteValidateParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  name: Type.Optional(NonEmptyString),
  content: SkillProposalContentString,
  supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
});

export const SkillsWriteValidateResultSchema = closedObject({
  name: NonEmptyString,
  description: NonEmptyString,
  scan: SkillProposalScanSchema,
});

/** Creates a pending create/update proposal through the stable write service. */
export const SkillsWriteProposeParamsSchema = Type.Union([
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    kind: Type.Literal("create"),
    name: NonEmptyString,
    description: NonEmptyString,
    content: SkillProposalContentString,
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
    goal: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
  }),
  closedObject({
    agentId: Type.Optional(NonEmptyString),
    kind: Type.Literal("update"),
    skillName: NonEmptyString,
    description: Type.Optional(NonEmptyString),
    content: SkillProposalContentString,
    supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
    goal: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
  }),
]);

export const SkillsWriteProposeResultSchema = SkillsProposalInspectResultSchema;
export const SkillsWriteApplyProposalParamsSchema = SkillsProposalActionParamsSchema;
export const SkillsWriteApplyProposalResultSchema = SkillsProposalApplyResultSchema;

/** Writes a validated workspace skill immediately. Admin scope is the policy gate. */
export const SkillsWriteDirectParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
  mode: Type.Union([Type.Literal("create"), Type.Literal("update")]),
  name: NonEmptyString,
  content: SkillProposalContentString,
  supportFiles: Type.Optional(Type.Array(SkillProposalSupportFileInputSchema, { maxItems: 64 })),
  refresh: Type.Optional(Type.Boolean()),
});

const SkillsWriteRollbackSupportFileSchema = closedObject({
  path: NonEmptyString,
  existed: Type.Boolean(),
  previousContent: Type.Optional(Type.String()),
  previousContentHash: Type.Optional(SkillSha256String),
});

export const SkillsWriteDirectResultSchema = closedObject({
  targetSkillFile: NonEmptyString,
  scan: SkillProposalScanSchema,
  rollback: closedObject({
    action: Type.Union([Type.Literal("create"), Type.Literal("update")]),
    targetSkillFile: NonEmptyString,
    previousContent: Type.Optional(Type.String()),
    previousContentHash: Type.Optional(SkillSha256String),
    supportFiles: Type.Optional(Type.Array(SkillsWriteRollbackSupportFileSchema, { maxItems: 64 })),
  }),
  snapshotVersion: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
});

export const SkillsWriteRefreshSnapshotParamsSchema = closedObject({
  agentId: Type.Optional(NonEmptyString),
});

export const SkillsWriteRefreshSnapshotResultSchema = closedObject({
  snapshotVersion: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});

export type SkillsWriteValidateParams = Static<typeof SkillsWriteValidateParamsSchema>;
export type SkillsWriteValidateResult = Static<typeof SkillsWriteValidateResultSchema>;
export type SkillsWriteProposeParams = Static<typeof SkillsWriteProposeParamsSchema>;
export type SkillsWriteProposeResult = Static<typeof SkillsWriteProposeResultSchema>;
export type SkillsWriteApplyProposalParams = Static<typeof SkillsWriteApplyProposalParamsSchema>;
export type SkillsWriteApplyProposalResult = Static<typeof SkillsWriteApplyProposalResultSchema>;
export type SkillsWriteDirectParams = Static<typeof SkillsWriteDirectParamsSchema>;
export type SkillsWriteDirectResult = Static<typeof SkillsWriteDirectResultSchema>;
export type SkillsWriteRefreshSnapshotParams = Static<
  typeof SkillsWriteRefreshSnapshotParamsSchema
>;
export type SkillsWriteRefreshSnapshotResult = Static<
  typeof SkillsWriteRefreshSnapshotResultSchema
>;
