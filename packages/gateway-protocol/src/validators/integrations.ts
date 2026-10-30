import * as Checks from "../compiled/protocol.generated/validators-integrations.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";
import type {
  WebPushSubscribeParams,
  WebPushPreferencesGetParams,
  WebPushPreferencesSetParams,
  WebPushTestParams,
  WebPushUnsubscribeParams,
  WebPushVapidPublicKeyParams,
} from "../schema-modules.js";

export const validateMessageActionParams = createProtocolValidator(
  S.MessageActionParamsSchema,
  Checks.isMessageActionParams,
);
export const validateSendParams = createProtocolValidator(S.SendParamsSchema, Checks.isSendParams);
export const validatePollParams = createProtocolValidator(S.PollParamsSchema, Checks.isPollParams);
export const validateWebPushVapidPublicKeyParams =
  createProtocolValidator<WebPushVapidPublicKeyParams>(
    S.WebPushVapidPublicKeyParamsSchema,
    Checks.isWebPushVapidPublicKeyParams,
  );
export const validateWebPushSubscribeParams = createProtocolValidator<WebPushSubscribeParams>(
  S.WebPushSubscribeParamsSchema,
  Checks.isWebPushSubscribeParams,
);
export const validateWebPushUnsubscribeParams = createProtocolValidator<WebPushUnsubscribeParams>(
  S.WebPushUnsubscribeParamsSchema,
  Checks.isWebPushUnsubscribeParams,
);
export const validateWebPushTestParams = createProtocolValidator<WebPushTestParams>(
  S.WebPushTestParamsSchema,
  Checks.isWebPushTestParams,
);
export const validateWebPushPreferencesGetParams =
  createProtocolValidator<WebPushPreferencesGetParams>(
    S.WebPushPreferencesGetParamsSchema,
    Checks.isWebPushPreferencesGetParams,
  );
export const validateWebPushPreferencesSetParams =
  createProtocolValidator<WebPushPreferencesSetParams>(
    S.WebPushPreferencesSetParamsSchema,
    Checks.isWebPushPreferencesSetParams,
  );
