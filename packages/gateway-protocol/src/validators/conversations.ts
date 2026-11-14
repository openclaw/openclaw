import * as Checks from "../compiled/protocol.generated/validators-conversations.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";

export const validateConversationListParams = createProtocolValidator(
  S.ConversationListParamsSchema,
  Checks.isConversationListParams,
);
export const validateConversationSendParams = createProtocolValidator(
  S.ConversationSendParamsSchema,
  Checks.isConversationSendParams,
);
export const validateConversationTurnCancelParams = createProtocolValidator(
  S.ConversationTurnCancelParamsSchema,
  Checks.isConversationTurnCancelParams,
);
export const validateConversationTurnParams = createProtocolValidator(
  S.ConversationTurnParamsSchema,
  Checks.isConversationTurnParams,
);
export const validateUsersListParams = createProtocolValidator(
  S.UsersListParamsSchema,
  Checks.isUsersListParams,
);
export const validateUsersMentionableParams = createProtocolValidator(
  S.UsersMentionableParamsSchema,
  Checks.isUsersMentionableParams,
);
export const validateUsersMentionableResult = createProtocolValidator(
  S.UsersMentionableResultSchema,
  Checks.isUsersMentionableResult,
);
export const validateMentionsListParams = createProtocolValidator(
  S.MentionsListParamsSchema,
  Checks.isMentionsListParams,
);
export const validateMentionsDismissParams = createProtocolValidator(
  S.MentionsDismissParamsSchema,
  Checks.isMentionsDismissParams,
);
export const validateMentionsListResult = createProtocolValidator(
  S.MentionsListResultSchema,
  Checks.isMentionsListResult,
);
export const validateMentionsChangedEvent = createProtocolValidator(
  S.MentionsChangedEventSchema,
  Checks.isMentionsChangedEvent,
);
export const validateMentionsFailedEvent = createProtocolValidator(
  S.MentionsFailedEventSchema,
  Checks.isMentionsFailedEvent,
);
export const validateUsersBackgroundGetParams = createProtocolValidator(
  S.UsersBackgroundGetParamsSchema,
  Checks.isUsersBackgroundGetParams,
);
export const validateUsersBackgroundUploadParams = createProtocolValidator(
  S.UsersBackgroundUploadParamsSchema,
  Checks.isUsersBackgroundUploadParams,
);
export const validateUsersBackgroundRemoveParams = createProtocolValidator(
  S.UsersBackgroundRemoveParamsSchema,
  Checks.isUsersBackgroundRemoveParams,
);
export const validateUsersPrefsGetParams = createProtocolValidator(
  S.UsersPrefsGetParamsSchema,
  Checks.isUsersPrefsGetParams,
);
export const validateUsersPrefsSetParams = createProtocolValidator(
  S.UsersPrefsSetParamsSchema,
  Checks.isUsersPrefsSetParams,
);
export const validateUsersPersonalFileGetParams = createProtocolValidator(
  S.UsersPersonalFileGetParamsSchema,
  Checks.isUsersPersonalFileGetParams,
);
export const validateUsersPersonalFileSetParams = createProtocolValidator(
  S.UsersPersonalFileSetParamsSchema,
  Checks.isUsersPersonalFileSetParams,
);
export const validateUsersSelfParams = createProtocolValidator(
  S.UsersSelfParamsSchema,
  Checks.isUsersSelfParams,
);
export const validateUsersGitHubStatusParams = createProtocolValidator(
  S.UsersGitHubStatusParamsSchema,
  Checks.isUsersGitHubStatusParams,
);
export const validateUsersGitHubAuthorizeStartParams = createProtocolValidator(
  S.UsersGitHubAuthorizeStartParamsSchema,
  Checks.isUsersGitHubAuthorizeStartParams,
);
export const validateUsersGitHubAuthorizePollParams = createProtocolValidator(
  S.UsersGitHubAuthorizePollParamsSchema,
  Checks.isUsersGitHubAuthorizePollParams,
);
export const validateUsersGitHubAuthorizeCancelParams = createProtocolValidator(
  S.UsersGitHubAuthorizeCancelParamsSchema,
  Checks.isUsersGitHubAuthorizeCancelParams,
);
export const validateUsersGitHubDisconnectParams = createProtocolValidator(
  S.UsersGitHubDisconnectParamsSchema,
  Checks.isUsersGitHubDisconnectParams,
);
export const validateUsersSelfResult = createProtocolValidator(
  S.UsersSelfResultSchema,
  Checks.isUsersSelfResult,
);
export const validateUsersLinkEmailParams = createProtocolValidator(
  S.UsersLinkEmailParamsSchema,
  Checks.isUsersLinkEmailParams,
);
export const validateUsersLinkEmailResult = createProtocolValidator(
  S.UsersLinkEmailResultSchema,
  Checks.isUsersLinkEmailResult,
);
export const validateUsersMergeParams = createProtocolValidator(
  S.UsersMergeParamsSchema,
  Checks.isUsersMergeParams,
);
export const validateUsersMergeResult = createProtocolValidator(
  S.UsersMergeResultSchema,
  Checks.isUsersMergeResult,
);
export const validateUsersLinkChannelIdentityParams = createProtocolValidator(
  S.UsersLinkChannelIdentityParamsSchema,
  Checks.isUsersLinkChannelIdentityParams,
);
export const validateUsersLinkChannelIdentityResult = createProtocolValidator(
  S.UsersLinkChannelIdentityResultSchema,
  Checks.isUsersLinkChannelIdentityResult,
);
export const validateUsersUnlinkChannelIdentityParams = createProtocolValidator(
  S.UsersUnlinkChannelIdentityParamsSchema,
  Checks.isUsersUnlinkChannelIdentityParams,
);
export const validateUsersUnlinkChannelIdentityResult = createProtocolValidator(
  S.UsersUnlinkChannelIdentityResultSchema,
  Checks.isUsersUnlinkChannelIdentityResult,
);
export const validateUsersListChannelIdentitiesParams = createProtocolValidator(
  S.UsersListChannelIdentitiesParamsSchema,
  Checks.isUsersListChannelIdentitiesParams,
);
export const validateUsersListChannelIdentitiesResult = createProtocolValidator(
  S.UsersListChannelIdentitiesResultSchema,
  Checks.isUsersListChannelIdentitiesResult,
);
export const validateUsersSetDisplayNameParams = createProtocolValidator(
  S.UsersSetDisplayNameParamsSchema,
  Checks.isUsersSetDisplayNameParams,
);
export const validateUsersSetDisplayNameResult = createProtocolValidator(
  S.UsersSetDisplayNameResultSchema,
  Checks.isUsersSetDisplayNameResult,
);
export const validateUsersSetRoleParams = createProtocolValidator(
  S.UsersSetRoleParamsSchema,
  Checks.isUsersSetRoleParams,
);
export const validateUsersSetRoleResult = createProtocolValidator(
  S.UsersSetRoleResultSchema,
  Checks.isUsersSetRoleResult,
);
export const validateUsersSetAvatarParams = createProtocolValidator(
  S.UsersSetAvatarParamsSchema,
  Checks.isUsersSetAvatarParams,
);
export const validateUsersSetAvatarResult = createProtocolValidator(
  S.UsersSetAvatarResultSchema,
  Checks.isUsersSetAvatarResult,
);
export const validateUsersListAuthLinksParams = createProtocolValidator(
  S.UsersListAuthLinksParamsSchema,
  Checks.isUsersListAuthLinksParams,
);
export const validateUsersListModelAccountsParams = createProtocolValidator(
  S.UsersListModelAccountsParamsSchema,
  Checks.isUsersListModelAccountsParams,
);
export const validateUsersSelectModelAccountParams = createProtocolValidator(
  S.UsersSelectModelAccountParamsSchema,
  Checks.isUsersSelectModelAccountParams,
);
export const validateUsersAuthConnectCatalogParams = createProtocolValidator(
  S.UsersAuthConnectCatalogParamsSchema,
  Checks.isUsersAuthConnectCatalogParams,
);
export const validateUsersAuthConnectStartParams = createProtocolValidator(
  S.UsersAuthConnectStartParamsSchema,
  Checks.isUsersAuthConnectStartParams,
);
export const validateUsersAuthConnectAnswerParams = createProtocolValidator(
  S.UsersAuthConnectAnswerParamsSchema,
  Checks.isUsersAuthConnectAnswerParams,
);
export const validateUsersAuthConnectStatusParams = createProtocolValidator(
  S.UsersAuthConnectStatusParamsSchema,
  Checks.isUsersAuthConnectStatusParams,
);
export const validateUsersAuthConnectCancelParams = createProtocolValidator(
  S.UsersAuthConnectCancelParamsSchema,
  Checks.isUsersAuthConnectCancelParams,
);
export const validateUsersLinkAuthProfileParams = createProtocolValidator(
  S.UsersLinkAuthProfileParamsSchema,
  Checks.isUsersLinkAuthProfileParams,
);
export const validateUsersUnlinkAuthProfileParams = createProtocolValidator(
  S.UsersUnlinkAuthProfileParamsSchema,
  Checks.isUsersUnlinkAuthProfileParams,
);
export const validateChatHistoryParams = createProtocolValidator(
  S.ChatHistoryParamsSchema,
  Checks.isChatHistoryParams,
);
export const validateChatStartupParams = createProtocolValidator(
  S.ChatStartupParamsSchema,
  Checks.isChatStartupParams,
);
export const validateChatMetadataParams = createProtocolValidator(
  S.ChatMetadataParamsSchema,
  Checks.isChatMetadataParams,
);
export const validateChatMessageGetParams = createProtocolValidator(
  S.ChatMessageGetParamsSchema,
  Checks.isChatMessageGetParams,
);
export const validateChatToolTitlesParams = createProtocolValidator(
  S.ChatToolTitlesParamsSchema,
  Checks.isChatToolTitlesParams,
);
export const validateChatPendingInputsDismissParams = createProtocolValidator(
  S.ChatPendingInputsDismissParamsSchema,
  Checks.isChatPendingInputsDismissParams,
);
export const validateChatPredictParams = createProtocolValidator(
  S.ChatPredictParamsSchema,
  Checks.isChatPredictParams,
);
export const validateChatSendParams = createProtocolValidator(
  S.ChatSendParamsSchema,
  Checks.isChatSendParams,
);
export const validateChatAbortParams = createProtocolValidator(
  S.ChatAbortParamsSchema,
  Checks.isChatAbortParams,
);
export const validateChatInjectParams = createProtocolValidator(
  S.ChatInjectParamsSchema,
  Checks.isChatInjectParams,
);
export const validateTranscriptsListParams = createProtocolValidator(
  S.TranscriptsListParamsSchema,
  Checks.isTranscriptsListParams,
);
export const validateTranscriptsSummarizeParams = createProtocolValidator(
  S.TranscriptsSummarizeParamsSchema,
  Checks.isTranscriptsSummarizeParams,
);
export const validateTranscriptsGetParams = createProtocolValidator(
  S.TranscriptsGetParamsSchema,
  Checks.isTranscriptsGetParams,
);
export const validateTranscriptsExportParams = createProtocolValidator(
  S.TranscriptsExportParamsSchema,
  Checks.isTranscriptsExportParams,
);
export const validateTranscriptsStatusParams = createProtocolValidator(
  S.TranscriptsStatusParamsSchema,
  Checks.isTranscriptsStatusParams,
);
