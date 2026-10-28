import * as Checks from "../compiled/protocol.generated/validators-agents.js";
import { createProtocolValidator } from "../protocol-validator.js";
import * as S from "../schema-modules.js";

export const validateAgentParams = createProtocolValidator(
  S.AgentParamsSchema,
  Checks.isAgentParams,
);
export const validateAgentIdentityParams = createProtocolValidator(
  S.AgentIdentityParamsSchema,
  Checks.isAgentIdentityParams,
);
export const validateAgentWaitParams = createProtocolValidator(
  S.AgentWaitParamsSchema,
  Checks.isAgentWaitParams,
);
export const validateAgentsListParams = createProtocolValidator(
  S.AgentsListParamsSchema,
  Checks.isAgentsListParams,
);
export const validateAgentsCreateParams = createProtocolValidator(
  S.AgentsCreateParamsSchema,
  Checks.isAgentsCreateParams,
);
export const validateAgentsUpdateParams = createProtocolValidator(
  S.AgentsUpdateParamsSchema,
  Checks.isAgentsUpdateParams,
);
export const validateAgentsAvatarGenerateParams = createProtocolValidator(
  S.AgentsAvatarGenerateParamsSchema,
  Checks.isAgentsAvatarGenerateParams,
);
export const validateAgentsAvatarGenerateResult = createProtocolValidator(
  S.AgentsAvatarGenerateResultSchema,
  Checks.isAgentsAvatarGenerateResult,
);
export const validateAgentsDeleteParams = createProtocolValidator(
  S.AgentsDeleteParamsSchema,
  Checks.isAgentsDeleteParams,
);
export const validateAgentsDetachParams = createProtocolValidator(
  S.AgentsDetachParamsSchema,
  Checks.isAgentsDetachParams,
);
export const validateAgentsFilesListParams = createProtocolValidator(
  S.AgentsFilesListParamsSchema,
  Checks.isAgentsFilesListParams,
);
export const validateAgentsFilesGetParams = createProtocolValidator(
  S.AgentsFilesGetParamsSchema,
  Checks.isAgentsFilesGetParams,
);
export const validateAgentsFilesSetParams = createProtocolValidator(
  S.AgentsFilesSetParamsSchema,
  Checks.isAgentsFilesSetParams,
);
export const validateAgentsWorkspaceListParams = createProtocolValidator(
  S.AgentsWorkspaceListParamsSchema,
  Checks.isAgentsWorkspaceListParams,
);
export const validateAgentsWorkspaceGetParams = createProtocolValidator(
  S.AgentsWorkspaceGetParamsSchema,
  Checks.isAgentsWorkspaceGetParams,
);
export const validateModelsAuthSetApiKeyParams = createProtocolValidator(
  S.ModelsAuthSetApiKeyParamsSchema,
  Checks.isModelsAuthSetApiKeyParams,
);
export const validateModelsAuthSetApiKeyResult = createProtocolValidator(
  S.ModelsAuthSetApiKeyResultSchema,
  Checks.isModelsAuthSetApiKeyResult,
);
export const validateModelsAuthLogoutParams = createProtocolValidator(
  S.ModelsAuthLogoutParamsSchema,
  Checks.isModelsAuthLogoutParams,
);
export const validateModelsAuthOrderSetParams = createProtocolValidator(
  S.ModelsAuthOrderSetParamsSchema,
  Checks.isModelsAuthOrderSetParams,
);
export const validateModelsAuthRefreshParams = createProtocolValidator(
  S.ModelsAuthRefreshParamsSchema,
  Checks.isModelsAuthRefreshParams,
);
export const validateModelsAuthStatusParams = createProtocolValidator(
  S.ModelsAuthStatusParamsSchema,
  Checks.isModelsAuthStatusParams,
);
export const validateModelsListParams = createProtocolValidator(
  S.ModelsListParamsSchema,
  Checks.isModelsListParams,
);
export const validateSkillsStatusParams = createProtocolValidator(
  S.SkillsStatusParamsSchema,
  Checks.isSkillsStatusParams,
);
export const validateToolsCatalogParams = createProtocolValidator(
  S.ToolsCatalogParamsSchema,
  Checks.isToolsCatalogParams,
);
export const validateToolsGitHubStatusParams = createProtocolValidator(
  S.ToolsGitHubStatusParamsSchema,
  Checks.isToolsGitHubStatusParams,
);
export const validateToolsGitHubStatusResult = createProtocolValidator(
  S.ToolsGitHubStatusResultSchema,
  Checks.isToolsGitHubStatusResult,
);
export const validateToolsGitHubConfigureParams = createProtocolValidator(
  S.ToolsGitHubConfigureParamsSchema,
  Checks.isToolsGitHubConfigureParams,
);
export const validateToolsGitHubAuthorizeStartParams = createProtocolValidator(
  S.ToolsGitHubAuthorizeStartParamsSchema,
  Checks.isToolsGitHubAuthorizeStartParams,
);
export const validateToolsGitHubAuthorizeStartResult = createProtocolValidator(
  S.ToolsGitHubAuthorizeStartResultSchema,
  Checks.isToolsGitHubAuthorizeStartResult,
);
export const validateToolsGitHubAuthorizePollParams = createProtocolValidator(
  S.ToolsGitHubAuthorizePollParamsSchema,
  Checks.isToolsGitHubAuthorizePollParams,
);
export const validateToolsGitHubAuthorizePollResult = createProtocolValidator(
  S.ToolsGitHubAuthorizePollResultSchema,
  Checks.isToolsGitHubAuthorizePollResult,
);
export const validateToolsGitHubAuthorizeCancelParams = createProtocolValidator(
  S.ToolsGitHubAuthorizeCancelParamsSchema,
  Checks.isToolsGitHubAuthorizeCancelParams,
);
export const validateToolsGitHubAuthorizeCancelResult = createProtocolValidator(
  S.ToolsGitHubAuthorizeCancelResultSchema,
  Checks.isToolsGitHubAuthorizeCancelResult,
);
export const validateToolsEffectiveParams = createProtocolValidator(
  S.ToolsEffectiveParamsSchema,
  Checks.isToolsEffectiveParams,
);
export const validateToolsInvokeParams = createProtocolValidator(
  S.ToolsInvokeParamsSchema,
  Checks.isToolsInvokeParams,
);
export const validateSkillsBinsParams = createProtocolValidator(
  S.SkillsBinsParamsSchema,
  Checks.isSkillsBinsParams,
);
export const validateSkillsInstallParams = createProtocolValidator(
  S.SkillsInstallParamsSchema,
  Checks.isSkillsInstallParams,
);
export const validateSkillsUploadBeginParams = createProtocolValidator(
  S.SkillsUploadBeginParamsSchema,
  Checks.isSkillsUploadBeginParams,
);
export const validateSkillsUploadChunkParams = createProtocolValidator(
  S.SkillsUploadChunkParamsSchema,
  Checks.isSkillsUploadChunkParams,
);
export const validateSkillsUploadCommitParams = createProtocolValidator(
  S.SkillsUploadCommitParamsSchema,
  Checks.isSkillsUploadCommitParams,
);
export const validateSkillsUpdateParams = createProtocolValidator(
  S.SkillsUpdateParamsSchema,
  Checks.isSkillsUpdateParams,
);
export const validateSkillsSearchParams = createProtocolValidator(
  S.SkillsSearchParamsSchema,
  Checks.isSkillsSearchParams,
);
export const validateSkillsDetailParams = createProtocolValidator(
  S.SkillsDetailParamsSchema,
  Checks.isSkillsDetailParams,
);
export const validateSkillsWorkshopListParams = createProtocolValidator(
  S.SkillsWorkshopListParamsSchema,
  Checks.isSkillsWorkshopListParams,
);
export const validateSkillsWorkshopChangesParams = createProtocolValidator(
  S.SkillsWorkshopChangesParamsSchema,
  Checks.isSkillsWorkshopChangesParams,
);
export const validateSkillsWorkshopReadParams = createProtocolValidator(
  S.SkillsWorkshopReadParamsSchema,
  Checks.isSkillsWorkshopReadParams,
);
export const validateSkillsWorkshopArchiveParams = createProtocolValidator(
  S.SkillsWorkshopArchiveParamsSchema,
  Checks.isSkillsWorkshopArchiveParams,
);
export const validateSkillsWorkshopRestoreParams = createProtocolValidator(
  S.SkillsWorkshopRestoreParamsSchema,
  Checks.isSkillsWorkshopRestoreParams,
);
export const validateSkillsWorkshopUndoParams = createProtocolValidator(
  S.SkillsWorkshopUndoParamsSchema,
  Checks.isSkillsWorkshopUndoParams,
);
export const validateSkillsSecurityVerdictsParams = createProtocolValidator(
  S.SkillsSecurityVerdictsParamsSchema,
  Checks.isSkillsSecurityVerdictsParams,
);
export const validateSkillsSkillCardParams = createProtocolValidator(
  S.SkillsSkillCardParamsSchema,
  Checks.isSkillsSkillCardParams,
);
export const validateSkillsFileGetParams = createProtocolValidator(
  S.SkillsFileGetParamsSchema,
  Checks.isSkillsFileGetParams,
);
export const validateModelsProbeParams = createProtocolValidator(
  S.ModelsProbeParamsSchema,
  Checks.isModelsProbeParams,
);
