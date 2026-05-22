import { m as resolveSessionAgentIds } from "./agent-scope-CcybJBoN.js";
import { O as listRegisteredPluginAgentPromptGuidance } from "./types-hw-AVEBS.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-CyWx9aXc.js";
import { t as isAcpRuntimeSpawnAvailable } from "./availability-CZfjbXAX.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-DrvvYJ13.js";
import { n as buildTtsSystemPromptHint } from "./tts-runtime-C-sLqX9f.js";
import "./tts-D96XxHUA.js";
import { a as resolveBootstrapContextForRun } from "./bootstrap-files-DkuHtjZt.js";
import { t as createOpenClawCodingTools } from "./pi-tools-Ch84T_iU.js";
import "./sandbox-G5EnSfYs.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-CwruSRrC.js";
import "./skills-f5Q_xbXL.js";
import { t as buildSystemPromptParams } from "./system-prompt-params-DQn7oCW4.js";
import { n as buildAgentSystemPrompt } from "./system-prompt-Cmp3TeyR.js";
import { n as resolveEmbeddedFullAccessState } from "./sandbox-info-52wdvS-T.js";
import { t as canExecRequestNode } from "./exec-defaults-CcWq-y0T.js";
import { n as getSkillsSnapshotVersion } from "./refresh-state-qFqd6YD7.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-CJg703wl.js";
import { t as resolveRuntimePolicySessionKey } from "./runtime-policy-session-key-ByPeb7LU.js";
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
		sessionId: targetSessionEntry?.sessionId
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
	const ttsHint = params.cfg ? buildTtsSystemPromptHint(params.cfg, sessionAgentId) : void 0;
	return {
		systemPrompt: buildAgentSystemPrompt({
			workspaceDir,
			defaultThinkLevel: params.resolvedThinkLevel,
			reasoningLevel: params.resolvedReasoningLevel,
			extraSystemPrompt: void 0,
			ownerNumbers: void 0,
			reasoningTagHint: false,
			toolNames,
			modelAliasLines: [],
			userTimezone,
			userTime,
			userTimeFormat,
			contextFiles: injectedFiles,
			skillsPrompt,
			heartbeatPrompt: void 0,
			ttsHint,
			acpEnabled: isAcpRuntimeSpawnAvailable({
				config: params.cfg,
				sandboxed: sandboxRuntime.sandboxed
			}),
			nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance(),
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
