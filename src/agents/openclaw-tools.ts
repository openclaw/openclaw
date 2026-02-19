import type { OpenClawConfig } from "../config/config.js";
import { resolvePluginTools } from "../plugins/tools.js";
import type { GatewayMessageChannel } from "../utils/message-channel.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
import { createAgentsListTool } from "./tools/agents-list-tool.js";
import { createBrowserTool } from "./tools/browser-tool.js";
import { createCanvasTool } from "./tools/canvas-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createCronTool } from "./tools/cron-tool.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createImageTool } from "./tools/image-tool.js";
import { createMessageTool } from "./tools/message-tool.js";
import { createNodesTool } from "./tools/nodes-tool.js";
import { createSessionStatusTool } from "./tools/session-status-tool.js";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSocietyOfMindsTool } from "./tools/society-of-minds-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";
import { createSessionsSpawnTool } from "./tools/sessions-spawn-tool.js";
import { createSubagentsTool } from "./tools/subagents-tool.js";
import { createTtsTool } from "./tools/tts-tool.js";
import { createWebFetchTool, createWebSearchTool } from "./tools/web-tools.js";
import {
  createNewsAggregateTool,
  createNewsFetchTool,
  createNewsSourcesTool,
  createNewsStatusTool,
} from "./tools/news-tools.js";
import {
  createContentRankTool,
  createContentClusterTool,
  createContentTopTool,
} from "./tools/content-ranking-tools.js";
import {
  createSEOCrosslinkTool,
  createGEOCheckRankingTool,
  createSEOOptimizeTool,
} from "./tools/seo-tools.js";
import {
  createEnterpriseWorkflowTool,
  createEnterpriseApproveTool,
  createEnterpriseStatusTool,
} from "./tools/enterprise-tools.js";
import {
  createThreatTrackActorTool,
  createThreatAddIoCTool,
  createThreatSearchIoCTool,
  createThreatListCampaignsTool,
  createThreatAnalyzeCorrelationTool,
  createCredentialMonitorTool,
  createThreatShareExportTool,
  createThreatShareImportTool,
  createThreatShareStatusTool,
  createVulnTrackTool,
  createVulnCheckTool,
  createVulnPatchStatusTool,
  createVulnExploitDetectionTool,
  createSecurityAssessWintershieldTool,
  createSecurityMitigateWintershieldTool,
  createInfraAssessOtTool,
  createInfraDetectPrepositioningTool,
  createInfraResiliencePlanTool,
  createAiThreatDetectAnomalyTool,
  createAiThreatRespondTool,
  createAiThreatHuntTool,
} from "./tools/cybersecurity-tools.js";
import {
  createPentestReconTool,
  createPentestExploitTool,
  createPentestPayloadTool,
  createPentestPostExploitTool,
  createPentestReportTool,
  createPentestC2Tool,
  createPentestNmapTool,
  createPentestMetasploitTool,
  createPentestBurpTool,
  createPentestShodanTool,
  createPentestCensysTool,
} from "./tools/pentest-tools.js";
import {
  createDefenseSiemQueryTool,
  createDefenseIncidentResponseTool,
  createDefenseThreatHuntTool,
  createDefenseLogAnalysisTool,
  createDefenseForensicsTool,
  createDefenseMalwareAnalysisTool,
  createDefenseSplunkTool,
  createDefenseElasticTool,
  createDefenseSentinelTool,
  createDefenseCrowdstrikeTool,
  createDefenseMispTool,
} from "./tools/defense-tools.js";
import {
  createThreatModelExtendTool,
  createRedTeamAutomateTool,
  createThreatModelGenerateTool,
  createAttackScenarioGenerateTool,
  createVulnerabilityDrivenTestTool,
  createRedTeamFromIntelTool,
  createThreatModelFromActorTool,
} from "./tools/security-automation-tools.js";
import {
  createThreatHuntProactiveTool,
  createThreatHuntSectorTool,
  createThreatHuntAnomalyTool,
} from "./tools/threat-hunting-tools.js";
import {
  createVulnerabilityInstantTestTool,
  createAttackResponseAutomatedTool,
} from "./tools/speed-automation-tools.js";
import {
  createPentestWebDiscoverTool,
  createPentestWebProxyTool,
  createPentestWebXssTool,
  createPentestWebSqliTool,
  createPentestWebCsrfTool,
  createPentestWebHttpsTool,
  createPentestWebFrameworkTool,
} from "./tools/web-security-tools.js";
import {
  createLLMPromptInjectionTool,
  createLLMIndirectInjectionTool,
  createLLMDetectInjectionTool,
  createLLMValidateDataBoundariesTool,
  createLLMJailbreakTool,
  createLLMMultiTurnTool,
  createLLMEncodingAttacksTool,
  createLLMSycophancyTool,
  createLLMManyShotTool,
  createLLMRAGPoisoningTool,
  createLLMDetectPoisonedRetrievalTool,
  createLLMValidateRAGIntegrityTool,
  createLLMAdversarialSEOTool,
  createLLMRedTeamTool,
  createLLMGenerateAttackScenariosTool,
  createLLMCognitiveDoSTool,
  createLLMContextOverflowTool,
  createLLMValidateGuardrailsTool,
  createLLMTestArchitecturalDefensesTool,
  createLLMMonitorCoTTool,
  createLLMValidateInstructionHierarchyTool,
  createLLMTestDeliberativeAlignmentTool,
} from "./tools/llm-security-tools.js";
import {
  createCognitiveThreatDetectionTool,
  createDecisionIntegrityTool,
  createEscalationControlTool,
  createContextProvenanceTool,
  createGracefulDegradationTool,
  createCognitiveResilienceSimulationTool,
  createTrustTrajectoryTool,
  createDecisionLogTool,
  createOODALoopTool,
} from "./tools/cognitive-security-tools.js";
import {
  createARRGenerateAttacksTool,
  createARROptimizeAttackTool,
  createARREvaluateAttackTool,
  createARRRankAttacksTool,
  createARRGenerateTestPackTool,
  createARRRunBenchmarkTool,
  createARRCompileFindingsTool,
} from "./tools/adversary-recommender-tools.js";
import {
  createSwarmOrchestrateTool,
  createSwarmPlanRedTeamTool,
  createSwarmPlanBlueTeamTool,
  createSwarmConsensusTool,
  createSwarmExecuteTool,
  createSwarmVsSwarmTool,
  createSwarmCollaborateTool,
  createSwarmIntegrateARRTool,
  createSwarmIntegrateCognitiveTool,
} from "./tools/swarm-agent-tools.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export function createOpenClawTools(options?: {
  sandboxBrowserBridgeUrl?: string;
  allowHostBrowserControl?: boolean;
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  /** Delivery target (e.g. telegram:group:123:topic:456) for topic/thread routing. */
  agentTo?: string;
  /** Thread/topic identifier for routing replies to the originating thread. */
  agentThreadId?: string | number;
  /** Group id for channel-level tool policy inheritance. */
  agentGroupId?: string | null;
  /** Group channel label for channel-level tool policy inheritance. */
  agentGroupChannel?: string | null;
  /** Group space label for channel-level tool policy inheritance. */
  agentGroupSpace?: string | null;
  agentDir?: string;
  sandboxRoot?: string;
  sandboxFsBridge?: SandboxFsBridge;
  workspaceDir?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  pluginToolAllowlist?: string[];
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
  /** Explicit agent ID override for cron/hook sessions. */
  requesterAgentIdOverride?: string;
  /** Require explicit message targets (no implicit last-route sends). */
  requireExplicitMessageTarget?: boolean;
  /** If true, omit the message tool from the tool list. */
  disableMessageTool?: boolean;
  /** Trusted sender id from inbound context (not tool args). */
  requesterSenderId?: string | null;
  /** Whether the requesting sender is an owner. */
  senderIsOwner?: boolean;
}): AnyAgentTool[] {
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir);
  const imageTool = options?.agentDir?.trim()
    ? createImageTool({
        config: options?.config,
        agentDir: options.agentDir,
        workspaceDir,
        sandbox:
          options?.sandboxRoot && options?.sandboxFsBridge
            ? { root: options.sandboxRoot, bridge: options.sandboxFsBridge }
            : undefined,
        modelHasVision: options?.modelHasVision,
      })
    : null;
  const webSearchTool = createWebSearchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const webFetchTool = createWebFetchTool({
    config: options?.config,
    sandboxed: options?.sandboxed,
  });
  const messageTool = options?.disableMessageTool
    ? null
    : createMessageTool({
        agentAccountId: options?.agentAccountId,
        agentSessionKey: options?.agentSessionKey,
        config: options?.config,
        currentChannelId: options?.currentChannelId,
        currentChannelProvider: options?.agentChannel,
        currentThreadTs: options?.currentThreadTs,
        replyToMode: options?.replyToMode,
        hasRepliedRef: options?.hasRepliedRef,
        sandboxRoot: options?.sandboxRoot,
        requireExplicitTarget: options?.requireExplicitMessageTarget,
        requesterSenderId: options?.requesterSenderId ?? undefined,
      });
  const tools: AnyAgentTool[] = [
    createBrowserTool({
      sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
      allowHostControl: options?.allowHostBrowserControl,
    }),
    createCanvasTool({ config: options?.config }),
    createNodesTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createCronTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    ...(messageTool ? [messageTool] : []),
    createTtsTool({
      agentChannel: options?.agentChannel,
      config: options?.config,
    }),
    createGatewayTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createAgentsListTool({
      agentSessionKey: options?.agentSessionKey,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSessionsListTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsHistoryTool({
      agentSessionKey: options?.agentSessionKey,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSendTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      sandboxed: options?.sandboxed,
    }),
    createSessionsSpawnTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      sandboxed: options?.sandboxed,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createSubagentsTool({
      agentSessionKey: options?.agentSessionKey,
    }),
    createSessionStatusTool({
      agentSessionKey: options?.agentSessionKey,
      config: options?.config,
    }),
    createSocietyOfMindsTool({
      agentSessionKey: options?.agentSessionKey,
      agentChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      agentTo: options?.agentTo,
      agentThreadId: options?.agentThreadId,
      agentGroupId: options?.agentGroupId,
      agentGroupChannel: options?.agentGroupChannel,
      agentGroupSpace: options?.agentGroupSpace,
      requesterAgentIdOverride: options?.requesterAgentIdOverride,
    }),
    createNewsAggregateTool(),
    createNewsSourcesTool(),
    createNewsFetchTool(),
    createNewsStatusTool(),
    createContentRankTool(),
    createContentClusterTool(),
    createContentTopTool(),
    createSEOCrosslinkTool(),
    createGEOCheckRankingTool(),
    createSEOOptimizeTool(),
    createEnterpriseWorkflowTool(),
    createEnterpriseApproveTool(),
    createEnterpriseStatusTool(),
    createThreatTrackActorTool(),
    createThreatAddIoCTool(),
    createThreatSearchIoCTool(),
    createThreatListCampaignsTool(),
    createThreatAnalyzeCorrelationTool(),
    createCredentialMonitorTool(),
    createThreatShareExportTool(),
    createThreatShareImportTool(),
    createThreatShareStatusTool(),
    createVulnTrackTool(),
    createVulnCheckTool(),
    createVulnPatchStatusTool(),
    createVulnExploitDetectionTool(),
    createSecurityAssessWintershieldTool(),
    createSecurityMitigateWintershieldTool(),
    createInfraAssessOtTool(),
    createInfraDetectPrepositioningTool(),
    createInfraResiliencePlanTool(),
    createAiThreatDetectAnomalyTool(),
    createAiThreatRespondTool(),
    createAiThreatHuntTool(),
    createPentestReconTool(),
    createPentestExploitTool(),
    createPentestPayloadTool(),
    createPentestPostExploitTool(),
    createPentestReportTool(),
    createPentestC2Tool(),
    createPentestNmapTool(),
    createPentestMetasploitTool(),
    createPentestBurpTool(),
    createPentestShodanTool(),
    createPentestCensysTool(),
    createDefenseSiemQueryTool(),
    createDefenseIncidentResponseTool(),
    createDefenseThreatHuntTool(),
    createDefenseLogAnalysisTool(),
    createDefenseForensicsTool(),
    createDefenseMalwareAnalysisTool(),
    createDefenseSplunkTool(),
    createDefenseElasticTool(),
    createDefenseSentinelTool(),
    createDefenseCrowdstrikeTool(),
    createDefenseMispTool(),
    createThreatModelExtendTool(),
    createRedTeamAutomateTool(),
    createThreatModelGenerateTool(),
    createAttackScenarioGenerateTool(),
    createVulnerabilityDrivenTestTool(),
    createRedTeamFromIntelTool(),
    createThreatModelFromActorTool(),
    createThreatHuntProactiveTool(),
    createThreatHuntSectorTool(),
    createThreatHuntAnomalyTool(),
    createVulnerabilityInstantTestTool(),
    createAttackResponseAutomatedTool(),
    createSectorIntelligenceTrackTool(),
    createPentestWebDiscoverTool(),
    createPentestWebProxyTool(),
    createPentestWebXssTool(),
    createPentestWebSqliTool(),
    createPentestWebCsrfTool(),
    createPentestWebHttpsTool(),
    createPentestWebFrameworkTool(),
    createLLMPromptInjectionTool(),
    createLLMIndirectInjectionTool(),
    createLLMDetectInjectionTool(),
    createLLMValidateDataBoundariesTool(),
    createLLMJailbreakTool(),
    createLLMMultiTurnTool(),
    createLLMEncodingAttacksTool(),
    createLLMSycophancyTool(),
    createLLMManyShotTool(),
    createLLMRAGPoisoningTool(),
    createLLMDetectPoisonedRetrievalTool(),
    createLLMValidateRAGIntegrityTool(),
    createLLMAdversarialSEOTool(),
    createLLMRedTeamTool(),
    createLLMGenerateAttackScenariosTool(),
    createLLMCognitiveDoSTool(),
    createLLMContextOverflowTool(),
    createLLMValidateGuardrailsTool(),
    createLLMTestArchitecturalDefensesTool(),
    createLLMMonitorCoTTool(),
    createLLMValidateInstructionHierarchyTool(),
    createLLMTestDeliberativeAlignmentTool(),
    createCognitiveThreatDetectionTool(),
    createDecisionIntegrityTool(),
    createEscalationControlTool(),
    createContextProvenanceTool(),
    createGracefulDegradationTool(),
    createCognitiveResilienceSimulationTool(),
    createTrustTrajectoryTool(),
    createDecisionLogTool(),
    createOODALoopTool(),
    createARRGenerateAttacksTool(),
    createARROptimizeAttackTool(),
    createARREvaluateAttackTool(),
    createARRRankAttacksTool(),
    createARRGenerateTestPackTool(),
    createARRRunBenchmarkTool(),
    createARRCompileFindingsTool(),
    createSwarmOrchestrateTool(),
    createSwarmPlanRedTeamTool(),
    createSwarmPlanBlueTeamTool(),
    createSwarmConsensusTool(),
    createSwarmExecuteTool(),
    createSwarmVsSwarmTool(),
    createSwarmCollaborateTool(),
    createSwarmIntegrateARRTool(),
    createSwarmIntegrateCognitiveTool(),
    ...(webSearchTool ? [webSearchTool] : []),
    ...(webFetchTool ? [webFetchTool] : []),
    ...(imageTool ? [imageTool] : []),
  ];

  const pluginTools = resolvePluginTools({
    context: {
      config: options?.config,
      workspaceDir,
      agentDir: options?.agentDir,
      agentId: resolveSessionAgentId({
        sessionKey: options?.agentSessionKey,
        config: options?.config,
      }),
      sessionKey: options?.agentSessionKey,
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      sandboxed: options?.sandboxed,
    },
    existingToolNames: new Set(tools.map((tool) => tool.name)),
    toolAllowlist: options?.pluginToolAllowlist,
  });

  return [...tools, ...pluginTools];
}
