import { v as resolveSessionAgentIds } from "./agent-scope-Bl5pjInQ.js";
import { k as listRegisteredPluginAgentPromptGuidance } from "./command-registration-BCGyjQsO.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-Buvz1_IB.js";
import { t as isAcpRuntimeSpawnAvailable } from "./availability-D7yiNEoG.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-PLaGM2kn.js";
import { a as resolveBootstrapContextForRun } from "./bootstrap-files-BkmXzi3V.js";
import { t as createOpenClawCodingTools } from "./pi-tools-DlDJY5a5.js";
import { o as buildSystemPromptParams, s as resolveAgentPromptSurfaceForSessionKey, t as buildConfiguredAgentSystemPrompt } from "./system-prompt-config-5717BMgx.js";
import "./sandbox-Cc4FV_Dy.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-Bf8eH3zJ.js";
import "./skills-D-XMsnmT.js";
import { n as resolveEmbeddedFullAccessState } from "./sandbox-info-C5ksc8fy.js";
import { t as canExecRequestNode } from "./exec-defaults-_ZXvHhDj.js";
import { n as getSkillsSnapshotVersion } from "./refresh-state-PCEDjmSb.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-CLOEGVYk.js";
import { t as resolveRuntimePolicySessionKey } from "./runtime-policy-session-key-C-astWqw.js";
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
	const continuationEnabled = params.cfg?.agents?.defaults?.continuation?.enabled === true;
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
				senderIsOwner: params.command.senderIsOwner,
				modelProvider: params.provider,
				modelId: params.model,
				requestCompactionOpts: continuationEnabled ? {
					sessionId: targetSessionEntry?.sessionId,
					getContextUsage: () => null,
					triggerCompaction: async () => ({
						ok: false,
						compacted: false,
						reason: "system-prompt inventory path"
					})
				} : void 0
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
			sandboxInfo,
			memoryCitationsMode: params.cfg?.memory?.citations,
			continuationEnabled: params.cfg?.agents?.defaults?.continuation?.enabled === true
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
