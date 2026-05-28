import { $ as PushTestParamsSchema, $i as SkillsStatusParamsSchema, $n as CronStatusParamsSchema, $r as TalkSessionCancelTurnParamsSchema, $t as RequestFrameSchema, Ai as AgentsFilesGetResultSchema, An as EnvironmentsListParamsSchema, Ar as CommandsListResultSchema, At as NodePendingDrainParamsSchema, B as SessionsMessagesUnsubscribeParamsSchema, Bi as ModelsListParamsSchema, Br as TalkCatalogParamsSchema, Ca as AgentWaitParamsSchema, Ci as AgentSummarySchema, Cn as ExecApprovalsGetParamsSchema, Ct as NodePairListParamsSchema, D as SessionsCompactionBranchParamsSchema, Da as SendParamsSchema, Di as AgentsDeleteResultSchema, Dt as NodePairVerifyParamsSchema, E as SessionsCompactParamsSchema, Ea as PollParamsSchema, Ei as AgentsDeleteParamsSchema, En as ExecApprovalsSetParamsSchema, Et as NodePairRequestParamsSchema, F as SessionsCreateParamsSchema, Fi as AgentsListParamsSchema, Fn as errorShape, Fr as ChannelsStartParamsSchema, Ft as NodePresenceAliveReasonSchema, G as SessionsResetParamsSchema, Gi as SkillsDetailResultSchema, Gn as CronListParamsSchema, Gr as TalkClientToolCallParamsSchema, Gt as ChatSendParamsSchema, H as SessionsPluginPatchParamsSchema, Hi as SkillsBinsParamsSchema, Hr as TalkClientCreateParamsSchema, I as SessionsDeleteParamsSchema, Ii as AgentsListResultSchema, In as CronAddParamsSchema, Ir as ChannelsStatusParamsSchema, It as NodeRenameParamsSchema, J as SessionsUsageParamsSchema, Ji as SkillsSearchResultSchema, Jn as CronRemoveParamsSchema, Jr as TalkConfigResultSchema, Jt as ConnectParamsSchema, K as SessionsResolveParamsSchema, Ki as SkillsInstallParamsSchema, Kr as TalkClientToolCallResultSchema, Kt as LogsTailParamsSchema, L as SessionsDescribeParamsSchema, Li as AgentsUpdateParamsSchema, Lr as ChannelsStatusResultSchema, Lt as ChatAbortParamsSchema, Mi as AgentsFilesListResultSchema, Mn as EnvironmentsStatusParamsSchema, Mt as NodePendingEnqueueParamsSchema, N as SessionsCompactionRestoreParamsSchema, Ni as AgentsFilesSetParamsSchema, Nn as EnvironmentsStatusResultSchema, Nt as NodePendingEnqueueResultSchema, Oa as WakeParamsSchema, Oi as AgentsFileEntrySchema, On as EnvironmentStatusSchema, Ot as NodePendingAckParamsSchema, Pi as AgentsFilesSetResultSchema, Pn as ErrorCodes, Pr as ChannelsLogoutParamsSchema, Pt as NodePresenceAlivePayloadSchema, Q as SecretsResolveResultSchema, Qi as SkillsSkillCardResultSchema, Qr as TalkSessionCancelOutputParamsSchema, Qt as HelloOkSchema, R as SessionsListParamsSchema, Ri as AgentsUpdateResultSchema, Rr as ChannelsStopParamsSchema, Sa as AgentParamsSchema, St as NodePairApproveParamsSchema, T as SessionsCleanupParamsSchema, Ti as AgentsCreateResultSchema, Tn as ExecApprovalsNodeSetParamsSchema, Tt as NodePairRemoveParamsSchema, Un as CronJobSchema, Ur as TalkClientCreateResultSchema, Ut as ChatHistoryParamsSchema, V as SessionsPatchParamsSchema, Vn as CronGetParamsSchema, Vr as TalkCatalogResultSchema, Vt as ChatEventSchema, W as SessionsPreviewParamsSchema, Wi as SkillsDetailParamsSchema, Wr as TalkClientSteerParamsSchema, Wt as ChatInjectParamsSchema, Xi as SkillsSecurityVerdictsResultSchema, Xn as CronRunParamsSchema, Xr as TalkModeParamsSchema, Xt as EventFrameSchema, Yi as SkillsSecurityVerdictsParamsSchema, Yr as TalkEventSchema, Yt as ErrorShapeSchema, Z as SecretsResolveParamsSchema, Zi as SkillsSkillCardParamsSchema, Zn as CronRunsParamsSchema, Zr as TalkSessionAppendAudioParamsSchema, Zt as GatewayFrameSchema, _ as TasksGetResultSchema, _a as AgentEventSchema, _i as ArtifactsDownloadParamsSchema, _n as ExecApprovalRequestParamsSchema, _t as NodeEventResultSchema, a as WizardNextResultSchema, ai as TalkSessionOkResultSchema, ar as ConfigSchemaLookupParamsSchema, ba as AgentIdentityResultSchema, bt as NodeInvokeResultParamsSchema, c as WizardStatusParamsSchema, ci as TalkSessionTurnParamsSchema, cn as DevicePairApproveParamsSchema, cr as ConfigSchemaResponseSchema, ct as PluginsSessionActionParamsSchema, d as WizardStepSchema, di as TalkSpeakResultSchema, dn as DevicePairRemoveParamsSchema, dr as UpdateRunParamsSchema, dt as PluginsUiDescriptorsParamsSchema, ea as SkillsUpdateParamsSchema, ei as TalkSessionCloseParamsSchema, en as ResponseFrameSchema, er as CronUpdateParamsSchema, et as PushTestResultSchema, fa as ToolsEffectiveParamsSchema, fi as WebLoginStartParamsSchema, fr as UpdateStatusParamsSchema, g as TasksGetParamsSchema, gi as ArtifactSummarySchema, gn as ExecApprovalGetParamsSchema, gt as NodeEventParamsSchema, h as TasksCancelResultSchema, ha as ToolsInvokeParamsSchema, hn as DeviceTokenRotateParamsSchema, ht as NodeDescribeParamsSchema, i as WizardNextParamsSchema, ii as TalkSessionJoinResultSchema, in as PresenceEntrySchema, it as WebPushVapidPublicKeyParamsSchema, j as SessionsCompactionListParamsSchema, ji as AgentsFilesListParamsSchema, jn as EnvironmentsListResultSchema, jt as NodePendingDrainResultSchema, k as SessionsCompactionGetParamsSchema, ki as AgentsFilesGetParamsSchema, kn as EnvironmentSummarySchema, kr as CommandsListParamsSchema, l as WizardStatusResultSchema, li as TalkSessionTurnResultSchema, ln as DevicePairListParamsSchema, lr as ConfigSetParamsSchema, lt as PluginsSessionActionResultSchema, m as TasksCancelParamsSchema, mn as DeviceTokenRevokeParamsSchema, mt as PluginApprovalResolveParamsSchema, na as SkillsUploadChunkParamsSchema, ni as TalkSessionCreateResultSchema, nn as TickEventSchema, nr as ConfigGetParamsSchema, nt as WebPushTestParamsSchema, o as WizardStartParamsSchema, oi as TalkSessionSteerParamsSchema, on as SnapshotSchema, or as ConfigSchemaLookupResultSchema, p as TaskSummarySchema, pi as WebLoginWaitParamsSchema, pt as PluginApprovalRequestParamsSchema, q as SessionsSendParamsSchema, qi as SkillsSearchParamsSchema, qr as TalkConfigParamsSchema, qt as LogsTailResultSchema, r as WizardCancelParamsSchema, ra as SkillsUploadCommitParamsSchema, ri as TalkSessionJoinParamsSchema, rr as ConfigPatchParamsSchema, rt as WebPushUnsubscribeParamsSchema, s as WizardStartResultSchema, sa as ToolsCatalogParamsSchema, si as TalkSessionSubmitToolResultParamsSchema, sn as StateVersionSchema, sr as ConfigSchemaParamsSchema, t as ProtocolSchemas, ta as SkillsUploadBeginParamsSchema, ti as TalkSessionCreateParamsSchema, tn as ShutdownEventSchema, tr as ConfigApplyParamsSchema, tt as WebPushSubscribeParamsSchema, ui as TalkSpeakParamsSchema, un as DevicePairRejectParamsSchema, v as TasksListParamsSchema, vn as ExecApprovalResolveParamsSchema, vt as NodeInvokeParamsSchema, w as SessionsAbortParamsSchema, wa as MessageActionParamsSchema, wi as AgentsCreateParamsSchema, wn as ExecApprovalsNodeGetParamsSchema, wt as NodePairRejectParamsSchema, xi as ArtifactsListParamsSchema, xt as NodeListParamsSchema, y as TasksListResultSchema, ya as AgentIdentityParamsSchema, yi as ArtifactsGetParamsSchema, z as SessionsMessagesSubscribeParamsSchema, zr as TalkAgentControlResultSchema } from "./schema-DyxbmZUs.mjs";
import { MIN_CLIENT_PROTOCOL_VERSION, MIN_PROBE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "./version.mjs";
import { Compile } from "typebox/compile";
//#region packages/gateway-protocol/src/index.ts
function lazyCompile(schema) {
	let compiled;
	let errors = null;
	const getCompiled = () => {
		compiled ??= Compile(schema);
		return compiled;
	};
	const validate = ((data) => {
		const current = getCompiled();
		const valid = current.Check(data);
		errors = valid ? null : [...current.Errors(data)];
		return valid;
	});
	Object.defineProperties(validate, {
		errors: {
			configurable: true,
			enumerable: true,
			get: () => errors,
			set: (nextErrors) => {
				errors = nextErrors ?? null;
			}
		},
		schema: {
			configurable: true,
			enumerable: true,
			get: () => schema
		}
	});
	return validate;
}
const validateCommandsListParams = lazyCompile(CommandsListParamsSchema);
const validateConnectParams = lazyCompile(ConnectParamsSchema);
const validateRequestFrame = lazyCompile(RequestFrameSchema);
const validateResponseFrame = lazyCompile(ResponseFrameSchema);
const validateEventFrame = lazyCompile(EventFrameSchema);
const validateMessageActionParams = lazyCompile(MessageActionParamsSchema);
const validateSendParams = lazyCompile(SendParamsSchema);
const validatePollParams = lazyCompile(PollParamsSchema);
const validateAgentParams = lazyCompile(AgentParamsSchema);
const validateAgentIdentityParams = lazyCompile(AgentIdentityParamsSchema);
const validateAgentWaitParams = lazyCompile(AgentWaitParamsSchema);
const validateWakeParams = lazyCompile(WakeParamsSchema);
const validateAgentsListParams = lazyCompile(AgentsListParamsSchema);
const validateAgentsCreateParams = lazyCompile(AgentsCreateParamsSchema);
const validateAgentsUpdateParams = lazyCompile(AgentsUpdateParamsSchema);
const validateAgentsDeleteParams = lazyCompile(AgentsDeleteParamsSchema);
const validateAgentsFilesListParams = lazyCompile(AgentsFilesListParamsSchema);
const validateAgentsFilesGetParams = lazyCompile(AgentsFilesGetParamsSchema);
const validateAgentsFilesSetParams = lazyCompile(AgentsFilesSetParamsSchema);
const validateArtifactsListParams = lazyCompile(ArtifactsListParamsSchema);
const validateArtifactsGetParams = lazyCompile(ArtifactsGetParamsSchema);
const validateArtifactsDownloadParams = lazyCompile(ArtifactsDownloadParamsSchema);
const validateNodePairRequestParams = lazyCompile(NodePairRequestParamsSchema);
const validateNodePairListParams = lazyCompile(NodePairListParamsSchema);
const validateNodePairApproveParams = lazyCompile(NodePairApproveParamsSchema);
const validateNodePairRejectParams = lazyCompile(NodePairRejectParamsSchema);
const validateNodePairRemoveParams = lazyCompile(NodePairRemoveParamsSchema);
const validateNodePairVerifyParams = lazyCompile(NodePairVerifyParamsSchema);
const validateNodeRenameParams = lazyCompile(NodeRenameParamsSchema);
const validateNodeListParams = lazyCompile(NodeListParamsSchema);
const validateEnvironmentsListParams = lazyCompile(EnvironmentsListParamsSchema);
const validateEnvironmentsStatusParams = lazyCompile(EnvironmentsStatusParamsSchema);
const validateNodePendingAckParams = lazyCompile(NodePendingAckParamsSchema);
const validateNodeDescribeParams = lazyCompile(NodeDescribeParamsSchema);
const validateNodeInvokeParams = lazyCompile(NodeInvokeParamsSchema);
const validateNodeInvokeResultParams = lazyCompile(NodeInvokeResultParamsSchema);
const validateNodeEventParams = lazyCompile(NodeEventParamsSchema);
const validateNodeEventResult = lazyCompile(NodeEventResultSchema);
const validateNodePresenceAlivePayload = lazyCompile(NodePresenceAlivePayloadSchema);
const validateNodePendingDrainParams = lazyCompile(NodePendingDrainParamsSchema);
const validateNodePendingEnqueueParams = lazyCompile(NodePendingEnqueueParamsSchema);
const validatePushTestParams = lazyCompile(PushTestParamsSchema);
const validateWebPushVapidPublicKeyParams = lazyCompile(WebPushVapidPublicKeyParamsSchema);
const validateWebPushSubscribeParams = lazyCompile(WebPushSubscribeParamsSchema);
const validateWebPushUnsubscribeParams = lazyCompile(WebPushUnsubscribeParamsSchema);
const validateWebPushTestParams = lazyCompile(WebPushTestParamsSchema);
const validateSecretsResolveParams = lazyCompile(SecretsResolveParamsSchema);
const validateSecretsResolveResult = lazyCompile(SecretsResolveResultSchema);
const validateSessionsListParams = lazyCompile(SessionsListParamsSchema);
const validateSessionsCleanupParams = lazyCompile(SessionsCleanupParamsSchema);
const validateSessionsPreviewParams = lazyCompile(SessionsPreviewParamsSchema);
const validateSessionsDescribeParams = lazyCompile(SessionsDescribeParamsSchema);
const validateSessionsResolveParams = lazyCompile(SessionsResolveParamsSchema);
const validateSessionsCreateParams = lazyCompile(SessionsCreateParamsSchema);
const validateSessionsSendParams = lazyCompile(SessionsSendParamsSchema);
const validateSessionsMessagesSubscribeParams = lazyCompile(SessionsMessagesSubscribeParamsSchema);
const validateSessionsMessagesUnsubscribeParams = lazyCompile(SessionsMessagesUnsubscribeParamsSchema);
const validateSessionsAbortParams = lazyCompile(SessionsAbortParamsSchema);
const validateSessionsPatchParams = lazyCompile(SessionsPatchParamsSchema);
const validateSessionsPluginPatchParams = lazyCompile(SessionsPluginPatchParamsSchema);
const validateSessionsResetParams = lazyCompile(SessionsResetParamsSchema);
const validateSessionsDeleteParams = lazyCompile(SessionsDeleteParamsSchema);
const validateSessionsCompactParams = lazyCompile(SessionsCompactParamsSchema);
const validateSessionsCompactionListParams = lazyCompile(SessionsCompactionListParamsSchema);
const validateSessionsCompactionGetParams = lazyCompile(SessionsCompactionGetParamsSchema);
const validateSessionsCompactionBranchParams = lazyCompile(SessionsCompactionBranchParamsSchema);
const validateSessionsCompactionRestoreParams = lazyCompile(SessionsCompactionRestoreParamsSchema);
const validateSessionsUsageParams = lazyCompile(SessionsUsageParamsSchema);
const validateTasksListParams = lazyCompile(TasksListParamsSchema);
const validateTasksGetParams = lazyCompile(TasksGetParamsSchema);
const validateTasksCancelParams = lazyCompile(TasksCancelParamsSchema);
const validateConfigGetParams = lazyCompile(ConfigGetParamsSchema);
const validateConfigSetParams = lazyCompile(ConfigSetParamsSchema);
const validateConfigApplyParams = lazyCompile(ConfigApplyParamsSchema);
const validateConfigPatchParams = lazyCompile(ConfigPatchParamsSchema);
const validateConfigSchemaParams = lazyCompile(ConfigSchemaParamsSchema);
const validateConfigSchemaLookupParams = lazyCompile(ConfigSchemaLookupParamsSchema);
const validateConfigSchemaLookupResult = lazyCompile(ConfigSchemaLookupResultSchema);
const validateWizardStartParams = lazyCompile(WizardStartParamsSchema);
const validateWizardNextParams = lazyCompile(WizardNextParamsSchema);
const validateWizardCancelParams = lazyCompile(WizardCancelParamsSchema);
const validateWizardStatusParams = lazyCompile(WizardStatusParamsSchema);
const validateTalkModeParams = lazyCompile(TalkModeParamsSchema);
const validateTalkEvent = lazyCompile(TalkEventSchema);
const validateTalkCatalogParams = lazyCompile(TalkCatalogParamsSchema);
const validateTalkCatalogResult = lazyCompile(TalkCatalogResultSchema);
const validateTalkConfigParams = lazyCompile(TalkConfigParamsSchema);
const validateTalkConfigResult = lazyCompile(TalkConfigResultSchema);
const validateTalkClientCreateParams = lazyCompile(TalkClientCreateParamsSchema);
const validateTalkClientCreateResult = lazyCompile(TalkClientCreateResultSchema);
const validateTalkClientToolCallParams = lazyCompile(TalkClientToolCallParamsSchema);
const validateTalkClientToolCallResult = lazyCompile(TalkClientToolCallResultSchema);
const validateTalkClientSteerParams = lazyCompile(TalkClientSteerParamsSchema);
const validateTalkAgentControlResult = lazyCompile(TalkAgentControlResultSchema);
const validateTalkSessionCreateParams = lazyCompile(TalkSessionCreateParamsSchema);
const validateTalkSessionCreateResult = lazyCompile(TalkSessionCreateResultSchema);
const validateTalkSessionJoinParams = lazyCompile(TalkSessionJoinParamsSchema);
const validateTalkSessionJoinResult = lazyCompile(TalkSessionJoinResultSchema);
const validateTalkSessionAppendAudioParams = lazyCompile(TalkSessionAppendAudioParamsSchema);
const validateTalkSessionTurnParams = lazyCompile(TalkSessionTurnParamsSchema);
const validateTalkSessionCancelTurnParams = lazyCompile(TalkSessionCancelTurnParamsSchema);
const validateTalkSessionCancelOutputParams = lazyCompile(TalkSessionCancelOutputParamsSchema);
const validateTalkSessionTurnResult = lazyCompile(TalkSessionTurnResultSchema);
const validateTalkSessionSteerParams = lazyCompile(TalkSessionSteerParamsSchema);
const validateTalkSessionSubmitToolResultParams = lazyCompile(TalkSessionSubmitToolResultParamsSchema);
const validateTalkSessionCloseParams = lazyCompile(TalkSessionCloseParamsSchema);
const validateTalkSessionOkResult = lazyCompile(TalkSessionOkResultSchema);
const validateTalkSpeakParams = lazyCompile(TalkSpeakParamsSchema);
const validateTalkSpeakResult = lazyCompile(TalkSpeakResultSchema);
const validateChannelsStatusParams = lazyCompile(ChannelsStatusParamsSchema);
const validateChannelsStartParams = lazyCompile(ChannelsStartParamsSchema);
const validateChannelsStopParams = lazyCompile(ChannelsStopParamsSchema);
const validateChannelsLogoutParams = lazyCompile(ChannelsLogoutParamsSchema);
const validateModelsListParams = lazyCompile(ModelsListParamsSchema);
const validateSkillsStatusParams = lazyCompile(SkillsStatusParamsSchema);
const validateToolsCatalogParams = lazyCompile(ToolsCatalogParamsSchema);
const validateToolsEffectiveParams = lazyCompile(ToolsEffectiveParamsSchema);
const validateToolsInvokeParams = lazyCompile(ToolsInvokeParamsSchema);
const validateSkillsBinsParams = lazyCompile(SkillsBinsParamsSchema);
const validateSkillsInstallParams = lazyCompile(SkillsInstallParamsSchema);
const validateSkillsUploadBeginParams = lazyCompile(SkillsUploadBeginParamsSchema);
const validateSkillsUploadChunkParams = lazyCompile(SkillsUploadChunkParamsSchema);
const validateSkillsUploadCommitParams = lazyCompile(SkillsUploadCommitParamsSchema);
const validateSkillsUpdateParams = lazyCompile(SkillsUpdateParamsSchema);
const validateSkillsSearchParams = lazyCompile(SkillsSearchParamsSchema);
const validateSkillsDetailParams = lazyCompile(SkillsDetailParamsSchema);
const validateSkillsSecurityVerdictsParams = lazyCompile(SkillsSecurityVerdictsParamsSchema);
const validateSkillsSkillCardParams = lazyCompile(SkillsSkillCardParamsSchema);
const validateCronListParams = lazyCompile(CronListParamsSchema);
const validateCronStatusParams = lazyCompile(CronStatusParamsSchema);
const validateCronGetParams = lazyCompile(CronGetParamsSchema);
const validateCronAddParams = lazyCompile(CronAddParamsSchema);
const validateCronUpdateParams = lazyCompile(CronUpdateParamsSchema);
const validateCronRemoveParams = lazyCompile(CronRemoveParamsSchema);
const validateCronRunParams = lazyCompile(CronRunParamsSchema);
const validateCronRunsParams = lazyCompile(CronRunsParamsSchema);
const validateDevicePairListParams = lazyCompile(DevicePairListParamsSchema);
const validateDevicePairApproveParams = lazyCompile(DevicePairApproveParamsSchema);
const validateDevicePairRejectParams = lazyCompile(DevicePairRejectParamsSchema);
const validateDevicePairRemoveParams = lazyCompile(DevicePairRemoveParamsSchema);
const validateDeviceTokenRotateParams = lazyCompile(DeviceTokenRotateParamsSchema);
const validateDeviceTokenRevokeParams = lazyCompile(DeviceTokenRevokeParamsSchema);
const validateExecApprovalsGetParams = lazyCompile(ExecApprovalsGetParamsSchema);
const validateExecApprovalsSetParams = lazyCompile(ExecApprovalsSetParamsSchema);
const validateExecApprovalGetParams = lazyCompile(ExecApprovalGetParamsSchema);
const validateExecApprovalRequestParams = lazyCompile(ExecApprovalRequestParamsSchema);
const validateExecApprovalResolveParams = lazyCompile(ExecApprovalResolveParamsSchema);
const validatePluginApprovalRequestParams = lazyCompile(PluginApprovalRequestParamsSchema);
const validatePluginApprovalResolveParams = lazyCompile(PluginApprovalResolveParamsSchema);
const validatePluginsUiDescriptorsParams = lazyCompile(PluginsUiDescriptorsParamsSchema);
const validatePluginsSessionActionParams = lazyCompile(PluginsSessionActionParamsSchema);
const validatePluginsSessionActionResult = lazyCompile(PluginsSessionActionResultSchema);
const validateExecApprovalsNodeGetParams = lazyCompile(ExecApprovalsNodeGetParamsSchema);
const validateExecApprovalsNodeSetParams = lazyCompile(ExecApprovalsNodeSetParamsSchema);
const validateLogsTailParams = lazyCompile(LogsTailParamsSchema);
const validateChatHistoryParams = lazyCompile(ChatHistoryParamsSchema);
const validateChatSendParams = lazyCompile(ChatSendParamsSchema);
const validateChatAbortParams = lazyCompile(ChatAbortParamsSchema);
const validateChatInjectParams = lazyCompile(ChatInjectParamsSchema);
const validateChatEvent = lazyCompile(ChatEventSchema);
const validateUpdateStatusParams = lazyCompile(UpdateStatusParamsSchema);
const validateUpdateRunParams = lazyCompile(UpdateRunParamsSchema);
const validateWebLoginStartParams = lazyCompile(WebLoginStartParamsSchema);
const validateWebLoginWaitParams = lazyCompile(WebLoginWaitParamsSchema);
function firstStringParam(value) {
	if (typeof value === "string" && value.trim()) return value;
	if (Array.isArray(value)) return value.find((entry) => typeof entry === "string" && entry.trim().length > 0);
}
function formatValidationErrors(errors) {
	if (!errors?.length) return "unknown validation error";
	const parts = [];
	for (const err of errors) {
		const keyword = typeof err?.keyword === "string" ? err.keyword : "";
		const instancePath = typeof err?.instancePath === "string" ? err.instancePath : "";
		if (keyword === "additionalProperties") {
			const additionalProperty = firstStringParam(err?.params?.additionalProperty) ?? firstStringParam(err?.params?.additionalProperties);
			if (additionalProperty) {
				const where = instancePath ? `at ${instancePath}` : "at root";
				parts.push(`${where}: unexpected property '${additionalProperty}'`);
				continue;
			}
		}
		if (keyword === "required") {
			const missingProperty = firstStringParam(err?.params?.missingProperty) ?? firstStringParam(err?.params?.requiredProperties);
			if (missingProperty) {
				const where = instancePath ? `at ${instancePath}: ` : "";
				parts.push(`${where}must have required property '${missingProperty}'`);
				continue;
			}
		}
		const failingKeyword = typeof err?.params?.failingKeyword === "string" ? err.params.failingKeyword : "";
		const message = keyword === "then" || keyword === "if" && failingKeyword === "then" ? "must have required conditional properties" : typeof err?.message === "string" && err.message.trim() ? err.message : "validation error";
		const where = instancePath ? `at ${instancePath}: ` : "";
		parts.push(`${where}${message}`);
	}
	const unique = uniqueStrings(parts.filter((part) => part.trim()));
	if (!unique.length) return "unknown validation error";
	return unique.join("; ");
}
function uniqueStrings(values) {
	return [...new Set(values)];
}
//#endregion
export { AgentEventSchema, AgentIdentityParamsSchema, AgentIdentityResultSchema, AgentParamsSchema, AgentSummarySchema, AgentsCreateParamsSchema, AgentsCreateResultSchema, AgentsDeleteParamsSchema, AgentsDeleteResultSchema, AgentsFileEntrySchema, AgentsFilesGetParamsSchema, AgentsFilesGetResultSchema, AgentsFilesListParamsSchema, AgentsFilesListResultSchema, AgentsFilesSetParamsSchema, AgentsFilesSetResultSchema, AgentsListParamsSchema, AgentsListResultSchema, AgentsUpdateParamsSchema, AgentsUpdateResultSchema, ArtifactSummarySchema, ArtifactsDownloadParamsSchema, ArtifactsGetParamsSchema, ArtifactsListParamsSchema, ChannelsLogoutParamsSchema, ChannelsStartParamsSchema, ChannelsStatusParamsSchema, ChannelsStatusResultSchema, ChannelsStopParamsSchema, ChatEventSchema, ChatHistoryParamsSchema, ChatInjectParamsSchema, ChatSendParamsSchema, CommandsListParamsSchema, CommandsListResultSchema, ConfigApplyParamsSchema, ConfigGetParamsSchema, ConfigPatchParamsSchema, ConfigSchemaLookupParamsSchema, ConfigSchemaLookupResultSchema, ConfigSchemaParamsSchema, ConfigSchemaResponseSchema, ConfigSetParamsSchema, ConnectParamsSchema, CronAddParamsSchema, CronGetParamsSchema, CronJobSchema, CronListParamsSchema, CronRemoveParamsSchema, CronRunParamsSchema, CronRunsParamsSchema, CronStatusParamsSchema, CronUpdateParamsSchema, EnvironmentStatusSchema, EnvironmentSummarySchema, EnvironmentsListParamsSchema, EnvironmentsListResultSchema, EnvironmentsStatusParamsSchema, EnvironmentsStatusResultSchema, ErrorCodes, ErrorShapeSchema, EventFrameSchema, ExecApprovalGetParamsSchema, ExecApprovalRequestParamsSchema, ExecApprovalResolveParamsSchema, ExecApprovalsGetParamsSchema, ExecApprovalsSetParamsSchema, GatewayFrameSchema, HelloOkSchema, LogsTailParamsSchema, LogsTailResultSchema, MIN_CLIENT_PROTOCOL_VERSION, MIN_PROBE_PROTOCOL_VERSION, MessageActionParamsSchema, ModelsListParamsSchema, NodeEventResultSchema, NodeInvokeParamsSchema, NodeListParamsSchema, NodePairApproveParamsSchema, NodePairListParamsSchema, NodePairRejectParamsSchema, NodePairRemoveParamsSchema, NodePairRequestParamsSchema, NodePairVerifyParamsSchema, NodePendingAckParamsSchema, NodePendingDrainParamsSchema, NodePendingDrainResultSchema, NodePendingEnqueueParamsSchema, NodePendingEnqueueResultSchema, NodePresenceAlivePayloadSchema, NodePresenceAliveReasonSchema, PROTOCOL_VERSION, PluginsSessionActionParamsSchema, PluginsSessionActionResultSchema, PluginsUiDescriptorsParamsSchema, PollParamsSchema, PresenceEntrySchema, ProtocolSchemas, PushTestParamsSchema, PushTestResultSchema, RequestFrameSchema, ResponseFrameSchema, SendParamsSchema, SessionsAbortParamsSchema, SessionsCleanupParamsSchema, SessionsCompactParamsSchema, SessionsCompactionBranchParamsSchema, SessionsCompactionGetParamsSchema, SessionsCompactionListParamsSchema, SessionsCompactionRestoreParamsSchema, SessionsCreateParamsSchema, SessionsDeleteParamsSchema, SessionsDescribeParamsSchema, SessionsListParamsSchema, SessionsPatchParamsSchema, SessionsPluginPatchParamsSchema, SessionsPreviewParamsSchema, SessionsResetParamsSchema, SessionsResolveParamsSchema, SessionsSendParamsSchema, SessionsUsageParamsSchema, ShutdownEventSchema, SkillsDetailParamsSchema, SkillsDetailResultSchema, SkillsInstallParamsSchema, SkillsSearchParamsSchema, SkillsSearchResultSchema, SkillsSecurityVerdictsParamsSchema, SkillsSecurityVerdictsResultSchema, SkillsSkillCardParamsSchema, SkillsSkillCardResultSchema, SkillsStatusParamsSchema, SkillsUpdateParamsSchema, SkillsUploadBeginParamsSchema, SkillsUploadChunkParamsSchema, SkillsUploadCommitParamsSchema, SnapshotSchema, StateVersionSchema, TalkAgentControlResultSchema, TalkCatalogParamsSchema, TalkCatalogResultSchema, TalkClientCreateParamsSchema, TalkClientCreateResultSchema, TalkClientSteerParamsSchema, TalkClientToolCallParamsSchema, TalkClientToolCallResultSchema, TalkConfigParamsSchema, TalkConfigResultSchema, TalkEventSchema, TalkSessionAppendAudioParamsSchema, TalkSessionCancelOutputParamsSchema, TalkSessionCancelTurnParamsSchema, TalkSessionCloseParamsSchema, TalkSessionCreateParamsSchema, TalkSessionCreateResultSchema, TalkSessionJoinParamsSchema, TalkSessionJoinResultSchema, TalkSessionOkResultSchema, TalkSessionSteerParamsSchema, TalkSessionSubmitToolResultParamsSchema, TalkSessionTurnParamsSchema, TalkSessionTurnResultSchema, TalkSpeakParamsSchema, TalkSpeakResultSchema, TaskSummarySchema, TasksCancelParamsSchema, TasksCancelResultSchema, TasksGetParamsSchema, TasksGetResultSchema, TasksListParamsSchema, TasksListResultSchema, TickEventSchema, ToolsCatalogParamsSchema, ToolsEffectiveParamsSchema, ToolsInvokeParamsSchema, UpdateRunParamsSchema, UpdateStatusParamsSchema, WakeParamsSchema, WebLoginStartParamsSchema, WebLoginWaitParamsSchema, WebPushSubscribeParamsSchema, WebPushTestParamsSchema, WebPushUnsubscribeParamsSchema, WebPushVapidPublicKeyParamsSchema, WizardCancelParamsSchema, WizardNextParamsSchema, WizardNextResultSchema, WizardStartParamsSchema, WizardStartResultSchema, WizardStatusParamsSchema, WizardStatusResultSchema, WizardStepSchema, errorShape, formatValidationErrors, validateAgentIdentityParams, validateAgentParams, validateAgentWaitParams, validateAgentsCreateParams, validateAgentsDeleteParams, validateAgentsFilesGetParams, validateAgentsFilesListParams, validateAgentsFilesSetParams, validateAgentsListParams, validateAgentsUpdateParams, validateArtifactsDownloadParams, validateArtifactsGetParams, validateArtifactsListParams, validateChannelsLogoutParams, validateChannelsStartParams, validateChannelsStatusParams, validateChannelsStopParams, validateChatAbortParams, validateChatEvent, validateChatHistoryParams, validateChatInjectParams, validateChatSendParams, validateCommandsListParams, validateConfigApplyParams, validateConfigGetParams, validateConfigPatchParams, validateConfigSchemaLookupParams, validateConfigSchemaLookupResult, validateConfigSchemaParams, validateConfigSetParams, validateConnectParams, validateCronAddParams, validateCronGetParams, validateCronListParams, validateCronRemoveParams, validateCronRunParams, validateCronRunsParams, validateCronStatusParams, validateCronUpdateParams, validateDevicePairApproveParams, validateDevicePairListParams, validateDevicePairRejectParams, validateDevicePairRemoveParams, validateDeviceTokenRevokeParams, validateDeviceTokenRotateParams, validateEnvironmentsListParams, validateEnvironmentsStatusParams, validateEventFrame, validateExecApprovalGetParams, validateExecApprovalRequestParams, validateExecApprovalResolveParams, validateExecApprovalsGetParams, validateExecApprovalsNodeGetParams, validateExecApprovalsNodeSetParams, validateExecApprovalsSetParams, validateLogsTailParams, validateMessageActionParams, validateModelsListParams, validateNodeDescribeParams, validateNodeEventParams, validateNodeEventResult, validateNodeInvokeParams, validateNodeInvokeResultParams, validateNodeListParams, validateNodePairApproveParams, validateNodePairListParams, validateNodePairRejectParams, validateNodePairRemoveParams, validateNodePairRequestParams, validateNodePairVerifyParams, validateNodePendingAckParams, validateNodePendingDrainParams, validateNodePendingEnqueueParams, validateNodePresenceAlivePayload, validateNodeRenameParams, validatePluginApprovalRequestParams, validatePluginApprovalResolveParams, validatePluginsSessionActionParams, validatePluginsSessionActionResult, validatePluginsUiDescriptorsParams, validatePollParams, validatePushTestParams, validateRequestFrame, validateResponseFrame, validateSecretsResolveParams, validateSecretsResolveResult, validateSendParams, validateSessionsAbortParams, validateSessionsCleanupParams, validateSessionsCompactParams, validateSessionsCompactionBranchParams, validateSessionsCompactionGetParams, validateSessionsCompactionListParams, validateSessionsCompactionRestoreParams, validateSessionsCreateParams, validateSessionsDeleteParams, validateSessionsDescribeParams, validateSessionsListParams, validateSessionsMessagesSubscribeParams, validateSessionsMessagesUnsubscribeParams, validateSessionsPatchParams, validateSessionsPluginPatchParams, validateSessionsPreviewParams, validateSessionsResetParams, validateSessionsResolveParams, validateSessionsSendParams, validateSessionsUsageParams, validateSkillsBinsParams, validateSkillsDetailParams, validateSkillsInstallParams, validateSkillsSearchParams, validateSkillsSecurityVerdictsParams, validateSkillsSkillCardParams, validateSkillsStatusParams, validateSkillsUpdateParams, validateSkillsUploadBeginParams, validateSkillsUploadChunkParams, validateSkillsUploadCommitParams, validateTalkAgentControlResult, validateTalkCatalogParams, validateTalkCatalogResult, validateTalkClientCreateParams, validateTalkClientCreateResult, validateTalkClientSteerParams, validateTalkClientToolCallParams, validateTalkClientToolCallResult, validateTalkConfigParams, validateTalkConfigResult, validateTalkEvent, validateTalkModeParams, validateTalkSessionAppendAudioParams, validateTalkSessionCancelOutputParams, validateTalkSessionCancelTurnParams, validateTalkSessionCloseParams, validateTalkSessionCreateParams, validateTalkSessionCreateResult, validateTalkSessionJoinParams, validateTalkSessionJoinResult, validateTalkSessionOkResult, validateTalkSessionSteerParams, validateTalkSessionSubmitToolResultParams, validateTalkSessionTurnParams, validateTalkSessionTurnResult, validateTalkSpeakParams, validateTalkSpeakResult, validateTasksCancelParams, validateTasksGetParams, validateTasksListParams, validateToolsCatalogParams, validateToolsEffectiveParams, validateToolsInvokeParams, validateUpdateRunParams, validateUpdateStatusParams, validateWakeParams, validateWebLoginStartParams, validateWebLoginWaitParams, validateWebPushSubscribeParams, validateWebPushTestParams, validateWebPushUnsubscribeParams, validateWebPushVapidPublicKeyParams, validateWizardCancelParams, validateWizardNextParams, validateWizardStartParams, validateWizardStatusParams };
