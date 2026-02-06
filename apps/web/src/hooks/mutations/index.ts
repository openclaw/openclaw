// Mutation hooks barrel export

// Agents
export {
  useCreateAgent,
  useUpdateAgent,
  useDeleteAgent,
  useUpdateAgentStatus,
} from "./useAgentMutations";

// Conversations
export {
  useCreateConversation,
  useUpdateConversation,
  useDeleteConversation,
  useSendMessage,
  useDeleteMessage,
} from "./useConversationMutations";

// Goals
export {
  useCreateGoal,
  useUpdateGoal,
  useDeleteGoal,
  useUpdateGoalStatus,
  useAddMilestone,
  useUpdateMilestone,
  useDeleteMilestone,
} from "./useGoalMutations";

// Memories
export {
  useCreateMemory,
  useUpdateMemory,
  useDeleteMemory,
  useAddMemoryTags,
  useRemoveMemoryTags,
  useChangeMemoryType,
} from "./useMemoryMutations";

// Rituals
export {
  useCreateRitual,
  useUpdateRitual,
  useDeleteRitual,
  useUpdateRitualStatus,
  useTriggerRitual,
  usePauseRitual,
  useResumeRitual,
} from "./useRitualMutations";

// Workstreams
export {
  useCreateWorkstream,
  useUpdateWorkstream,
  useDeleteWorkstream,
  useUpdateWorkstreamStatus,
  useCreateTask,
  useUpdateTask,
  useDeleteTask,
  useUpdateTaskStatus,
  useUpdateTaskPriority,
} from "./useWorkstreamMutations";

// Work Queue
export {
  useClaimWorkItem,
  useReleaseWorkItem,
} from "./useWorkQueueMutations";

// Config
export {
  usePatchConfig,
  useApplyConfig,
  useVerifyProviderApiKey,
  useSaveProviderApiKey,
  useRemoveProviderApiKey,
  useLogoutChannel,
} from "./useConfigMutations";
export type {
  ConfigSnapshot,
  ConfigPatchParams,
  ConfigPatchResponse,
  ModelProviderId,
  ProviderVerifyResponse,
} from "./useConfigMutations";

// User Settings
export {
  useUpdateProfile,
  useUpdatePreferences,
  useUpdateNotification,
  useUpdateAllNotifications,
} from "./useUserSettingsMutations";
export type { UpdateProfileParams, UpdatePreferencesParams, UpdateNotificationParams } from "./useUserSettingsMutations";

// Chat (Gateway)
export {
  useGatewaySendMessage,
  useAbortChat,
  type SendMessageParams,
  type SendMessageResult,
  type AbortChatParams,
} from "./useChatMutations";

// Channels
export {
  useChannelLogout,
  type ChannelLogoutParams,
} from "./useChannelMutations";

// Cron Jobs
export {
  useCreateCronJob,
  useUpdateCronJob,
  useDeleteCronJob,
  useEnableCronJob,
  useDisableCronJob,
  useRunCronJob,
  type CronJobCreateParams,
  type CronJobUpdateParams,
} from "./useCronMutations";

// Skills
export {
  useUpdateSkill,
  useEnableSkill,
  useDisableSkill,
  useInstallSkill,
  useUninstallSkill,
  type SkillUpdateParams,
  type SkillInstallParams,
  type SkillUninstallParams,
} from "./useSkillMutations";

// Nodes, Devices, Exec Approvals
export {
  useApproveDevice,
  useRejectDevice,
  useRotateDeviceToken,
  useRevokeDeviceToken,
  useSaveExecApprovals,
  type SaveExecApprovalsParams,
} from "./useNodeMutations";
