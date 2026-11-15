import * as Checks from "../compiled/protocol.generated/validators-workspaces.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";

export const validateTemplatesCatalogSearchParams = createProtocolValidator(
  S.TemplatesCatalogSearchParamsSchema,
  Checks.isTemplatesCatalogSearchParams,
);
export const validateTemplateDraftDocument = createProtocolValidator(
  S.TemplateDraftDocumentSchema,
  Checks.isTemplateDraftDocument,
);
export const validateTemplatesDraftsCreateParams = createProtocolValidator(
  S.TemplatesDraftsCreateParamsSchema,
  Checks.isTemplatesDraftsCreateParams,
);
export const validateTemplatesDraftsReadParams = createProtocolValidator(
  S.TemplatesDraftsReadParamsSchema,
  Checks.isTemplatesDraftsReadParams,
);
export const validateTemplatesDraftsSaveParams = createProtocolValidator(
  S.TemplatesDraftsSaveParamsSchema,
  Checks.isTemplatesDraftsSaveParams,
);
export const validateTemplatesDraftsReviewParams = createProtocolValidator(
  S.TemplatesDraftsReviewParamsSchema,
  Checks.isTemplatesDraftsReviewParams,
);
export const validateTemplatesDraftsPublishParams = createProtocolValidator(
  S.TemplatesDraftsPublishParamsSchema,
  Checks.isTemplatesDraftsPublishParams,
);
export const validateTemplatesCatalogSearchResult = createProtocolValidator(
  S.TemplatesCatalogSearchResultSchema,
  Checks.isTemplatesCatalogSearchResult,
);
export const validateTemplatesCatalogDetailParams = createProtocolValidator(
  S.TemplatesCatalogDetailParamsSchema,
  Checks.isTemplatesCatalogDetailParams,
);
export const validateTemplatesCatalogDetailResult = createProtocolValidator(
  S.TemplatesCatalogDetailResultSchema,
  Checks.isTemplatesCatalogDetailResult,
);
export const validateTemplatesCatalogPreviewParams = createProtocolValidator(
  S.TemplatesCatalogPreviewParamsSchema,
  Checks.isTemplatesCatalogPreviewParams,
);
export const validateTemplatesCatalogPreviewResult = createProtocolValidator(
  S.TemplatesCatalogPreviewResultSchema,
  Checks.isTemplatesCatalogPreviewResult,
);
export const validateTemplatesStatusParams = createProtocolValidator(
  S.TemplatesStatusParamsSchema,
  Checks.isTemplatesStatusParams,
);
export const validateTemplatesStatusResult = createProtocolValidator(
  S.TemplatesStatusResultSchema,
  Checks.isTemplatesStatusResult,
);
export const validateTemplatesAddPlanParams = createProtocolValidator(
  S.TemplatesAddPlanParamsSchema,
  Checks.isTemplatesAddPlanParams,
);
export const validateTemplatesAddApplyParams = createProtocolValidator(
  S.TemplatesAddApplyParamsSchema,
  Checks.isTemplatesAddApplyParams,
);
export const validateTemplatesUpdatePlanParams = createProtocolValidator(
  S.TemplatesUpdatePlanParamsSchema,
  Checks.isTemplatesUpdatePlanParams,
);
export const validateTemplatesUpdateApplyParams = createProtocolValidator(
  S.TemplatesUpdateApplyParamsSchema,
  Checks.isTemplatesUpdateApplyParams,
);
export const validateTemplatesRemovePlanParams = createProtocolValidator(
  S.TemplatesRemovePlanParamsSchema,
  Checks.isTemplatesRemovePlanParams,
);
export const validateTemplatesRemoveApplyParams = createProtocolValidator(
  S.TemplatesRemoveApplyParamsSchema,
  Checks.isTemplatesRemoveApplyParams,
);
export const validateTemplateLifecyclePlanResult = createProtocolValidator(
  S.TemplateLifecyclePlanResultSchema,
  Checks.isTemplateLifecyclePlanResult,
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
