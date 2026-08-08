import {
  SkillsProposalEvaluateParamsSchema,
  SkillsProposalEvaluateResultSchema,
  SkillsProposalEventsListParamsSchema,
  SkillsProposalEventsListResultSchema,
  SkillsProposalReviewParamsSchema,
  SkillsProposalReviewResultSchema,
  SkillsProposalsListParamsSchema,
  SkillsProposalsListResultSchema,
} from "./agents-models-skills.js";
import {
  SkillsProposalHistoryScanParamsSchema,
  SkillsProposalHistoryScanResultSchema,
  SkillsProposalHistoryStatusParamsSchema,
} from "./skill-history.js";

export const SkillWorkshopProtocolSchemas = {
  SkillsProposalsListParams: SkillsProposalsListParamsSchema,
  SkillsProposalsListResult: SkillsProposalsListResultSchema,
  SkillsProposalEvaluateParams: SkillsProposalEvaluateParamsSchema,
  SkillsProposalEvaluateResult: SkillsProposalEvaluateResultSchema,
  SkillsProposalEventsListParams: SkillsProposalEventsListParamsSchema,
  SkillsProposalEventsListResult: SkillsProposalEventsListResultSchema,
  SkillsProposalReviewParams: SkillsProposalReviewParamsSchema,
  SkillsProposalReviewResult: SkillsProposalReviewResultSchema,
  SkillsProposalHistoryStatusParams: SkillsProposalHistoryStatusParamsSchema,
  SkillsProposalHistoryScanParams: SkillsProposalHistoryScanParamsSchema,
  SkillsProposalHistoryScanResult: SkillsProposalHistoryScanResultSchema,
} as const;
