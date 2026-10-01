import type { TSchema } from "typebox";
import * as schemaModules from "../schema-modules.js";
import {
  SkillsLibraryActivateParamsSchema,
  SkillsLibraryImportParamsSchema,
  SkillsLibraryListParamsSchema,
  SkillsLibraryMutateParamsSchema,
  SkillsLibraryReadParamsSchema,
  SkillsLibrarySaveParamsSchema,
  SkillsLibraryUploadParamsSchema,
} from "./skill-library.js";

const skillLibrary = {
  SkillsLibraryActivateParamsSchema,
  SkillsLibraryImportParamsSchema,
  SkillsLibraryListParamsSchema,
  SkillsLibraryMutateParamsSchema,
  SkillsLibraryReadParamsSchema,
  SkillsLibrarySaveParamsSchema,
  SkillsLibraryUploadParamsSchema,
};

// Keep namespace references named so declaration emission does not expand every schema.
const schemaSources: typeof schemaModules & typeof skillLibrary = {
  ...schemaModules,
  ...skillLibrary,
};
type SchemaExportName = Extract<keyof typeof schemaSources, `${string}Schema`>;

// Exported helpers stay outside the generated protocol. Placement and migration
// schemas retain their existing owner registries, including private schema members.
const EXCLUDED_SCHEMA_EXPORTS = [
  "AgentOwnershipSchema",
  "ApprovalChannelReviewerSchema",
  "BoardChatDockSchema",
  "BoardCronActionParamsSchema",
  "BoardLegacyEventParamsSchema",
  "BoardPluginActionParamsSchema",
  "BoardSizeSchema",
  "BoardTabIdSchema",
  "BoardTicketEventParamsSchema",
  "BoardViewTicketSchema",
  "BoardWidgetHeightModeSchema",
  "BoardWidgetNameSchema",
  "BoardWidgetPluginKindSchema",
  "BoardWidgetPluginPropsSchema",
  "BoardWidgetPresentationSchema",
  "ChatAttachmentSchema",
  "ChatAttachmentsSchema",
  "ChatInputConsumptionsSchema",
  "ChatInputReceiptsSchema",
  "ChatPendingInputsPageSchema",
  "ChatSendIntentSchema",
  "CronDeliverySchema",
  "CronJobStateSchema",
  "CronPacingSchema",
  "CronScratchSchema",
  "GatewayClientIdSchema",
  "GatewayClientModeSchema",
  "GitHubPublicationBodySchema",
  "GitHubPublicationPublisherSchema",
  "GitHubPublicationSelectionSchema",
  "GitHubPublicationTitleSchema",
  "GitHubSetupHandleSchema",
  "HumanMentionsSchema",
  "InputProvenanceSchema",
  "MigrationsMemoryApplyParamsSchema",
  "MigrationsMemoryPlanParamsSchema",
  "ModelCatalogProviderOutcomeSchema",
  "PersonalGitHubAccountSchema",
  "PersonalGitHubGenerationSchema",
  "PluginDiscoveryDetailSchema",
  "PluginInstalledComponentsSchema",
  "PluginJsonValueSchema",
  "PrincipalRefV1Schema",
  "ProjectRecentRepositorySchema",
  "PushLiveActivityBindingSchema",
  "PushLiveActivityDestinationSchema",
  "PushLiveActivitySnapshotSchema",
  "QuestionRequestedEventSchema",
  "RuntimeTargetIssueSchema",
  "SecretInputSchema",
  "SecretRefSchema",
  "SessionCatalogLocatorSchema",
  "SessionCatalogShareRouteSchema",
  "SessionFileContentEncodingSchema",
  "SessionGoalSchema",
  "SessionMoveDeviceTargetSchema",
  "SessionMoveExpectedSourceSchema",
  "SessionMoveGatewayTargetSchema",
  "SessionMovePlacementSchema",
  "SessionMovePlacementStateSchema",
  "SessionMoveProfileTargetSchema",
  "SessionMoveTargetSchema",
  "SessionPlacementDiskSpaceSchema",
  "SessionPlacementMachineSchema",
  "SessionPlacementMoveSchema",
  "SessionPlacementRunnerSchema",
  "SessionPlacementSchema",
  "SessionPlacementStateSchema",
  "SessionToolOverridesSchema",
  "SessionsCatalogHostEventSchema",
  "SessionsDispatchParamsSchema",
  "SessionsDispatchResultSchema",
  "SessionsMoveParamsSchema",
  "SessionsMoveResultSchema",
  "SessionsReclaimParamsSchema",
  "SessionsReclaimResultPlacementSchema",
  "SessionsReclaimResultSchema",
  "SkillProposalEvaluationSchema",
  "SkillProposalLifecycleEventSchema",
  "SystemAgentChatQuestionSchema",
  "SystemAgentWizardCancelSchema",
  "TranscriptUtteranceSchema",
  "UserProfileAvatarMimeSchema",
  "UserProfileGitHubIdentitySchema",
  "UserProfileIdSchema",
  "UserProfileSchema",
  "UsersLinkEmailParamsSchema",
  "UsersLinkEmailResultSchema",
  "UsersListParamsSchema",
  "UsersListResultSchema",
  "UsersPrefsGetParamsSchema",
  "UsersPrefsGetResultSchema",
  "UsersPrefsSetParamsSchema",
  "UsersPrefsSetResultSchema",
  "UsersSelfParamsSchema",
  "UsersSelfResultSchema",
  "UsersSetAvatarParamsSchema",
  "UsersSetAvatarResultSchema",
  "UsersSetDisplayNameParamsSchema",
  "UsersSetDisplayNameResultSchema",
  "UsersSetRoleParamsSchema",
  "UsersSetRoleResultSchema",
  "WebPushDetailLevelSchema",
  "WebPushDevicePreferencesSchema",
  "WebPushNotificationCategorySchema",
  "WebPushNotificationPreferencesSchema",
  "WebPushPreferencesGetParamsSchema",
  "WebPushPreferencesSetParamsSchema",
  "WebPushSubscribeParamsSchema",
  "WebPushTestParamsSchema",
  "WebPushUnsubscribeParamsSchema",
  "WebPushVapidPublicKeyParamsSchema",
  "WizardAnswerSchema",
  "WorkerAdmissionFailureReasonSchema",
  "WorkerAdmissionResponseFrameSchema",
  "WorkerConnectRequestFrameSchema",
  "WorkerExecutionModeSchema",
  "WorkerHeartbeatParamsSchema",
  "WorkerHeartbeatRequestFrameSchema",
  "WorkerHeartbeatResponseFrameSchema",
  "WorkerInferenceCancelRequestFrameSchema",
  "WorkerInferenceCancelResponseFrameSchema",
  "WorkerInferenceImageContentSchema",
  "WorkerInferenceModelRefSchema",
  "WorkerInferenceOptionsSchema",
  "WorkerInferenceStartRequestFrameSchema",
  "WorkerInferenceStartResponseFrameSchema",
  "WorkerLiveEventErrorDetailsSchema",
  "WorkerLiveEventErrorShapeSchema",
  "WorkerLiveEventParamsSchema",
  "WorkerLiveEventRequestFrameSchema",
  "WorkerLiveEventResponseFrameSchema",
  "WorkerLiveEventResultSchema",
  "WorkerLiveEventSchema",
  "WorkerMachineOptionSchema",
  "WorkerMachineOptionsSchema",
  "WorkerOperatingSystemSchema",
  "WorkerPortalParamsSchema",
  "WorkerPortalResponseFrameSchema",
  "WorkerProtocolCloseReasonSchema",
  "WorkerProviderReplayStateSchema",
  "WorkerSessionToolResponseFrameSchema",
  "WorkerSessionToolResultSchema",
  "WorkerSessionsSendParamsSchema",
  "WorkerSessionsSendResponseFrameSchema",
  "WorkerSessionsSpawnParamsSchema",
  "WorkerSessionsSpawnResponseFrameSchema",
  "WorkerTranscriptCommitErrorReasonSchema",
  "WorkerTranscriptCommitErrorShapeSchema",
  "WorkerTranscriptCommitParamsSchema",
  "WorkerTranscriptCommitRequestFrameSchema",
  "WorkerTranscriptCommitResponseFrameSchema",
  "WorkerTranscriptCommitResultSchema",
  "WorkerTranscriptMessageSchema",
  "WorkerTranscriptUserMessageSchema",
] as const satisfies readonly SchemaExportName[];

