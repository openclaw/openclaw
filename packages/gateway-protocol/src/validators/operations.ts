import * as Checks from "../compiled/protocol.generated/validators-operations.js";
import { cronAddDiagnostics, cronUpdateDiagnostics } from "../cron-validation-diagnostics.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";
import type { AuditActivityListParams, AuditRunInspectParams } from "../schema-modules.js";

export const validateCommandsListParams = createProtocolValidator(
  S.CommandsListParamsSchema,
  Checks.isCommandsListParams,
);
export const validateBackupStatusParams = createProtocolValidator(
  S.BackupStatusParamsSchema,
  Checks.isBackupStatusParams,
);
export const validateBackupRecordOutcomeParams = createProtocolValidator(
  S.BackupRecordOutcomeParamsSchema,
  Checks.isBackupRecordOutcomeParams,
);
export const validateStorageLocationsListParams = createProtocolValidator(
  S.StorageLocationsListParamsSchema,
  Checks.isStorageLocationsListParams,
);
export const validateStorageLocationsProbeParams = createProtocolValidator(
  S.StorageLocationsProbeParamsSchema,
  Checks.isStorageLocationsProbeParams,
);
export const validateComputerStatusParams = createProtocolValidator(
  S.ComputerStatusParamsSchema,
  Checks.isComputerStatusParams,
);
export const validateComputerInvokeParams = createProtocolValidator(
  S.ComputerInvokeParamsSchema,
  Checks.isComputerInvokeParams,
);
export const validateAuditActivityListParams = createProtocolValidator<AuditActivityListParams>(
  S.AuditActivityListParamsSchema,
  Checks.isAuditActivityListParams,
);
export const validateAuditRunInspectParams = createProtocolValidator<AuditRunInspectParams>(
  S.AuditRunInspectParamsSchema,
  Checks.isAuditRunInspectParams,
);
export const validateAuditListParams = createProtocolValidator(
  S.AuditListParamsSchema,
  Checks.isAuditListParams,
);
export const validateWakeParams = createProtocolValidator(S.WakeParamsSchema, Checks.isWakeParams);
export const validateProgressCardGetParams = createProtocolValidator(
  S.ProgressCardGetParamsSchema,
  Checks.isProgressCardGetParams,
);
export const validateProgressCardPutParams = createProtocolValidator(
  S.ProgressCardPutParamsSchema,
  Checks.isProgressCardPutParams,
);
export const validateProgressCardRefreshParams = createProtocolValidator(
  S.ProgressCardRefreshParamsSchema,
  Checks.isProgressCardRefreshParams,
);
export const validateArtifactsListParams = createProtocolValidator(
  S.ArtifactsListParamsSchema,
  Checks.isArtifactsListParams,
);
export const validateArtifactsGetParams = createProtocolValidator(
  S.ArtifactsGetParamsSchema,
  Checks.isArtifactsGetParams,
);
export const validateArtifactsDownloadParams = createProtocolValidator(
  S.ArtifactsDownloadParamsSchema,
  Checks.isArtifactsDownloadParams,
);
export const validateEnvironmentsCreateParams = createProtocolValidator(
  S.EnvironmentsCreateParamsSchema,
  Checks.isEnvironmentsCreateParams,
);
export const validateEnvironmentsSessionCreateParams = createProtocolValidator(
  S.EnvironmentsSessionCreateParamsSchema,
  Checks.isEnvironmentsSessionCreateParams,
);
export const validateEnvironmentsSessionStatusParams = createProtocolValidator(
  S.EnvironmentsSessionStatusParamsSchema,
  Checks.isEnvironmentsSessionStatusParams,
);
export const validateEnvironmentsSessionDestroyParams = createProtocolValidator(
  S.EnvironmentsSessionDestroyParamsSchema,
  Checks.isEnvironmentsSessionDestroyParams,
);
export const validateEnvironmentsSessionExecParams = createProtocolValidator(
  S.EnvironmentsSessionExecParamsSchema,
  Checks.isEnvironmentsSessionExecParams,
);
export const validateEnvironmentsPrepareParams = createProtocolValidator(
  S.EnvironmentsPrepareParamsSchema,
  Checks.isEnvironmentsPrepareParams,
);
export const validateEnvironmentsPrepareResult = createProtocolValidator(
  S.EnvironmentsPrepareResultSchema,
  Checks.isEnvironmentsPrepareResult,
);
export const validateEnvironmentsDestroyParams = createProtocolValidator(
  S.EnvironmentsDestroyParamsSchema,
  Checks.isEnvironmentsDestroyParams,
);
export const validateEnvironmentsListParams = createProtocolValidator(
  S.EnvironmentsListParamsSchema,
  Checks.isEnvironmentsListParams,
);
export const validateEnvironmentsAdoptSuggestedProfileParams = createProtocolValidator(
  S.EnvironmentsAdoptSuggestedProfileParamsSchema,
  Checks.isEnvironmentsAdoptSuggestedProfileParams,
);
export const validateEnvironmentsStatusParams = createProtocolValidator(
  S.EnvironmentsStatusParamsSchema,
  Checks.isEnvironmentsStatusParams,
);
export const validatePortalListParams = createProtocolValidator(
  S.PortalListParamsSchema,
  Checks.isPortalListParams,
);
export const validatePortalOpenParams = createProtocolValidator(
  S.PortalOpenParamsSchema,
  Checks.isPortalOpenParams,
);
export const validatePortalCloseParams = createProtocolValidator(
  S.PortalCloseParamsSchema,
  Checks.isPortalCloseParams,
);
export const validateDesktopObserveParams = createProtocolValidator(
  S.DesktopObserveParamsSchema,
  Checks.isDesktopObserveParams,
);
export const validateDesktopObserveResult = createProtocolValidator(
  S.DesktopObserveResultSchema,
  Checks.isDesktopObserveResult,
);
export const validateDesktopLaunchParams = createProtocolValidator(
  S.DesktopLaunchParamsSchema,
  Checks.isDesktopLaunchParams,
);
export const validateDesktopReleaseParams = createProtocolValidator(
  S.DesktopReleaseParamsSchema,
  Checks.isDesktopReleaseParams,
);
export const validateDesktopReleaseResult = createProtocolValidator(
  S.DesktopReleaseResultSchema,
  Checks.isDesktopReleaseResult,
);
export const validateSystemInfoParams = createProtocolValidator(
  S.SystemInfoParamsSchema,
  Checks.isSystemInfoParams,
);
export const validateSystemInfoResult = createProtocolValidator(
  S.SystemInfoResultSchema,
  Checks.isSystemInfoResult,
);
export { validatePresenceQueryParams } from "../schema/presence.js";
export const validatePresenceQueryResult = createProtocolValidator(
  S.PresenceQueryResultSchema,
  Checks.isPresenceQueryResult,
);
export const validatePushTestParams = createProtocolValidator(
  S.PushTestParamsSchema,
  Checks.isPushTestParams,
);
export const validateSecretsResolveParams = createProtocolValidator(
  S.SecretsResolveParamsSchema,
  Checks.isSecretsResolveParams,
);
export const validateSecretsResolveResult = createProtocolValidator(
  S.SecretsResolveResultSchema,
  Checks.isSecretsResolveResult,
);
export const validateSecretsStoreListParams = createProtocolValidator(
  S.SecretsStoreListParamsSchema,
  Checks.isSecretsStoreListParams,
);
export const validateSecretsStoreListResult = createProtocolValidator(
  S.SecretsStoreListResultSchema,
  Checks.isSecretsStoreListResult,
);
export const validateSecretsStoreSetParams = createProtocolValidator(
  S.SecretsStoreSetParamsSchema,
  Checks.isSecretsStoreSetParams,
);
export const validateSecretsStoreDeleteParams = createProtocolValidator(
  S.SecretsStoreDeleteParamsSchema,
  Checks.isSecretsStoreDeleteParams,
);
export const validateSecretsStoreImportParams = createProtocolValidator(
  S.SecretsStoreImportParamsSchema,
  Checks.isSecretsStoreImportParams,
);
export const validateSecretsStoreAllowedHostsParams = createProtocolValidator(
  S.SecretsStoreAllowedHostsParamsSchema,
  Checks.isSecretsStoreAllowedHostsParams,
);
export const validateSecretsStoreMutationResult = createProtocolValidator(
  S.SecretsStoreMutationResultSchema,
  Checks.isSecretsStoreMutationResult,
);
export const validateTaskSuggestionsListParams = createProtocolValidator(
  S.TaskSuggestionsListParamsSchema,
  Checks.isTaskSuggestionsListParams,
);
export const validateTaskSuggestionsCreateParams = createProtocolValidator(
  S.TaskSuggestionsCreateParamsSchema,
  Checks.isTaskSuggestionsCreateParams,
);
export const validateTaskSuggestionsAcceptParams = createProtocolValidator(
  S.TaskSuggestionsAcceptParamsSchema,
  Checks.isTaskSuggestionsAcceptParams,
);
export const validateTaskSuggestionsDismissParams = createProtocolValidator(
  S.TaskSuggestionsDismissParamsSchema,
  Checks.isTaskSuggestionsDismissParams,
);
export const validateConfigGetParams = createProtocolValidator(
  S.ConfigGetParamsSchema,
  Checks.isConfigGetParams,
);
export const validateConfigSetParams = createProtocolValidator(
  S.ConfigSetParamsSchema,
  Checks.isConfigSetParams,
);
export const validateConfigApplyParams = createProtocolValidator(
  S.ConfigApplyParamsSchema,
  Checks.isConfigApplyParams,
);
export const validateConfigPatchParams = createProtocolValidator(
  S.ConfigPatchParamsSchema,
  Checks.isConfigPatchParams,
);
export const validateConfigSchemaParams = createProtocolValidator(
  S.ConfigSchemaParamsSchema,
  Checks.isConfigSchemaParams,
);
export const validateConfigSchemaLookupParams = createProtocolValidator(
  S.ConfigSchemaLookupParamsSchema,
  Checks.isConfigSchemaLookupParams,
);
export const validateConfigSchemaLookupResult = createProtocolValidator(
  S.ConfigSchemaLookupResultSchema,
  Checks.isConfigSchemaLookupResult,
);
export const validateSystemAgentChatParams = createProtocolValidator(
  S.SystemAgentChatParamsSchema,
  Checks.isSystemAgentChatParams,
);
export const validateSystemAgentChatHistoryParams = createProtocolValidator(
  S.SystemAgentChatHistoryParamsSchema,
  Checks.isSystemAgentChatHistoryParams,
);
export const validateSystemChangesListParams = createProtocolValidator(
  S.SystemChangesListParamsSchema,
  Checks.isSystemChangesListParams,
);
export const validateSystemAgentSetupAutoParams = createProtocolValidator(
  S.SystemAgentSetupAutoParamsSchema,
  Checks.isSystemAgentSetupAutoParams,
);
export const validateSystemAgentSetupDetectParams = createProtocolValidator(
  S.SystemAgentSetupDetectParamsSchema,
  Checks.isSystemAgentSetupDetectParams,
);
export const validateSystemAgentSetupVerifyParams = createProtocolValidator(
  S.SystemAgentSetupVerifyParamsSchema,
  Checks.isSystemAgentSetupVerifyParams,
);
export const validateSystemAgentSetupActivateParams = createProtocolValidator(
  S.SystemAgentSetupActivateParamsSchema,
  Checks.isSystemAgentSetupActivateParams,
);
export const validateSystemAgentSetupActivateStartParams = createProtocolValidator(
  S.SystemAgentSetupActivateStartParamsSchema,
  Checks.isSystemAgentSetupActivateStartParams,
);
export const validateSystemAgentSetupAuthStartParams = createProtocolValidator(
  S.SystemAgentSetupAuthStartParamsSchema,
  Checks.isSystemAgentSetupAuthStartParams,
);
export const validateSystemAgentSetupRuntimeStartParams = createProtocolValidator(
  S.SystemAgentSetupRuntimeStartParamsSchema,
  Checks.isSystemAgentSetupRuntimeStartParams,
);
export const validateWizardStartParams = createProtocolValidator(
  S.WizardStartParamsSchema,
  Checks.isWizardStartParams,
);
export const validateMcpAuthLoginParams = createProtocolValidator(
  S.McpAuthLoginParamsSchema,
  Checks.isMcpAuthLoginParams,
);
export const validateWizardNextParams = createProtocolValidator(
  S.WizardNextParamsSchema,
  Checks.isWizardNextParams,
);
export const validateWizardCancelParams = createProtocolValidator(
  S.WizardCancelParamsSchema,
  Checks.isWizardCancelParams,
);
export const validateWizardStatusParams = createProtocolValidator(
  S.WizardStatusParamsSchema,
  Checks.isWizardStatusParams,
);
export const validateTtsSpeakParams = createProtocolValidator(
  S.TtsSpeakParamsSchema,
  Checks.isTtsSpeakParams,
);
export const validateHooksStatusParams = createProtocolValidator(
  S.HooksStatusParamsSchema,
  Checks.isHooksStatusParams,
);
export const validateCronListParams = createProtocolValidator(
  S.CronListParamsSchema,
  Checks.isCronListParams,
);
export const validateCronStatusParams = createProtocolValidator(
  S.CronStatusParamsSchema,
  Checks.isCronStatusParams,
);
export const validateCronGetParams = createProtocolValidator(
  S.CronGetParamsSchema,
  Checks.isCronGetParams,
);
export const validateCronAddParams = createProtocolValidator(
  S.CronAddParamsSchema,
  Checks.isCronAddParams,
  undefined,
  cronAddDiagnostics,
);
export const validateCronUpdateParams = createProtocolValidator(
  S.CronUpdateParamsSchema,
  Checks.isCronUpdateParams,
  undefined,
  cronUpdateDiagnostics,
);
export const validateCronRemoveParams = createProtocolValidator(
  S.CronRemoveParamsSchema,
  Checks.isCronRemoveParams,
);
export const validateCronRunParams = createProtocolValidator(
  S.CronRunParamsSchema,
  Checks.isCronRunParams,
);
export const validateCronBindParams = createProtocolValidator(
  S.CronBindParamsSchema,
  Checks.isCronBindParams,
);
export const validateCronRunsParams = createProtocolValidator(
  S.CronRunsParamsSchema,
  Checks.isCronRunsParams,
);
export const validateCronHistoryParams = createProtocolValidator(
  S.CronHistoryParamsSchema,
  Checks.isCronHistoryParams,
);
export const validateCronScratchGetParams = createProtocolValidator(
  S.CronScratchGetParamsSchema,
  Checks.isCronScratchGetParams,
);
export const validateCronScratchSetParams = createProtocolValidator(
  S.CronScratchSetParamsSchema,
  Checks.isCronScratchSetParams,
);
export const validateScopeUpgradeRequest = createProtocolValidator(
  S.ScopeUpgradeRequestSchema,
  Checks.isScopeUpgradeRequest,
);
export const validateScopeUpgradeWait = createProtocolValidator(
  S.ScopeUpgradeWaitSchema,
  Checks.isScopeUpgradeWait,
);
export const validateApprovalGetParams = createProtocolValidator(
  S.ApprovalGetParamsSchema,
  Checks.isApprovalGetParams,
);
export const validateApprovalHistoryParams = createProtocolValidator(
  S.ApprovalHistoryParamsSchema,
  Checks.isApprovalHistoryParams,
);
export const validateApprovalResolveParams = createProtocolValidator(
  S.ApprovalResolveParamsSchema,
  Checks.isApprovalResolveParams,
);
export const validateExecApprovalsGetParams = createProtocolValidator(
  S.ExecApprovalsGetParamsSchema,
  Checks.isExecApprovalsGetParams,
);
export const validateExecApprovalsSetParams = createProtocolValidator(
  S.ExecApprovalsSetParamsSchema,
  Checks.isExecApprovalsSetParams,
);
export const validateExecApprovalsNativeCommitParams = createProtocolValidator(
  S.ExecApprovalsNativeCommitParamsSchema,
  Checks.isExecApprovalsNativeCommitParams,
);
export const validateExecApprovalsNativeRequest = createProtocolValidator(
  S.ExecApprovalsNativeRequestSchema,
  Checks.isExecApprovalsNativeRequest,
);
export const validateExecApprovalGetParams = createProtocolValidator(
  S.ExecApprovalGetParamsSchema,
  Checks.isExecApprovalGetParams,
);
export const validateExecApprovalRequestParams = createProtocolValidator(
  S.ExecApprovalRequestParamsSchema,
  Checks.isExecApprovalRequestParams,
);
export const validateExecApprovalResolveParams = createProtocolValidator(
  S.ExecApprovalResolveParamsSchema,
  Checks.isExecApprovalResolveParams,
);
export const validateExecApprovalGrantsListParams = createProtocolValidator(
  S.ExecApprovalGrantsListParamsSchema,
  Checks.isExecApprovalGrantsListParams,
);
export const validateExecApprovalGrantsRevokeParams = createProtocolValidator(
  S.ExecApprovalGrantsRevokeParamsSchema,
  Checks.isExecApprovalGrantsRevokeParams,
);
export const validateQuestionRequestParams = createProtocolValidator(
  S.QuestionRequestParamsSchema,
  Checks.isQuestionRequestParams,
);
export const validateQuestionWaitAnswerParams = createProtocolValidator(
  S.QuestionWaitAnswerParamsSchema,
  Checks.isQuestionWaitAnswerParams,
);
export const validateQuestionResolveParams = createProtocolValidator(
  S.QuestionResolveParamsSchema,
  Checks.isQuestionResolveParams,
);
export const validateQuestionGetParams = createProtocolValidator(
  S.QuestionGetParamsSchema,
  Checks.isQuestionGetParams,
);
export const validateQuestionListParams = createProtocolValidator(
  S.QuestionListParamsSchema,
  Checks.isQuestionListParams,
);
export const validateCapabilityConsentErrorDetails = createProtocolValidator(
  S.CapabilityConsentErrorDetailsSchema,
  Checks.isCapabilityConsentErrorDetails,
);
export const validateLogsTailParams = createProtocolValidator(
  S.LogsTailParamsSchema,
  Checks.isLogsTailParams,
);
export const validateUpdateStatusParams = createProtocolValidator(
  S.UpdateStatusParamsSchema,
  Checks.isUpdateStatusParams,
);
export const validateUpdateStatusResult = createProtocolValidator(
  S.UpdateStatusResultSchema,
  Checks.isUpdateStatusResult,
);
export const validateUpdateHoldParams = createProtocolValidator(
  S.UpdateHoldParamsSchema,
  Checks.isUpdateHoldParams,
);
export const validateUpdateHoldResult = createProtocolValidator(
  S.UpdateHoldResultSchema,
  Checks.isUpdateHoldResult,
);
export const validateUpdateRunParams = createProtocolValidator(
  S.UpdateRunParamsSchema,
  Checks.isUpdateRunParams,
);
export const validateUpdateRunRecord = createProtocolValidator(
  S.UpdateRunRecordSchema,
  Checks.isUpdateRunRecord,
);
export const validateUpdateRunResult = createProtocolValidator(
  S.UpdateRunResultSchema,
  Checks.isUpdateRunResult,
);
export const validateUpdateRecoveryCleanupParams = createProtocolValidator(
  S.UpdateRecoveryCleanupParamsSchema,
  Checks.isUpdateRecoveryCleanupParams,
);
export const validateUpdateRunsGetParams = createProtocolValidator(
  S.UpdateRunsGetParamsSchema,
  Checks.isUpdateRunsGetParams,
);
export const validateUpdateRunsGetResult = createProtocolValidator(
  S.UpdateRunsGetResultSchema,
  Checks.isUpdateRunsGetResult,
);
export const validateUpdateRunsListParams = createProtocolValidator(
  S.UpdateRunsListParamsSchema,
  Checks.isUpdateRunsListParams,
);
export const validateUpdateRunsListResult = createProtocolValidator(
  S.UpdateRunsListResultSchema,
  Checks.isUpdateRunsListResult,
);
export const validateUpdateRunChangedEvent = createProtocolValidator(
  S.UpdateRunChangedEventSchema,
  Checks.isUpdateRunChangedEvent,
);
export const validateUpdateReportParams = createProtocolValidator(
  S.UpdateReportParamsSchema,
  Checks.isUpdateReportParams,
);
export const validateUpdateReportResult = createProtocolValidator(
  S.UpdateReportResultSchema,
  Checks.isUpdateReportResult,
);
export const validateUiCommandParams = createProtocolValidator(
  S.UiCommandParamsSchema,
  Checks.isUiCommandParams,
);
export const validateUiCommandReportParams = createProtocolValidator(
  S.UiCommandReportParamsSchema,
  Checks.isUiCommandReportParams,
);
export const validateThemesListParams = createProtocolValidator(
  S.ThemesListParamsSchema,
  Checks.isThemesListParams,
);
export const validateThemesGetParams = createProtocolValidator(
  S.ThemesGetParamsSchema,
  Checks.isThemesGetParams,
);
export const validateThemesSetParams = createProtocolValidator(
  S.ThemesSetParamsSchema,
  Checks.isThemesSetParams,
);
export const validateThemesImportParams = createProtocolValidator(
  S.ThemesImportParamsSchema,
  Checks.isThemesImportParams,
);
export const validateCatalogBrowseParams = createProtocolValidator(
  S.CatalogBrowseParamsSchema,
  Checks.isCatalogBrowseParams,
);
export const validateCatalogSearchKeywordsParams = createProtocolValidator(
  S.CatalogSearchKeywordsParamsSchema,
  Checks.isCatalogSearchKeywordsParams,
);
