import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import * as Checks from "../compiled/protocol.generated/validators-sessions.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";

// Runs before the schema: compare only numeric boundaries and leave type errors to the schema.
function checkPulseBoundaries(data: unknown) {
  const boundaries = asNullableRecord(data)?.activityPulseBoundaries;
  return Array.isArray(boundaries) &&
    boundaries.every((boundary): boundary is number => typeof boundary === "number") &&
    boundaries.some((boundary, index) => boundary <= (boundaries[index - 1] ?? -Infinity))
    ? {
        keyword: "ascending",
        instancePath: "/activityPulseBoundaries",
        message: "must be strictly ascending",
      }
    : undefined;
}

export const validateSessionPortalListParams = createProtocolValidator(
  S.SessionPortalListParamsSchema,
  Checks.isSessionPortalListParams,
);
export const validateSessionPortalOpenParams = createProtocolValidator(
  S.SessionPortalOpenParamsSchema,
  Checks.isSessionPortalOpenParams,
);
export const validateSessionPortalCloseParams = createProtocolValidator(
  S.SessionPortalCloseParamsSchema,
  Checks.isSessionPortalCloseParams,
);
export const validateSessionsListParams = createProtocolValidator(
  S.SessionsListParamsSchema,
  Checks.isSessionsListParams,
  checkPulseBoundaries,
);
export const validateSessionsSubscribeParams = createProtocolValidator(
  S.SessionsSubscribeParamsSchema,
  Checks.isSessionsSubscribeParams,
  checkPulseBoundaries,
);
export const validateSessionCatalogShareRoute = createProtocolValidator(
  S.SessionCatalogShareRouteSchema,
  Checks.isSessionCatalogShareRoute,
);
export const validateSessionsCatalogListParams = createProtocolValidator(
  S.SessionsCatalogListParamsSchema,
  Checks.isSessionsCatalogListParams,
);
export const validateSessionsCatalogReadParams = createProtocolValidator(
  S.SessionsCatalogReadParamsSchema,
  Checks.isSessionsCatalogReadParams,
);
export const validateSessionsCatalogContinueParams = createProtocolValidator(
  S.SessionsCatalogContinueParamsSchema,
  Checks.isSessionsCatalogContinueParams,
);
export const validateSessionsCatalogImportParams = createProtocolValidator(
  S.SessionsCatalogImportParamsSchema,
  Checks.isSessionsCatalogImportParams,
);
export const validateSessionsCatalogArchiveParams = createProtocolValidator(
  S.SessionsCatalogArchiveParamsSchema,
  Checks.isSessionsCatalogArchiveParams,
);
export const validateSessionsCatalogStartTerminalParams = createProtocolValidator(
  S.SessionsCatalogStartTerminalParamsSchema,
  Checks.isSessionsCatalogStartTerminalParams,
);
export const validateSessionsSearchParams = createProtocolValidator(
  S.SessionsSearchParamsSchema,
  Checks.isSessionsSearchParams,
);
export const validateSessionsCleanupParams = createProtocolValidator(
  S.SessionsCleanupParamsSchema,
  Checks.isSessionsCleanupParams,
);
export const validateSessionsStorageParams = createProtocolValidator(
  S.SessionsStorageParamsSchema,
  Checks.isSessionsStorageParams,
);
export const validateSessionsPreviewParams = createProtocolValidator(
  S.SessionsPreviewParamsSchema,
  Checks.isSessionsPreviewParams,
);
export const validateSessionsDescribeParams = createProtocolValidator(
  S.SessionsDescribeParamsSchema,
  Checks.isSessionsDescribeParams,
);
export const validateSessionsResolveParams = createProtocolValidator(
  S.SessionsResolveParamsSchema,
  Checks.isSessionsResolveParams,
);
export const validateSessionsFilesListParams = createProtocolValidator(
  S.SessionsFilesListParamsSchema,
  Checks.isSessionsFilesListParams,
);
export const validateSessionsFilesGetParams = createProtocolValidator(
  S.SessionsFilesGetParamsSchema,
  Checks.isSessionsFilesGetParams,
);
export const validateSessionsFilesDownloadParams = createProtocolValidator(
  S.SessionsFilesDownloadParamsSchema,
  Checks.isSessionsFilesDownloadParams,
);
export const validateSessionsFilesAssetsParams = createProtocolValidator(
  S.SessionsFilesAssetsParamsSchema,
  Checks.isSessionsFilesAssetsParams,
);
export const validateSessionsFilesSetParams = createProtocolValidator(
  S.SessionsFilesSetParamsSchema,
  Checks.isSessionsFilesSetParams,
);
export const validateSessionsFilesRevealParams = createProtocolValidator(
  S.SessionsFilesRevealParamsSchema,
  Checks.isSessionsFilesRevealParams,
);
export const validateSessionsDiffParams = createProtocolValidator(
  S.SessionsDiffParamsSchema,
  Checks.isSessionsDiffParams,
);
export const validateSessionsCompanionAskParams = createProtocolValidator(
  S.SessionsCompanionAskParamsSchema,
  Checks.isSessionsCompanionAskParams,
);
export const validateSessionsCompanionStateParams = createProtocolValidator(
  S.SessionsCompanionStateParamsSchema,
  Checks.isSessionsCompanionStateParams,
);
export const validateSessionsCompanionResetParams = createProtocolValidator(
  S.SessionsCompanionResetParamsSchema,
  Checks.isSessionsCompanionResetParams,
);
export const validateSessionsActivitySummaryEnsureParams = createProtocolValidator(
  S.SessionsActivitySummaryEnsureParamsSchema,
  Checks.isSessionsActivitySummaryEnsureParams,
);
export const validateSessionsObserverVisibilityParams = createProtocolValidator(
  S.SessionsObserverVisibilityParamsSchema,
  Checks.isSessionsObserverVisibilityParams,
);
export const validateSessionVisibilitySetParams = createProtocolValidator(
  S.SessionVisibilitySetParamsSchema,
  Checks.isSessionVisibilitySetParams,
);
export const validateSessionPublicShareSetParams = createProtocolValidator(
  S.SessionPublicShareSetParamsSchema,
  Checks.isSessionPublicShareSetParams,
);
export const validateSessionMembersListParams = createProtocolValidator(
  S.SessionMembersListParamsSchema,
  Checks.isSessionMembersListParams,
);
export const validateSessionMemberAddParams = createProtocolValidator(
  S.SessionMemberAddParamsSchema,
  Checks.isSessionMemberAddParams,
);
export const validateSessionMemberRemoveParams = createProtocolValidator(
  S.SessionMemberRemoveParamsSchema,
  Checks.isSessionMemberRemoveParams,
);
export const validateSessionSuggestionsAddParams = createProtocolValidator(
  S.SessionSuggestionsAddParamsSchema,
  Checks.isSessionSuggestionsAddParams,
);
export const validateSessionSuggestionsListParams = createProtocolValidator(
  S.SessionSuggestionsListParamsSchema,
  Checks.isSessionSuggestionsListParams,
);
export const validateSessionSuggestionsResolveParams = createProtocolValidator(
  S.SessionSuggestionsResolveParamsSchema,
  Checks.isSessionSuggestionsResolveParams,
);
export const validateSessionTypingParams = createProtocolValidator(
  S.SessionTypingParamsSchema,
  Checks.isSessionTypingParams,
);
export const validateSessionReactionsSetParams = createProtocolValidator(
  S.SessionReactionsSetParamsSchema,
  Checks.isSessionReactionsSetParams,
);
export const validateSessionReactionsListParams = createProtocolValidator(
  S.SessionReactionsListParamsSchema,
  Checks.isSessionReactionsListParams,
);
export const validateSessionReactionEvent = createProtocolValidator(
  S.SessionReactionEventSchema,
  Checks.isSessionReactionEvent,
);
export const validateSessionsCreateParams = createProtocolValidator(
  S.SessionsCreateParamsSchema,
  Checks.isSessionsCreateParams,
);
export const validateSessionsTitlePrepareParams = createProtocolValidator(
  S.SessionsTitlePrepareParamsSchema,
  Checks.isSessionsTitlePrepareParams,
);
export const validateSessionsSendParams = createProtocolValidator(
  S.SessionsSendParamsSchema,
  Checks.isSessionsSendParams,
);
export const validateSessionsReclaimParams = createProtocolValidator(
  S.SessionsReclaimParamsSchema,
  Checks.isSessionsReclaimParams,
);
export const validateSessionsReclaimResult = createProtocolValidator(
  S.SessionsReclaimResultSchema,
  Checks.isSessionsReclaimResult,
);
export const validateSessionsMoveResult = createProtocolValidator(
  S.SessionsMoveResultSchema,
  Checks.isSessionsMoveResult,
);
export const validateSessionsMessagesSubscribeParams = createProtocolValidator(
  S.SessionsMessagesSubscribeParamsSchema,
  Checks.isSessionsMessagesSubscribeParams,
);
export const validateSessionsMessagesUnsubscribeParams = createProtocolValidator(
  S.SessionsMessagesUnsubscribeParamsSchema,
  Checks.isSessionsMessagesUnsubscribeParams,
);
export const validateSessionsViewerPresenceSetParams = createProtocolValidator(
  S.SessionsViewerPresenceSetParamsSchema,
  Checks.isSessionsViewerPresenceSetParams,
);
export const validateSessionsAbortParams = createProtocolValidator(
  S.SessionsAbortParamsSchema,
  Checks.isSessionsAbortParams,
);
export const validateSessionsPatchParams = createProtocolValidator(
  S.SessionsPatchParamsSchema,
  Checks.isSessionsPatchParams,
);
export const validateSessionsGoalUpdateParams = createProtocolValidator(
  S.SessionsGoalUpdateParamsSchema,
  Checks.isSessionsGoalUpdateParams,
);
export const validateSessionsGoalClearParams = createProtocolValidator(
  S.SessionsGoalClearParamsSchema,
  Checks.isSessionsGoalClearParams,
);
export const validateSessionsProviderReviewContinueParams = createProtocolValidator(
  S.SessionsProviderReviewContinueParamsSchema,
  Checks.isSessionsProviderReviewContinueParams,
);
export const validateSessionsPatchManyParams = createProtocolValidator(
  S.SessionsPatchManyParamsSchema,
  Checks.isSessionsPatchManyParams,
);
export const validateSessionsPluginPatchParams = createProtocolValidator(
  S.SessionsPluginPatchParamsSchema,
  Checks.isSessionsPluginPatchParams,
);
export const validateSessionsResetParams = createProtocolValidator(
  S.SessionsResetParamsSchema,
  Checks.isSessionsResetParams,
);
export const validateSessionsDeleteParams = createProtocolValidator(
  S.SessionsDeleteParamsSchema,
  Checks.isSessionsDeleteParams,
);
export const validateSessionsAssignOwnerParams = createProtocolValidator(
  S.SessionsAssignOwnerParamsSchema,
  Checks.isSessionsAssignOwnerParams,
);
export const validateSessionsSetInvolvementParams = createProtocolValidator(
  S.SessionsSetInvolvementParamsSchema,
  Checks.isSessionsSetInvolvementParams,
);
export const validateSessionsGroupsListParams = createProtocolValidator(
  S.SessionsGroupsListParamsSchema,
  Checks.isSessionsGroupsListParams,
);
export const validateSessionsGroupsListResult = createProtocolValidator(
  S.SessionsGroupsListResultSchema,
  Checks.isSessionsGroupsListResult,
);
export const validateSessionsGroupsDefaultsParams = createProtocolValidator(
  S.SessionsGroupsDefaultsParamsSchema,
  Checks.isSessionsGroupsDefaultsParams,
);
export const validateSessionsGroupsDefaultsResult = createProtocolValidator(
  S.SessionsGroupsDefaultsResultSchema,
  Checks.isSessionsGroupsDefaultsResult,
);
export const validateSessionsGroupsPutParams = createProtocolValidator(
  S.SessionsGroupsPutParamsSchema,
  Checks.isSessionsGroupsPutParams,
);
export const validateSessionsGroupsRenameParams = createProtocolValidator(
  S.SessionsGroupsRenameParamsSchema,
  Checks.isSessionsGroupsRenameParams,
);
export const validateSessionsGroupsUpdateParams = createProtocolValidator(
  S.SessionsGroupsUpdateParamsSchema,
  Checks.isSessionsGroupsUpdateParams,
);
export const validateSessionsGroupsUpdateResult = createProtocolValidator(
  S.SessionsGroupsUpdateResultSchema,
  Checks.isSessionsGroupsUpdateResult,
);
export const validateSessionsGroupsDeleteParams = createProtocolValidator(
  S.SessionsGroupsDeleteParamsSchema,
  Checks.isSessionsGroupsDeleteParams,
);
export const validateSessionsGroupsMutationResult = createProtocolValidator(
  S.SessionsGroupsMutationResultSchema,
  Checks.isSessionsGroupsMutationResult,
);
export const validateSessionsCompactParams = createProtocolValidator(
  S.SessionsCompactParamsSchema,
  Checks.isSessionsCompactParams,
);
export const validateSessionsBranchesListParams = createProtocolValidator(
  S.SessionsBranchesListParamsSchema,
  Checks.isSessionsBranchesListParams,
);
export const validateSessionsBranchesSwitchParams = createProtocolValidator(
  S.SessionsBranchesSwitchParamsSchema,
  Checks.isSessionsBranchesSwitchParams,
);
export const validateSessionsRewindParams = createProtocolValidator(
  S.SessionsRewindParamsSchema,
  Checks.isSessionsRewindParams,
);
export const validateSessionsForkParams = createProtocolValidator(
  S.SessionsForkParamsSchema,
  Checks.isSessionsForkParams,
);
export const validateSessionsUsageParams = createProtocolValidator(
  S.SessionsUsageParamsSchema,
  Checks.isSessionsUsageParams,
);
export const validateSessionDiscussionInfoParams = createProtocolValidator(
  S.SessionDiscussionInfoParamsSchema,
  Checks.isSessionDiscussionInfoParams,
);
export const validateSessionDiscussionInfoResult = createProtocolValidator(
  S.SessionDiscussionInfoResultSchema,
  Checks.isSessionDiscussionInfoResult,
);
export const validateSessionDiscussionOpenParams = createProtocolValidator(
  S.SessionDiscussionOpenParamsSchema,
  Checks.isSessionDiscussionOpenParams,
);
export const validateSessionDiscussionOpenResult = createProtocolValidator(
  S.SessionDiscussionOpenResultSchema,
  Checks.isSessionDiscussionOpenResult,
);
export const validateSessionGitHubPublishParams = createProtocolValidator(
  S.SessionGitHubPublishParamsSchema,
  Checks.isSessionGitHubPublishParams,
);
export const validateSessionGitHubActionParams = createProtocolValidator(
  S.SessionGitHubActionParamsSchema,
  Checks.isSessionGitHubActionParams,
);
export const validateSessionGitHubOptionsParams = createProtocolValidator(
  S.SessionGitHubOptionsParamsSchema,
  Checks.isSessionGitHubOptionsParams,
);
export const validateSessionGitHubStatusParams = createProtocolValidator(
  S.SessionGitHubStatusParamsSchema,
  Checks.isSessionGitHubStatusParams,
);
export const validateSessionGitHubConfirmParams = createProtocolValidator(
  S.SessionGitHubConfirmParamsSchema,
  Checks.isSessionGitHubConfirmParams,
);
