import { m as resolveSessionAgentIds } from "./agent-scope-CbabgXwH.js";
import { D as listRegisteredPluginAgentPromptGuidance } from "./types-C1haBFkR.js";
import { o as resolveDefaultModelForAgent } from "./model-selection-aDhlumjq.js";
import { t as isAcpRuntimeSpawnAvailable } from "./availability-KiRPNu9X.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-BgCNJn5R.js";
import { n as buildTtsSystemPromptHint } from "./tts-runtime-BZA-v29I.js";
import "./tts-BbG2fjoP.js";
import { i as resolveBootstrapContextForRun } from "./bootstrap-files-TTD4YyqW.js";
import { t as createOpenClawCodingTools } from "./pi-tools-C_rArdtd.js";
import "./sandbox-DVbI4dTa.js";
import { t as buildWorkspaceSkillSnapshot } from "./workspace-CrNr2ieh.js";
import "./skills-BHYsqYYy.js";
import { t as buildSystemPromptParams } from "./system-prompt-params-D-zP0tic.js";
import { t as buildAgentSystemPrompt } from "./system-prompt-BaKHDFk7.js";
import { n as resolveEmbeddedFullAccessState } from "./sandbox-info-Dx7uFmwG.js";
import { t as canExecRequestNode } from "./exec-defaults-DBUJMyF-.js";
import { n as getSkillsSnapshotVersion } from "./refresh-state-BoghVd_F.js";
import { t as getRemoteSkillEligibility } from "./skills-remote-Cm-LW7Lr.js";
import { t as resolveRuntimePolicySessionKey } from "./runtime-policy-session-key-BiBdcIc9.js";
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
