import {
  SkillsProposalsListParamsSchema,
  SkillsProposalsListResultSchema,
} from "./agents-models-skills.js";
import {
  SkillsProposalHistoryScanParamsSchema,
  SkillsProposalHistoryScanResultSchema,
  SkillsProposalHistoryStatusParamsSchema,
} from "./skill-history.js";
import {
  SkillsWriteApplyProposalParamsSchema,
  SkillsWriteApplyProposalResultSchema,
  SkillsWriteDirectParamsSchema,
  SkillsWriteDirectResultSchema,
  SkillsWriteProposeParamsSchema,
  SkillsWriteProposeResultSchema,
  SkillsWriteRefreshSnapshotParamsSchema,
  SkillsWriteRefreshSnapshotResultSchema,
  SkillsWriteValidateParamsSchema,
  SkillsWriteValidateResultSchema,
} from "./skills-write.js";

export const SkillProtocolSchemas = {
  SkillsProposalsListParams: SkillsProposalsListParamsSchema,
  SkillsProposalsListResult: SkillsProposalsListResultSchema,
  SkillsProposalHistoryStatusParams: SkillsProposalHistoryStatusParamsSchema,
  SkillsProposalHistoryScanParams: SkillsProposalHistoryScanParamsSchema,
  SkillsProposalHistoryScanResult: SkillsProposalHistoryScanResultSchema,
  SkillsWriteValidateParams: SkillsWriteValidateParamsSchema,
  SkillsWriteValidateResult: SkillsWriteValidateResultSchema,
  SkillsWriteApplyProposalParams: SkillsWriteApplyProposalParamsSchema,
  SkillsWriteApplyProposalResult: SkillsWriteApplyProposalResultSchema,
  SkillsWriteProposeParams: SkillsWriteProposeParamsSchema,
  SkillsWriteProposeResult: SkillsWriteProposeResultSchema,
  SkillsWriteDirectParams: SkillsWriteDirectParamsSchema,
  SkillsWriteDirectResult: SkillsWriteDirectResultSchema,
  SkillsWriteRefreshSnapshotParams: SkillsWriteRefreshSnapshotParamsSchema,
  SkillsWriteRefreshSnapshotResult: SkillsWriteRefreshSnapshotResultSchema,
} as const;