export const validateTalkModeParams = createProtocolValidator(
  S.TalkModeParamsSchema,
  Checks.isTalkModeParams,
);
export const validateTalkCatalogParams = createProtocolValidator(
  S.TalkCatalogParamsSchema,
  Checks.isTalkCatalogParams,
);
export const validateTalkVoiceGetParams = createProtocolValidator(
  S.TalkVoiceGetParamsSchema,
  Checks.isTalkVoiceGetParams,
);
export const validateTalkVoiceSetParams = createProtocolValidator(
  S.TalkVoiceSetParamsSchema,
  Checks.isTalkVoiceSetParams,
);
export const validateTalkVoiceCompleteParams = createProtocolValidator(
  S.TalkVoiceCompleteParamsSchema,
  Checks.isTalkVoiceCompleteParams,
);
export const validateTalkVoiceChangeEvent = createProtocolValidator(
  S.TalkVoiceChangeEventSchema,
  Checks.isTalkVoiceChangeEvent,
);
export const validateTalkConfigParams = createProtocolValidator(
  S.TalkConfigParamsSchema,
  Checks.isTalkConfigParams,
);
export const validateTalkConfigResult = createProtocolValidator(
  S.TalkConfigResultSchema,
  Checks.isTalkConfigResult,
);
export const validateTalkClientCreateParams = createProtocolValidator(
  S.TalkClientCreateParamsSchema,
  Checks.isTalkClientCreateParams,
);
export const validateTalkClientCreateResult = createProtocolValidator(
  S.TalkClientCreateResultSchema,
  Checks.isTalkClientCreateResult,
);
export const validateTalkClientCloseParams = createProtocolValidator(
  S.TalkClientCloseParamsSchema,
  Checks.isTalkClientCloseParams,
);
export const validateTalkClientMutationResult = createProtocolValidator(
  S.TalkClientMutationResultSchema,
  Checks.isTalkClientMutationResult,
);
export const validateTalkClientToolCallParams = createProtocolValidator(
  S.TalkClientToolCallParamsSchema,
  Checks.isTalkClientToolCallParams,
);
export const validateTalkClientToolCallResult = createProtocolValidator(
  S.TalkClientToolCallResultSchema,
  Checks.isTalkClientToolCallResult,
);
export const validateTalkClientTranscriptParams = createProtocolValidator(
  S.TalkClientTranscriptParamsSchema,
  Checks.isTalkClientTranscriptParams,
);
export const validateTalkClientSayParams = createProtocolValidator(
  S.TalkClientSayParamsSchema,
  Checks.isTalkClientSayParams,
);
export const validateTalkClientSteerParams = createProtocolValidator(
  S.TalkClientSteerParamsSchema,
  Checks.isTalkClientSteerParams,
);
export const validateTalkSessionCreateParams = createProtocolValidator(
  S.TalkSessionCreateParamsSchema,
  Checks.isTalkSessionCreateParams,
);
export const validateTalkSessionAppendAudioParams = createProtocolValidator(
  S.TalkSessionAppendAudioParamsSchema,
  Checks.isTalkSessionAppendAudioParams,
);
export const validateTalkSessionAcknowledgeMarkParams = createProtocolValidator(
  S.TalkSessionAcknowledgeMarkParamsSchema,
  Checks.isTalkSessionAcknowledgeMarkParams,
);
export const validateTalkSessionCancelOutputParams = createProtocolValidator(
  S.TalkSessionCancelOutputParamsSchema,
  Checks.isTalkSessionCancelOutputParams,
);
export const validateTalkSessionCancelOutputResult = createProtocolValidator(
  S.TalkSessionCancelOutputResultSchema,
  Checks.isTalkSessionCancelOutputResult,
);
export const validateTalkSessionSteerParams = createProtocolValidator(
  S.TalkSessionSteerParamsSchema,
  Checks.isTalkSessionSteerParams,
);
export const validateTalkSessionSubmitToolResultParams = createProtocolValidator(
  S.TalkSessionSubmitToolResultParamsSchema,
  Checks.isTalkSessionSubmitToolResultParams,
);
export const validateTalkSessionCloseParams = createProtocolValidator(
  S.TalkSessionCloseParamsSchema,
  Checks.isTalkSessionCloseParams,
);
export const validateTalkSpeakParams = createProtocolValidator(
  S.TalkSpeakParamsSchema,
  Checks.isTalkSpeakParams,
);
export const validateChannelsStatusParams = createProtocolValidator(
  S.ChannelsStatusParamsSchema,
  Checks.isChannelsStatusParams,
);
export const validateChannelsPairingListParams = createProtocolValidator(
  S.ChannelsPairingListParamsSchema,
  Checks.isChannelsPairingListParams,
);
export const validateChannelsPairingApproveParams = createProtocolValidator(
  S.ChannelsPairingApproveParamsSchema,
  Checks.isChannelsPairingApproveParams,
);
export const validateChannelsPairingDismissParams = createProtocolValidator(
  S.ChannelsPairingDismissParamsSchema,
  Checks.isChannelsPairingDismissParams,
);
export const validateChannelsStartParams = createProtocolValidator(
  S.ChannelsStartParamsSchema,
  Checks.isChannelsStartParams,
);
export const validateChannelsStopParams = createProtocolValidator(
  S.ChannelsStopParamsSchema,
  Checks.isChannelsStopParams,
);
export const validateChannelsLogoutParams = createProtocolValidator(
  S.ChannelsLogoutParamsSchema,
  Checks.isChannelsLogoutParams,
);
export const validatePluginApprovalRequestParams = createProtocolValidator(
  S.PluginApprovalRequestParamsSchema,
  Checks.isPluginApprovalRequestParams,
);
export const validatePluginApprovalResolveParams = createProtocolValidator(
  S.PluginApprovalResolveParamsSchema,
  Checks.isPluginApprovalResolveParams,
);
export const validatePluginsListParams = createProtocolValidator(
  S.PluginsListParamsSchema,
  Checks.isPluginsListParams,
);
export const validatePluginsInspectParams = createProtocolValidator(
  S.PluginsInspectParamsSchema,
  Checks.isPluginsInspectParams,
);
export const validatePluginsRefreshParams = createProtocolValidator(
  S.PluginsRefreshParamsSchema,
  Checks.isPluginsRefreshParams,
);
export const validatePluginsReloadParams = createProtocolValidator(
  S.PluginsReloadParamsSchema,
  Checks.isPluginsReloadParams,
);
export const validatePluginsSearchParams = createProtocolValidator(
  S.PluginsSearchParamsSchema,
  Checks.isPluginsSearchParams,
);
export const validatePluginsCatalogBrowseParams = createProtocolValidator(
  S.PluginsCatalogBrowseParamsSchema,
  Checks.isPluginsCatalogBrowseParams,
);
export const validatePluginsCatalogCategoriesParams = createProtocolValidator(
  S.PluginsCatalogCategoriesParamsSchema,
  Checks.isPluginsCatalogCategoriesParams,
);
export const validatePluginsCatalogGetParams = createProtocolValidator(
  S.PluginsCatalogGetParamsSchema,
  Checks.isPluginsCatalogGetParams,
);
export const validatePluginsInstallParams = createProtocolValidator(
  S.PluginsInstallParamsSchema,
  Checks.isPluginsInstallParams,
);
export const validatePluginsSetEnabledParams = createProtocolValidator(
  S.PluginsSetEnabledParamsSchema,
  Checks.isPluginsSetEnabledParams,
);
export const validatePluginsUninstallParams = createProtocolValidator(
  S.PluginsUninstallParamsSchema,
  Checks.isPluginsUninstallParams,
);
export const validatePluginsUiDescriptorsParams = createProtocolValidator(
  S.PluginsUiDescriptorsParamsSchema,
  Checks.isPluginsUiDescriptorsParams,
);
export const validatePluginsUiDescriptorsResult = createProtocolValidator(
  S.PluginsUiDescriptorsResultSchema,
  Checks.isPluginsUiDescriptorsResult,
);
export const validatePluginsControlUiListParams = createProtocolValidator(
  S.PluginsControlUiListParamsSchema,
  Checks.isPluginsControlUiListParams,
);
export const validatePluginsControlUiReloadParams = createProtocolValidator(
  S.PluginsControlUiReloadParamsSchema,
  Checks.isPluginsControlUiReloadParams,
);
export const validatePluginsControlUiReportParams = createProtocolValidator(
  S.PluginsControlUiReportParamsSchema,
  Checks.isPluginsControlUiReportParams,
);
export const validatePluginsControlUiStatusParams = createProtocolValidator(
  S.PluginsControlUiStatusParamsSchema,
  Checks.isPluginsControlUiStatusParams,
);
export const validatePluginsSessionActionParams = createProtocolValidator(
  S.PluginsSessionActionParamsSchema,
  Checks.isPluginsSessionActionParams,
);
export const validatePluginsSessionActionResult = createProtocolValidator(
  S.PluginsSessionActionResultSchema,
  Checks.isPluginsSessionActionResult,
);
export const validateWebLoginStartParams = createProtocolValidator(
  S.WebLoginStartParamsSchema,
  Checks.isWebLoginStartParams,
);
export const validateWebLoginWaitParams = createProtocolValidator(
  S.WebLoginWaitParamsSchema,
  Checks.isWebLoginWaitParams,
);
