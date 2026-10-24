import * as Checks from "../compiled/protocol.generated/validators-workspaces.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";

export const validateClawsCatalogSearchParams = createProtocolValidator(
  S.ClawsCatalogSearchParamsSchema,
  Checks.isClawsCatalogSearchParams,
);
export const validateClawDraftDocument = createProtocolValidator(
  S.ClawDraftDocumentSchema,
  Checks.isClawDraftDocument,
);
export const validateClawsDraftsCreateParams = createProtocolValidator(
  S.ClawsDraftsCreateParamsSchema,
  Checks.isClawsDraftsCreateParams,
);
export const validateClawsDraftsReadParams = createProtocolValidator(
  S.ClawsDraftsReadParamsSchema,
  Checks.isClawsDraftsReadParams,
);
export const validateClawsDraftsSaveParams = createProtocolValidator(
  S.ClawsDraftsSaveParamsSchema,
  Checks.isClawsDraftsSaveParams,
);
export const validateClawsDraftsReviewParams = createProtocolValidator(
  S.ClawsDraftsReviewParamsSchema,
  Checks.isClawsDraftsReviewParams,
);
export const validateClawsDraftsPublishParams = createProtocolValidator(
  S.ClawsDraftsPublishParamsSchema,
  Checks.isClawsDraftsPublishParams,
);
export const validateClawsCatalogSearchResult = createProtocolValidator(
  S.ClawsCatalogSearchResultSchema,
  Checks.isClawsCatalogSearchResult,
);
export const validateClawsCatalogDetailParams = createProtocolValidator(
  S.ClawsCatalogDetailParamsSchema,
  Checks.isClawsCatalogDetailParams,
);
export const validateClawsCatalogDetailResult = createProtocolValidator(
  S.ClawsCatalogDetailResultSchema,
  Checks.isClawsCatalogDetailResult,
);
export const validateClawsCatalogPreviewParams = createProtocolValidator(
  S.ClawsCatalogPreviewParamsSchema,
  Checks.isClawsCatalogPreviewParams,
);
export const validateClawsCatalogPreviewResult = createProtocolValidator(
  S.ClawsCatalogPreviewResultSchema,
  Checks.isClawsCatalogPreviewResult,
);
export const validateClawsStatusParams = createProtocolValidator(
  S.ClawsStatusParamsSchema,
  Checks.isClawsStatusParams,
);
export const validateClawsStatusResult = createProtocolValidator(
  S.ClawsStatusResultSchema,
  Checks.isClawsStatusResult,
);
export const validateClawsAddPlanParams = createProtocolValidator(
  S.ClawsAddPlanParamsSchema,
  Checks.isClawsAddPlanParams,
);
export const validateClawsAddApplyParams = createProtocolValidator(
  S.ClawsAddApplyParamsSchema,
  Checks.isClawsAddApplyParams,
);
export const validateClawsUpdatePlanParams = createProtocolValidator(
  S.ClawsUpdatePlanParamsSchema,
  Checks.isClawsUpdatePlanParams,
);
export const validateClawsUpdateApplyParams = createProtocolValidator(
  S.ClawsUpdateApplyParamsSchema,
  Checks.isClawsUpdateApplyParams,
);
export const validateClawsRemovePlanParams = createProtocolValidator(
  S.ClawsRemovePlanParamsSchema,
  Checks.isClawsRemovePlanParams,
);
export const validateClawsRemoveApplyParams = createProtocolValidator(
  S.ClawsRemoveApplyParamsSchema,
  Checks.isClawsRemoveApplyParams,
);
export const validateClawLifecyclePlanResult = createProtocolValidator(
  S.ClawLifecyclePlanResultSchema,
  Checks.isClawLifecyclePlanResult,
);
export const validateCanvasDocumentPreviewParams = createProtocolValidator(
  S.CanvasDocumentPreviewParamsSchema,
  Checks.isCanvasDocumentPreviewParams,
);
export const validateCanvasDocumentViewParams = createProtocolValidator(
  S.CanvasDocumentViewParamsSchema,
  Checks.isCanvasDocumentViewParams,
);
export const validateProjectsCheckoutOptionsParams = createProtocolValidator(
  S.ProjectsCheckoutOptionsParamsSchema,
  Checks.isProjectsCheckoutOptionsParams,
);
export const validateProjectsListParams = createProtocolValidator(
  S.ProjectsListParamsSchema,
  Checks.isProjectsListParams,
);
export const validateProjectsRegisterParams = createProtocolValidator(
  S.ProjectsRegisterParamsSchema,
  Checks.isProjectsRegisterParams,
);
export const validateProjectsAddParams = createProtocolValidator(
  S.ProjectsAddParamsSchema,
  Checks.isProjectsAddParams,
);
export const validateProjectsSearchRemoteParams = createProtocolValidator(
  S.ProjectsSearchRemoteParamsSchema,
  Checks.isProjectsSearchRemoteParams,
);
export const validateProjectsRemoveParams = createProtocolValidator(
  S.ProjectsRemoveParamsSchema,
  Checks.isProjectsRemoveParams,
);
export const validateWorktreesListParams = createProtocolValidator(
  S.WorktreesListParamsSchema,
  Checks.isWorktreesListParams,
);
export const validateBoardGetParams = createProtocolValidator(
  S.BoardGetParamsSchema,
  Checks.isBoardGetParams,
);
export const validateBoardUpdateParams = createProtocolValidator(
  S.BoardUpdateParamsSchema,
  Checks.isBoardUpdateParams,
);
export const validateBoardWidgetContent = createProtocolValidator(
  S.BoardWidgetContentSchema,
  Checks.isBoardWidgetContent,
);
export const validateBoardWidgetAppViewParams = createProtocolValidator(
  S.BoardWidgetAppViewParamsSchema,
  Checks.isBoardWidgetAppViewParams,
);
export const validateBoardWidgetPutParams = createProtocolValidator(
  S.BoardWidgetPutParamsSchema,
  Checks.isBoardWidgetPutParams,
);
export const validateBoardWidgetGrantParams = createProtocolValidator(
  S.BoardWidgetGrantParamsSchema,
  Checks.isBoardWidgetGrantParams,
);
export const validateBoardEventParams = createProtocolValidator(
  S.BoardEventParamsSchema,
  Checks.isBoardEventParams,
);
export const validateBoardPromptAuthorizeParams = createProtocolValidator(
  S.BoardPromptAuthorizeParamsSchema,
  Checks.isBoardPromptAuthorizeParams,
);
export const validateBoardDataReadParams = createProtocolValidator(
  S.BoardDataReadParamsSchema,
  Checks.isBoardDataReadParams,
);
export const validateBoardActionParams = createProtocolValidator(
  S.BoardActionParamsSchema,
  Checks.isBoardActionParams,
);
export const validateWorktreesCreateParams = createProtocolValidator(
  S.WorktreesCreateParamsSchema,
  Checks.isWorktreesCreateParams,
);
export const validateWorktreesRemoveParams = createProtocolValidator(
  S.WorktreesRemoveParamsSchema,
  Checks.isWorktreesRemoveParams,
);
export const validateWorktreesRestoreParams = createProtocolValidator(
  S.WorktreesRestoreParamsSchema,
  Checks.isWorktreesRestoreParams,
);
export const validateWorktreesGcParams = createProtocolValidator(
  S.WorktreesGcParamsSchema,
  Checks.isWorktreesGcParams,
);
export const validateWorktreesRecoverFileParams = createProtocolValidator(
  S.WorktreesRecoverFileParamsSchema,
  Checks.isWorktreesRecoverFileParams,
);
export const validateWorktreesRecoverRemovalParams = createProtocolValidator(
  S.WorktreesRecoverRemovalParamsSchema,
  Checks.isWorktreesRecoverRemovalParams,
);
export const validateWorktreesRetireSnapshotParams = createProtocolValidator(
  S.WorktreesRetireSnapshotParamsSchema,
  Checks.isWorktreesRetireSnapshotParams,
);
export const validateWorktreesBranchesParams = createProtocolValidator(
  S.WorktreesBranchesParamsSchema,
  Checks.isWorktreesBranchesParams,
);
export const validateFsListDirParams = createProtocolValidator(
  S.FsListDirParamsSchema,
  Checks.isFsListDirParams,
);
export const validateFsListDirResult = createProtocolValidator(
  S.FsListDirResultSchema,
  Checks.isFsListDirResult,
);
