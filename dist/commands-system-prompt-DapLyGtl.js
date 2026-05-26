import { v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { k as listRegisteredPluginAgentPromptGuidance } from "./command-registration-io1ALI_N.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-BtoDvmSR.js";
import { t as isAcpRuntimeSpawnAvailable } from "./availability-C-N5XwGI.js";
import { a as resolveBootstrapContextForRun } from "./bootstrap-files-D4ZYVMib.js";
import { t as createOpenClawCodingTools } from "./pi-tools-iVT6BGHc.js";
import { o as buildSystemPromptParams, s as resolveAgentPromptSurfaceForSessionKey, t as buildConfiguredAgentSystemPrompt } from "./system-prompt-config-BOuyiivW.js";
import "./sandbox-DiI74XYF.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-BoRIIBbL.js";
import "./skills-JUNRkaHl.js";
import { n as resolveEmbeddedFullAccessState } from "./sandbox-info-C5ksc8fy.js";
import { t as resolveRuntimePolicySessionKey } from "./runtime-policy-session-key-BBFWw42v.js";
import { n as getSkillsSnapshotVersion } from "./refresh-state-PCEDjmSb.js";
import { t as canExecRequestNode } from "./exec-defaults-60zNtKRO.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-BCbpja7h.js";
//#region src/auto-reply/reply/commands-system-prompt.ts
async function resolveCommandsSystemPromptBundle(params) {
	const workspaceDir = params.workspaceDir;
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const { sessionAgentId } = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.cfg,
		agentId: params.agentId
	});
	const { bootstrapFiles, contextFiles: injectedFiles } = await resolveBootstrapContextForRun({
		workspaceDir,
		config: params.cfg,
		sessionKey: params.sessionKey,
		sessionId: targetSessionEntry?.sessionId,
		agentId: sessionAgentId
	});
	const sandboxRuntime = resolveSandboxRuntimeStatus({
		cfg: params.cfg,
		sessionKey: resolveRuntimePolicySessionKey({
			cfg: params.cfg,
			ctx: params.ctx,
			sessionKey: params.sessionKey ?? params.ctx.SessionKey
		})
	});
	const toolPolicySessionKey = resolveRuntimePolicySessionKey({
		cfg: params.cfg,
		ctx: params.ctx,
		sessionKey: params.sessionKey
	});
	const skillsPrompt = (() => {
		try {
			return buildWorkspaceSkillSnapshot(workspaceDir, {
				config: params.cfg,
				agentId: sessionAgentId,
				eligibility: { remote: getRemoteSkillEligibility({ advertiseExecNode: canExecRequestNode({
					cfg: params.cfg,
					sessionEntry: targetSessionEntry,
					sessionKey: params.sessionKey,
					agentId: sessionAgentId
				}) }) },
				snapshotVersion: getSkillsSnapshotVersion(workspaceDir)
			});
		} catch {
			return {
				prompt: "",
				skills: [],
				resolvedSkills: []
			};
		}
	})().prompt ?? "";
	const tools = (() => {
		try {
			return createOpenClawCodingTools({
				config: params.cfg,
				agentId: sessionAgentId,
				workspaceDir,
				sessionKey: toolPolicySessionKey,
				allowGatewaySubagentBinding: true,
				messageProvider: params.command.channel,
				groupId: targetSessionEntry?.groupId ?? void 0,
				groupChannel: targetSessionEntry?.groupChannel ?? void 0,
				groupSpace: targetSessionEntry?.space ?? void 0,
				spawnedBy: targetSessionEntry?.spawnedBy ?? void 0,
				senderId: params.command.senderId,
				senderName: params.ctx.SenderName,
				senderUsername: params.ctx.SenderUsername,
				senderE164: params.ctx.SenderE164,
				modelProvider: params.provider,
				modelId: params.model
			});
		} catch {
			return [];
		}
	})();
	const toolNames = tools.map((t) => t.name);
	const promptSurface = resolveAgentPromptSurfaceForSessionKey(params.sessionKey);
	const defaultModelRef = resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: sessionAgentId
	});
	const defaultModelLabel = `${defaultModelRef.provider}/${defaultModelRef.model}`;
	const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildSystemPromptParams({
		config: params.cfg,
		agentId: sessionAgentId,
		workspaceDir,
		cwd: process.cwd(),
		runtime: {
			host: "unknown",
			os: "unknown",
			arch: "unknown",
			node: process.version,
			model: `${params.provider}/${params.model}`,
			defaultModel: defaultModelLabel
		}
	});
	const fullAccessState = resolveEmbeddedFullAccessState({ execElevated: {
		enabled: params.elevated.enabled,
		allowed: params.elevated.allowed,
		defaultLevel: params.resolvedElevatedLevel ?? "off"
	} });
	const sandboxInfo = sandboxRuntime.sandboxed ? {
		enabled: true,
		workspaceDir,
		workspaceAccess: "rw",
		elevated: {
			allowed: params.elevated.allowed,
			defaultLevel: params.resolvedElevatedLevel ?? "off",
			fullAccessAvailable: fullAccessState.available,
			...fullAccessState.blockedReason ? { fullAccessBlockedReason: fullAccessState.blockedReason } : {}
		}
	} : { enabled: false };
	return {
		systemPrompt: buildConfiguredAgentSystemPrompt({
			config: params.cfg,
			agentId: sessionAgentId,
			workspaceDir,
			defaultThinkLevel: params.resolvedThinkLevel,
			reasoningLevel: params.resolvedReasoningLevel,
			extraSystemPrompt: void 0,
			ownerNumbers: void 0,
			reasoningTagHint: false,
			toolNames,
			userTimezone,
			userTime,
			userTimeFormat,
			contextFiles: injectedFiles,
			skillsPrompt,
			heartbeatPrompt: void 0,
			acpEnabled: isAcpRuntimeSpawnAvailable({
				config: params.cfg,
				sandboxed: sandboxRuntime.sandboxed
			}),
			promptSurface,
			nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({ surface: promptSurface }),
			runtimeInfo,
			sandboxInfo
		}),
		tools,
		skillsPrompt,
		bootstrapFiles,
		injectedFiles,
		sandboxRuntime
	};
}
//#endregion
export { resolveCommandsSystemPromptBundle as t };