type ExcludedSchemaExport = (typeof EXCLUDED_SCHEMA_EXPORTS)[number];
type DerivedProtocolSchemaMap = {
  [
    Name in Exclude<SchemaExportName, ExcludedSchemaExport> as Name extends `${infer Key}Schema`
      ? Key
      : never
  ]: (typeof schemaSources)[Name];
};

function deriveProtocolSchemas(): DerivedProtocolSchemaMap {
  const excluded = new Set<string>(EXCLUDED_SCHEMA_EXPORTS);
  for (const name of excluded) {
    if (!Object.hasOwn(schemaSources, name)) {
      throw new Error(`Unknown excluded protocol schema export: ${name}`);
    }
  }
  const names = Object.keys(schemaSources)
    .filter((name): name is SchemaExportName => name.endsWith("Schema"))
    .toSorted();
  const entries: Array<[string, TSchema]> = [];
  for (const name of names) {
    if (!excluded.has(name)) {
      entries.push([name.slice(0, -"Schema".length), schemaSources[name]]);
    }
  }
  // SAFETY: Checked exclusions and suffix projection preserve exact keys and canonical schema objects.
  return Object.fromEntries(entries) as DerivedProtocolSchemaMap;
}

export const DerivedProtocolSchemas: DerivedProtocolSchemaMap = deriveProtocolSchemas();
