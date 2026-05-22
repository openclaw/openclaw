import { i as formatErrorMessage } from "./errors-D4wGeA6B.js";
import { p as resolveUserPath } from "./utils-DX02THHb.js";
import { v as resolveSessionAgentIds } from "./agent-scope-C51VTAKH.js";
import { a as resolveAgentDir } from "./agent-scope-config-C5zL9i5G.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER, t as DEFAULT_CONTEXT_TOKENS } from "./defaults-mDjiWzE5.js";
import { c as resolveContextConfigProviderForRuntime } from "./openai-codex-routing-BJHjeWK7.js";
import { t as resolveAgentHarnessPolicy } from "./policy-Bup__O5_.js";
import { t as getGlobalHookRunner } from "./hook-runner-global-DNOIUQa8.js";
import { a as resolveContextEngineOwnerPluginId, i as resolveContextEngine } from "./registry-B-mVXdYO.js";
import { t as ensureContextEnginesInitialized } from "./init-COtYQwfZ.js";
import { i as enqueueCommandInLane } from "./command-queue-Dx7TD9jt.js";
import { O as rotateTranscriptFileAfterCompaction, k as shouldRotateCompactionTranscript, t as maybeCompactAgentHarnessSession } from "./selection-BImg9tMR.js";
import { n as resolveEmbeddedCompactionTarget, r as resolveContextEngineCapabilities, t as buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context-DFRBcvSQ.js";
import { t as log } from "./logger-JwYbMk1I.js";
import { n as resolveGlobalLane, r as resolveSessionLane } from "./lanes-BrQRlRRS.js";
import { t as runContextEngineMaintenance } from "./context-engine-maintenance-CuzqmS_Z.js";
import { r as resolveCompactionTimeoutMs, t as compactContextEngineWithSafetyTimeout } from "./compaction-safety-timeout-DZX3bbpS.js";
import { a as resolveContextWindowInfo } from "./context-window-guard-BAul1ZXt.js";
import { c as captureCompactionCheckpointSnapshotAsync, h as resolveSessionCompactionCheckpointReason, l as cleanupCompactionCheckpointSnapshot, m as readSessionLeafIdFromTranscriptAsync, n as asCompactionHookRunner, p as persistSessionCompactionCheckpoint, s as runPostCompactionSideEffects, t as readPiModelContextTokens } from "./model-context-tokens-DbkqdM55.js";
import { t as ensureRuntimePluginsLoaded } from "./runtime-plugins-N9_gPRXP.js";
import { n as resolveModelAsync } from "./model-Bjrn3Q1j.js";
//#region src/agents/pi-embedded-runner/compact.queued.ts
/**
* Compacts a session with lane queueing (session lane + global lane).
* Use this from outside a lane context. If already inside a lane, use
* `compactEmbeddedPiSessionDirect` to avoid deadlocks.
*/
async function compactEmbeddedPiSession(params) {
	ensureRuntimePluginsLoaded({
		config: params.config,
		workspaceDir: params.workspaceDir,
		allowGatewaySubagentBinding: params.allowGatewaySubagentBinding
	});
	ensureContextEnginesInitialized();
	const agentIds = resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.config
	});
	const agentDir = params.agentDir ?? resolveAgentDir(params.config ?? {}, agentIds.sessionAgentId);
	const resolvedWorkspaceDir = resolveUserPath(params.workspaceDir);
	const contextEngine = await resolveContextEngine(params.config, {
		agentDir,
		workspaceDir: resolvedWorkspaceDir
	});
	let contextTokenBudget = params.contextTokenBudget;
	if (!contextTokenBudget || !Number.isFinite(contextTokenBudget) || contextTokenBudget <= 0) {
		const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
			config: params.config,
			provider: params.provider,
			modelId: params.model,
			authProfileId: params.authProfileId,
			defaultProvider: DEFAULT_PROVIDER,
			defaultModel: DEFAULT_MODEL
		});
		const ceProvider = resolvedCompactionTarget.provider ?? "openai";
		const ceModelId = resolvedCompactionTarget.model ?? "gpt-5.5";
		const { model: ceModel } = await resolveModelAsync(ceProvider, ceModelId, agentDir, params.config);
		const ceRuntimeModel = ceModel;
		const ceHarnessPolicy = resolveAgentHarnessPolicy({
			provider: ceProvider,
			modelId: ceModelId,
			config: params.config,
			agentId: agentIds.sessionAgentId,
			sessionKey: params.sessionKey
		});
		contextTokenBudget = resolveContextWindowInfo({
			cfg: params.config,
			provider: resolveContextConfigProviderForRuntime({
				provider: ceProvider,
				runtimeId: ceHarnessPolicy.runtime
			}),
			modelId: ceModelId,
			modelContextTokens: readPiModelContextTokens(ceModel),
			modelContextWindow: ceRuntimeModel?.contextWindow,
			defaultTokens: DEFAULT_CONTEXT_TOKENS
		}).tokens;
	}
	const contextEngineRuntimeContext = buildCompactionContextEngineRuntimeContext({
		params,
		agentDir,
		contextTokenBudget,
		contextEnginePluginId: resolveContextEngineOwnerPluginId(contextEngine)
	});
	const harnessResult = await maybeCompactAgentHarnessSession({
		...params,
		contextEngine,
		contextTokenBudget,
		contextEngineRuntimeContext
	});
	if (harnessResult) {
		await contextEngine.dispose?.();
		return harnessResult;
	}
	const sessionLane = resolveSessionLane(params.sessionKey?.trim() || params.sessionId);
	const globalLane = resolveGlobalLane(params.lane);
	const enqueueGlobal = params.enqueue ?? ((task, opts) => enqueueCommandInLane(globalLane, task, opts));
	return enqueueCommandInLane(sessionLane, () => enqueueGlobal(async () => {
		let checkpointSnapshot = null;
		let checkpointSnapshotRetained = false;
		try {
			const engineOwnsCompaction = contextEngine.info.ownsCompaction === true;
			checkpointSnapshot = engineOwnsCompaction ? await captureCompactionCheckpointSnapshotAsync({ sessionFile: params.sessionFile }) : null;
			const hookRunner = engineOwnsCompaction ? asCompactionHookRunner(getGlobalHookRunner()) : null;
			const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
			const { sessionAgentId } = resolveSessionAgentIds({
				sessionKey: params.sessionKey,
				config: params.config
			});
			const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
			const hookCtx = {
				sessionId: params.sessionId,
				agentId: sessionAgentId,
				sessionKey: hookSessionKey,
				workspaceDir: resolvedWorkspaceDir,
				messageProvider: resolvedMessageProvider
			};
			const runtimeContext = contextEngineRuntimeContext;
			if (hookRunner?.hasHooks?.("before_compaction") && hookRunner.runBeforeCompaction) try {
				await hookRunner.runBeforeCompaction({
					messageCount: -1,
					sessionFile: params.sessionFile
				}, hookCtx);
			} catch (err) {
				log.warn("before_compaction hook failed", { errorMessage: formatErrorMessage(err) });
			}
			let result;
			try {
				result = await compactContextEngineWithSafetyTimeout(contextEngine, {
					sessionId: params.sessionId,
					sessionKey: params.sessionKey,
					sessionFile: params.sessionFile,
					tokenBudget: contextTokenBudget,
					currentTokenCount: params.currentTokenCount,
					compactionTarget: params.trigger === "manual" ? "threshold" : "budget",
					customInstructions: params.customInstructions,
					force: params.trigger === "manual",
					runtimeContext
				}, resolveCompactionTimeoutMs(params.config), params.abortSignal);
			} catch (compactErr) {
				log.warn("context-engine compaction failed", { errorMessage: formatErrorMessage(compactErr) });
				result = {
					ok: false,
					compacted: false,
					reason: formatErrorMessage(compactErr)
				};
			}
			const delegatedSessionId = result.result?.sessionId;
			const delegatedSessionFile = result.result?.sessionFile;
			const delegatedRotatedTranscript = typeof delegatedSessionId === "string" && delegatedSessionId !== params.sessionId || typeof delegatedSessionFile === "string" && delegatedSessionFile !== params.sessionFile;
			let postCompactionSessionId = delegatedSessionId ?? params.sessionId;
			let postCompactionSessionFile = delegatedSessionFile ?? params.sessionFile;
			let postCompactionLeafId;
			if (result.ok && result.compacted) {
				if (shouldRotateCompactionTranscript(params.config) && !delegatedRotatedTranscript) try {
					const rotation = await rotateTranscriptFileAfterCompaction({ sessionFile: params.sessionFile });
					if (rotation.rotated) {
						postCompactionSessionId = rotation.sessionId ?? postCompactionSessionId;
						postCompactionSessionFile = rotation.sessionFile ?? postCompactionSessionFile;
						postCompactionLeafId = rotation.leafId;
						log.info(`[compaction] rotated active transcript after context-engine compaction (sessionKey=${params.sessionKey ?? params.sessionId})`);
					}
				} catch (err) {
					log.warn("failed to rotate compacted transcript", { errorMessage: formatErrorMessage(err) });
				}
				if (params.config && params.sessionKey && checkpointSnapshot) try {
					const postLeafId = postCompactionLeafId ?? await readSessionLeafIdFromTranscriptAsync(postCompactionSessionFile) ?? void 0;
					checkpointSnapshotRetained = await persistSessionCompactionCheckpoint({
						cfg: params.config,
						sessionKey: params.sessionKey,
						sessionId: postCompactionSessionId,
						reason: resolveSessionCompactionCheckpointReason({ trigger: params.trigger }),
						snapshot: checkpointSnapshot,
						summary: result.result?.summary,
						firstKeptEntryId: result.result?.firstKeptEntryId,
						tokensBefore: result.result?.tokensBefore,
						tokensAfter: result.result?.tokensAfter,
						postSessionFile: postCompactionSessionFile,
						postLeafId,
						postEntryId: postLeafId
					}) !== null;
				} catch (err) {
					log.warn("failed to persist compaction checkpoint", { errorMessage: formatErrorMessage(err) });
				}
				await runContextEngineMaintenance({
					contextEngine,
					sessionId: postCompactionSessionId,
					sessionKey: params.sessionKey,
					sessionFile: postCompactionSessionFile,
					reason: "compaction",
					runtimeContext,
					config: params.config
				});
			}
			if (engineOwnsCompaction && result.ok && result.compacted) await runPostCompactionSideEffects({
				config: params.config,
				sessionKey: params.sessionKey,
				sessionFile: postCompactionSessionFile
			});
			if (result.ok && result.compacted && hookRunner?.hasHooks?.("after_compaction") && hookRunner.runAfterCompaction) try {
				const afterHookCtx = {
					...hookCtx,
					sessionId: postCompactionSessionId
				};
				await hookRunner.runAfterCompaction({
					messageCount: -1,
					compactedCount: -1,
					tokenCount: result.result?.tokensAfter,
					sessionFile: postCompactionSessionFile
				}, afterHookCtx);
			} catch (err) {
				log.warn("after_compaction hook failed", { errorMessage: formatErrorMessage(err) });
			}
			return {
				ok: result.ok,
				compacted: result.compacted,
				reason: result.reason,
				result: result.result ? {
					summary: result.result.summary ?? "",
					firstKeptEntryId: result.result.firstKeptEntryId ?? "",
					tokensBefore: result.result.tokensBefore,
					tokensAfter: result.result.tokensAfter,
					details: result.result.details,
					...postCompactionSessionId !== params.sessionId ? { sessionId: postCompactionSessionId } : {},
					...postCompactionSessionFile !== params.sessionFile ? { sessionFile: postCompactionSessionFile } : {}
				} : void 0
			};
		} finally {
			if (!checkpointSnapshotRetained) await cleanupCompactionCheckpointSnapshot(checkpointSnapshot);
			await contextEngine.dispose?.();
		}
	}));
}
function buildCompactionContextEngineRuntimeContext(params) {
	const { sessionAgentId } = resolveSessionAgentIds({
		sessionKey: params.params.sessionKey,
		config: params.params.config
	});
	return {
		...params.params,
		...buildEmbeddedCompactionRuntimeContext({
			sessionKey: params.params.sessionKey,
			messageChannel: params.params.messageChannel,
			messageProvider: params.params.messageProvider,
			agentAccountId: params.params.agentAccountId,
			currentChannelId: params.params.currentChannelId,
			currentThreadTs: params.params.currentThreadTs,
			currentMessageId: params.params.currentMessageId,
			authProfileId: params.params.authProfileId,
			workspaceDir: params.params.workspaceDir,
			agentDir: params.agentDir,
			config: params.params.config,
			skillsSnapshot: params.params.skillsSnapshot,
			senderIsOwner: params.params.senderIsOwner,
			senderId: params.params.senderId,
			provider: params.params.provider,
			modelId: params.params.model,
			modelFallbacksOverride: params.params.modelFallbacksOverride,
			thinkLevel: params.params.thinkLevel,
			reasoningLevel: params.params.reasoningLevel,
			bashElevated: params.params.bashElevated,
			extraSystemPrompt: params.params.extraSystemPrompt,
			sourceReplyDeliveryMode: params.params.sourceReplyDeliveryMode,
			ownerNumbers: params.params.ownerNumbers
		}),
		...resolveContextEngineCapabilities({
			config: params.params.config,
			sessionKey: params.params.sessionKey,
			agentId: sessionAgentId,
			contextEnginePluginId: params.contextEnginePluginId,
			purpose: "context-engine.compaction"
		}),
		tokenBudget: params.contextTokenBudget,
		currentTokenCount: params.params.currentTokenCount
	};
}
//#endregion
export { compactEmbeddedPiSession as t };
