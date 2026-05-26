import { t as createSubsystemLogger } from "./subsystem-DLRoKDlF.js";
import { i as resolveContextEngine } from "./registry-CNnI9MEE.js";
import { t as buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context-BjifZ6Wv.js";
import { g as createPreparedEmbeddedPiSettingsManager, u as resolveLiveToolResultMaxChars } from "./compaction-xbracGie.js";
import { a as resolveEffectiveCompactionMode, n as applyPiAutoCompactionGuard } from "./pi-settings-DM7yYbel.js";
import { t as ensureContextEnginesInitialized } from "./init-DUBbUfXk.js";
import { t as runContextEngineMaintenance } from "./context-engine-maintenance-DemApsDL.js";
import { n as shouldPreemptivelyCompactBeforePrompt } from "./preemptive-compaction-CbXyRi1V.js";
import { n as recordCliCompactionInStore } from "./session-store-BD7mlJZx.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
//#region src/agents/command/cli-compaction.ts
const log = createSubsystemLogger("agents/cli-compaction");
const cliCompactionDeps = {
	openSessionManager: (sessionFile) => SessionManager.open(sessionFile),
	ensureContextEnginesInitialized,
	resolveContextEngine,
	createPreparedEmbeddedPiSettingsManager,
	applyPiAutoCompactionGuard,
	shouldPreemptivelyCompactBeforePrompt,
	resolveLiveToolResultMaxChars,
	runContextEngineMaintenance,
	recordCliCompactionInStore
};
function setCliCompactionTestDeps(overrides) {
	Object.assign(cliCompactionDeps, overrides);
}
function resetCliCompactionTestDeps() {
	Object.assign(cliCompactionDeps, {
		openSessionManager: (sessionFile) => SessionManager.open(sessionFile),
		ensureContextEnginesInitialized,
		resolveContextEngine,
		createPreparedEmbeddedPiSettingsManager,
		applyPiAutoCompactionGuard,
		shouldPreemptivelyCompactBeforePrompt,
		resolveLiveToolResultMaxChars,
		runContextEngineMaintenance,
		recordCliCompactionInStore
	});
}
function resolvePositiveInteger(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
	return Math.floor(value);
}
function getSessionBranchMessages(sessionManager) {
	return sessionManager.getBranch().flatMap((entry) => entry.type === "message" && typeof entry.message === "object" && entry.message !== null ? [entry.message] : []);
}
function resolveSessionTokenSnapshot(sessionEntry) {
	return resolvePositiveInteger(sessionEntry?.totalTokensFresh === false ? void 0 : sessionEntry?.totalTokens);
}
async function compactCliTranscript(params) {
	const runtimeContext = {
		...buildEmbeddedCompactionRuntimeContext({
			sessionKey: params.sessionKey,
			messageChannel: params.messageChannel,
			messageProvider: params.messageChannel,
			agentAccountId: params.agentAccountId,
			authProfileId: void 0,
			workspaceDir: params.workspaceDir,
			agentDir: params.agentDir,
			config: params.cfg,
			skillsSnapshot: params.skillsSnapshot,
			senderIsOwner: params.senderIsOwner,
			provider: params.provider,
			modelId: params.model,
			thinkLevel: params.thinkLevel,
			extraSystemPrompt: params.extraSystemPrompt
		}),
		currentTokenCount: params.currentTokenCount,
		tokenBudget: params.contextTokenBudget,
		trigger: "cli_budget"
	};
	const compactResult = await params.contextEngine.compact({
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionFile: params.sessionFile,
		tokenBudget: params.contextTokenBudget,
		currentTokenCount: params.currentTokenCount,
		force: true,
		compactionTarget: "budget",
		runtimeContext
	});
	if (!compactResult.compacted) {
		log.warn(`CLI transcript compaction did not reduce context for ${params.provider}/${params.model}: ${compactResult.reason ?? "nothing to compact"}`);
		return false;
	}
	await cliCompactionDeps.runContextEngineMaintenance({
		contextEngine: params.contextEngine,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionFile: params.sessionFile,
		reason: "compaction",
		sessionManager: params.sessionManager,
		runtimeContext,
		config: params.cfg
	});
	return true;
}
async function runCliTurnCompactionLifecycle(params) {
	const sessionFile = params.sessionEntry?.sessionFile;
	const contextTokenBudget = resolvePositiveInteger(params.sessionEntry?.contextTokens);
	if (!sessionFile || !contextTokenBudget) return params.sessionEntry;
	cliCompactionDeps.ensureContextEnginesInitialized();
	const contextEngine = await cliCompactionDeps.resolveContextEngine(params.cfg);
	const sessionManager = cliCompactionDeps.openSessionManager(sessionFile);
	const settingsManager = await cliCompactionDeps.createPreparedEmbeddedPiSettingsManager({
		cwd: params.workspaceDir,
		agentDir: params.agentDir,
		cfg: params.cfg,
		contextTokenBudget
	});
	await cliCompactionDeps.applyPiAutoCompactionGuard({
		settingsManager,
		contextEngineInfo: contextEngine.info,
		compactionMode: resolveEffectiveCompactionMode(params.cfg)
	});
	const preemptiveCompaction = cliCompactionDeps.shouldPreemptivelyCompactBeforePrompt({
		messages: getSessionBranchMessages(sessionManager),
		prompt: "",
		contextTokenBudget,
		reserveTokens: settingsManager.getCompactionReserveTokens(),
		toolResultMaxChars: cliCompactionDeps.resolveLiveToolResultMaxChars({
			contextWindowTokens: contextTokenBudget,
			cfg: params.cfg,
			agentId: params.sessionAgentId
		})
	});
	const tokenSnapshot = resolveSessionTokenSnapshot(params.sessionEntry);
	const currentTokenCount = Math.max(preemptiveCompaction.estimatedPromptTokens, tokenSnapshot ?? 0);
	if (!preemptiveCompaction.shouldCompact && currentTokenCount <= preemptiveCompaction.promptBudgetBeforeReserve) return params.sessionEntry;
	if (!await compactCliTranscript({
		contextEngine,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		sessionFile,
		sessionManager,
		cfg: params.cfg,
		workspaceDir: params.workspaceDir,
		agentDir: params.agentDir,
		provider: params.provider,
		model: params.model,
		contextTokenBudget,
		currentTokenCount,
		skillsSnapshot: params.skillsSnapshot,
		messageChannel: params.messageChannel,
		agentAccountId: params.agentAccountId,
		senderIsOwner: params.senderIsOwner,
		thinkLevel: params.thinkLevel,
		extraSystemPrompt: params.extraSystemPrompt
	}) || !params.sessionStore || !params.storePath) return params.sessionEntry;
	return await cliCompactionDeps.recordCliCompactionInStore({
		provider: params.provider,
		sessionKey: params.sessionKey,
		sessionStore: params.sessionStore,
		storePath: params.storePath
	}) ?? params.sessionEntry;
}
//#endregion
export { resetCliCompactionTestDeps, runCliTurnCompactionLifecycle, setCliCompactionTestDeps };
