import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { c as isRecord, p as resolveUserPath } from "./utils-sBTEdeml.js";
import "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { n as defaultSlotIdForKey } from "./slots-DT22cOei.js";
import { s as normalizePluginsConfig } from "./config-state-CjJBf8PG.js";
import { t as getProviderEnvVars } from "./provider-env-vars-HpAfBQBJ.js";
import { t as hasAnyAuthProfileStoreSource } from "./source-check-BMw3fGLx.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CZ-LXyVa.js";
import "./auth-profiles-D6NMnufG.js";
import { f as resolveUsableCustomProviderApiKey, u as resolveApiKeyForProvider } from "./model-auth-Db-JGIrg.js";
import { i as resolveActiveMemoryBackendConfig, r as getActiveMemorySearchManager } from "./memory-runtime-DxsWIMOy.js";
import { t as resolveMemorySearchConfig } from "./memory-search-BEQRq9yG.js";
import { t as note } from "./note-Dg2Luaaq.js";
import { c as repairShortTermPromotionArtifacts, n as auditDreamingArtifacts, r as auditShortTermPromotionArtifacts, s as repairDreamingArtifacts } from "./memory-core-engine-runtime-DTTJgvY1.js";
import { t as hasConfiguredMemorySecretInput } from "./secret-input-DJirly1z.js";
import { r as resolveQmdBinaryUnavailableReason, t as checkQmdBinaryAvailability } from "./engine-qmd-DGRjZTL_.js";
import "./legacy-config-record-shared-CpOX8vW0.js";
import { c as noteWorkspaceMemoryHealth, o as maybeRepairWorkspaceMemoryHealth } from "./doctor-workspace-Bx5P2l7e.js";
import fs from "node:fs";
//#endregion
//#region src/commands/doctor-memory-search.ts
const BUNDLED_MEMORY_EMBEDDING_PROVIDER_DOCTOR_METADATA = [
	{
		providerId: "github-copilot",
		authProviderId: "github-copilot",
		transport: "remote",
		autoSelectPriority: 15
	},
	{
		providerId: "openai",
		authProviderId: "openai",
		transport: "remote",
		autoSelectPriority: 20
	},
	{
		providerId: "gemini",
		authProviderId: "google",
		transport: "remote",
		autoSelectPriority: 30
	},
	{
		providerId: "voyage",
		authProviderId: "voyage",
		transport: "remote",
		autoSelectPriority: 40
	},
	{
		providerId: "mistral",
		authProviderId: "mistral",
		transport: "remote",
		autoSelectPriority: 50
	},
	{
		providerId: "bedrock",
		authProviderId: "amazon-bedrock",
		transport: "remote",
		autoSelectPriority: 60
	}
];
function resolveMemoryEmbeddingProviderDoctorMetadata(providerId) {
	const metadata = BUNDLED_MEMORY_EMBEDDING_PROVIDER_DOCTOR_METADATA.find((candidate) => candidate.providerId === providerId) ?? null;
	if (!metadata) return null;
	return {
		...metadata,
		envVars: getProviderEnvVars(metadata.authProviderId)
	};
}
function listAutoSelectMemoryEmbeddingProviderDoctorMetadata() {
	return BUNDLED_MEMORY_EMBEDDING_PROVIDER_DOCTOR_METADATA.filter((provider) => typeof provider.autoSelectPriority === "number").toSorted((a, b) => (a.autoSelectPriority ?? 0) - (b.autoSelectPriority ?? 0)).map((provider) => ({
		providerId: provider.providerId,
		authProviderId: provider.authProviderId,
		transport: provider.transport,
		autoSelectPriority: provider.autoSelectPriority,
		envVars: getProviderEnvVars(provider.authProviderId)
	}));
}
function resolveSuggestedRemoteMemoryProvider() {
	return listAutoSelectMemoryEmbeddingProviderDoctorMetadata().find((provider) => provider.transport === "remote")?.providerId;
}
function isKeyOptionalMemoryProvider(providerId) {
	return providerId === "local" || providerId === "ollama" || providerId === "lmstudio";
}
async function resolveRuntimeMemoryAuditContext(cfg) {
	const manager = (await getActiveMemorySearchManager({
		cfg,
		agentId: resolveDefaultAgentId(cfg),
		purpose: "status"
	})).manager;
	if (!manager) return null;
	try {
		const status = manager.status();
		const customQmd = isRecord(status.custom) && isRecord(status.custom.qmd) ? status.custom.qmd : null;
		return {
			workspaceDir: status.workspaceDir?.trim(),
			backend: status.backend,
			dbPath: status.dbPath,
			qmdCollections: typeof customQmd?.collections === "number" ? customQmd.collections : void 0
		};
	} finally {
		await manager.close?.().catch(() => void 0);
	}
}
function buildMemoryRecallIssueNote(audit) {
	if (audit.issues.length === 0) return null;
	const issueLines = audit.issues.map((issue) => `- ${issue.message}`);
	const guidance = audit.issues.some((issue) => issue.fixable) ? `Fix: ${formatCliCommand("openclaw doctor --fix")} or ${formatCliCommand("openclaw memory status --fix")}` : `Verify: ${formatCliCommand("openclaw memory status --deep")}`;
	return [
		"Memory recall artifacts need attention:",
		...issueLines,
		`Recall store: ${audit.storePath}`,
		guidance
	].join("\n");
}
function buildDreamingArtifactIssueNote(audit) {
	if (audit.issues.length === 0) return null;
	const issueLines = audit.issues.map((issue) => `- ${issue.message}`);
	const hasFixableIssue = audit.issues.some((issue) => issue.fixable);
	return [
		"Dreaming artifacts need attention:",
		...issueLines,
		`Dream corpus: ${audit.sessionCorpusDir}`,
		hasFixableIssue ? `Fix: ${formatCliCommand("openclaw doctor --fix")} or ${formatCliCommand("openclaw memory status --fix")}` : `Verify: ${formatCliCommand("openclaw memory status --deep")}`
	].join("\n");
}
async function noteMemoryRecallHealth(cfg) {
	try {
		const context = await resolveRuntimeMemoryAuditContext(cfg);
		const workspaceDir = context?.workspaceDir?.trim();
		if (!workspaceDir) return;
		const message = buildMemoryRecallIssueNote(await auditShortTermPromotionArtifacts({
			workspaceDir,
			qmd: context?.backend === "qmd" ? {
				dbPath: context.dbPath,
				collections: context.qmdCollections
			} : void 0
		}));
		if (message) note(message, "Memory search");
		const dreamingMessage = buildDreamingArtifactIssueNote(await auditDreamingArtifacts({ workspaceDir }));
		if (dreamingMessage) note(dreamingMessage, "Memory search");
	} catch (err) {
		note(`Memory recall audit could not be completed: ${formatErrorMessage(err)}`, "Memory search");
	}
}
async function maybeRepairMemoryRecallHealth(params) {
	await maybeRepairWorkspaceMemoryHealth(params);
	try {
		const context = await resolveRuntimeMemoryAuditContext(params.cfg);
		const workspaceDir = context?.workspaceDir?.trim();
		if (!workspaceDir) return;
		if ((await auditShortTermPromotionArtifacts({
			workspaceDir,
			qmd: context?.backend === "qmd" ? {
				dbPath: context.dbPath,
				collections: context.qmdCollections
			} : void 0
		})).issues.some((issue) => issue.fixable)) {
			if (await params.prompter.confirmRuntimeRepair({
				message: "Normalize memory recall artifacts and remove stale promotion locks?",
				initialValue: true
			})) {
				const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
				if (repair.changed) note([
					"Memory recall artifacts repaired:",
					repair.rewroteStore ? `- rewrote recall store${repair.removedInvalidEntries > 0 ? ` (-${repair.removedInvalidEntries} invalid entries)` : ""}` : null,
					repair.removedStaleLock ? "- removed stale promotion lock" : null,
					`Verify: ${formatCliCommand("openclaw memory status --deep")}`
				].filter(Boolean).join("\n"), "Doctor changes");
			}
		}
		if (!(await auditDreamingArtifacts({ workspaceDir })).issues.some((issue) => issue.fixable)) return;
		if (!await params.prompter.confirmRuntimeRepair({
			message: "Archive contaminated dreaming artifacts and reset derived dream corpus state?",
			initialValue: true
		})) return;
		const dreamingRepair = await repairDreamingArtifacts({ workspaceDir });
		if (!dreamingRepair.changed) return;
		note([
			"Dreaming artifacts repaired:",
			dreamingRepair.archivedSessionCorpus ? "- archived session corpus" : null,
			dreamingRepair.archivedSessionIngestion ? "- archived session-ingestion state" : null,
			dreamingRepair.archivedDreamsDiary ? "- archived dream diary" : null,
			dreamingRepair.archiveDir ? `- archive dir: ${dreamingRepair.archiveDir}` : null,
			...dreamingRepair.warnings.map((warning) => `- warning: ${warning}`),
			`Verify: ${formatCliCommand("openclaw memory status --deep")}`
		].filter(Boolean).join("\n"), "Doctor changes");
	} catch (err) {
		note(`Memory artifact repair could not be completed: ${formatErrorMessage(err)}`, "Memory search");
	}
}
function hasActiveAlternateMemoryPluginSlot(cfg) {
	const plugins = normalizePluginsConfig(cfg.plugins);
	if (!plugins.enabled) return false;
	const memorySlot = plugins.slots.memory;
	if (typeof memorySlot !== "string" || memorySlot.length === 0) return false;
	if (memorySlot === defaultSlotIdForKey("memory")) return false;
	if (plugins.deny.includes(memorySlot)) return false;
	if (!Object.prototype.hasOwnProperty.call(plugins.entries, memorySlot)) return false;
	const entry = plugins.entries[memorySlot];
	if (!entry || entry.enabled === false) return false;
	return entry.enabled === true || entry.config !== void 0;
}
/**
* Check whether memory search has a usable embedding provider.
* Runs as part of `openclaw doctor` — config-only checks where possible;
* may spawn a short-lived probe process when `memory.backend=qmd` to verify
* the configured `qmd` binary is available.
*/
async function noteMemorySearchHealth(cfg, opts) {
	await noteWorkspaceMemoryHealth(cfg);
	const agentId = resolveDefaultAgentId(cfg);
	const agentDir = resolveAgentDir(cfg, agentId);
	const resolved = resolveMemorySearchConfig(cfg, agentId);
	const hasRemoteApiKey = hasConfiguredMemorySecretInput(resolved?.remote?.apiKey);
	if (!resolved) {
		note("Memory search is explicitly disabled (enabled: false).", "Memory search");
		return;
	}
	const backendConfig = resolveActiveMemoryBackendConfig({
		cfg,
		agentId
	});
	if (!backendConfig) {
		if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) return;
		if (hasActiveAlternateMemoryPluginSlot(cfg)) return;
		note("No active memory plugin is registered for the current config.", "Memory search");
		return;
	}
	if (backendConfig.backend === "qmd") {
		const qmdCheck = await checkQmdBinaryAvailability({
			command: backendConfig.qmd?.command ?? "qmd",
			env: process.env,
			cwd: resolveAgentWorkspaceDir(cfg, agentId)
		});
		if (!qmdCheck.available) {
			const workspaceProbeFailed = resolveQmdBinaryUnavailableReason(qmdCheck) === "workspace-cwd";
			const probeError = qmdCheck.error.trim();
			note([
				workspaceProbeFailed ? "QMD memory backend is configured, but the agent workspace directory could not be used for the QMD startup probe." : `QMD memory backend is configured, but the qmd binary could not be started (${backendConfig.qmd?.command ?? "qmd"}).`,
				probeError ? `Probe error: ${probeError}` : null,
				"",
				"Fix (pick one):",
				workspaceProbeFailed ? "- Create the missing workspace directory or update the agent workspace path to an existing directory." : "- Install the supported QMD package: npm install -g @tobilu/qmd (or bun install -g @tobilu/qmd)",
				workspaceProbeFailed ? "- Verify the resolved workspace path for the affected agent before retrying." : `- Set an explicit binary path: ${formatCliCommand("openclaw config set memory.qmd.command /absolute/path/to/qmd")}`,
				`- Or switch back to builtin memory: ${formatCliCommand("openclaw config set memory.backend builtin")}`,
				"",
				`Verify: ${formatCliCommand("openclaw memory status --deep")}`
			].filter(Boolean).join("\n"), "Memory search");
		}
		return;
	}
	if (resolved.provider !== "auto") {
		if (resolved.provider === "local") {
			const suggestedRemoteProvider = resolveSuggestedRemoteMemoryProvider();
			if (hasLocalEmbeddings(resolved.local, true)) {
				if (opts?.gatewayMemoryProbe?.checked && !opts.gatewayMemoryProbe.ready) {
					const detail = opts.gatewayMemoryProbe.error?.trim();
					note([
						"Memory search provider is set to \"local\" and a model path is configured,",
						"but the gateway reports local embeddings are not ready.",
						detail ? `Gateway probe: ${detail}` : null,
						"",
						`Verify: ${formatCliCommand("openclaw memory status --deep")}`
					].filter(Boolean).join("\n"), "Memory search");
				}
				return;
			}
			note([
				"Memory search provider is set to \"local\" but no local model file was found.",
				"",
				"Fix (pick one):",
				`- Install node-llama-cpp and set a local model path in config`,
				suggestedRemoteProvider ? `- Switch to a remote provider: ${formatCliCommand(`openclaw config set agents.defaults.memorySearch.provider ${suggestedRemoteProvider}`)}` : `- Switch to a remote embedding provider in config`,
				"",
				`Verify: ${formatCliCommand("openclaw memory status --deep")}`
			].join("\n"), "Memory search");
			return;
		}
		if (isKeyOptionalMemoryProvider(resolved.provider)) {
			if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) return;
			if (opts?.gatewayMemoryProbe?.skipped) return;
			const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
			note([
				gatewayProbeWarning ? `Memory search provider "${resolved.provider}" is configured, but the gateway reports embeddings are not ready.` : `Memory search provider "${resolved.provider}" is configured, but the gateway could not confirm embeddings are ready.`,
				gatewayProbeWarning,
				`Verify: ${formatCliCommand("openclaw memory status --deep")}`
			].filter(Boolean).join("\n"), "Memory search");
			return;
		}
		if (hasRemoteApiKey || await hasApiKeyForProvider(resolved.provider, cfg, agentDir)) return;
		if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
			note([
				`Memory search provider is set to "${resolved.provider}" but the API key was not found in the CLI environment.`,
				"The running gateway reports memory embeddings are ready for the default agent.",
				`Verify: ${formatCliCommand("openclaw memory status --deep")}`
			].join("\n"), "Memory search");
			return;
		}
		const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
		const envVar = resolvePrimaryMemoryProviderEnvVar(resolved.provider);
		note([
			`Memory search provider is set to "${resolved.provider}" but no API key was found.`,
			`Semantic recall will not work without a valid API key.`,
			gatewayProbeWarning ? gatewayProbeWarning : null,
			"",
			"Fix (pick one):",
			`- Set ${envVar} in your environment`,
			`- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
			`- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
			"",
			`Verify: ${formatCliCommand("openclaw memory status --deep")}`
		].join("\n"), "Memory search");
		return;
	}
	if (hasLocalEmbeddings(resolved.local)) return;
	const autoSelectProviders = listAutoSelectMemoryEmbeddingProviderDoctorMetadata().filter((provider) => provider.transport === "remote");
	for (const provider of autoSelectProviders) if (hasRemoteApiKey || await hasApiKeyForProvider(provider.authProviderId, cfg, agentDir)) return;
	if (opts?.gatewayMemoryProbe?.checked && opts.gatewayMemoryProbe.ready) {
		note([
			"Memory search provider is set to \"auto\" but the API key was not found in the CLI environment.",
			"The running gateway reports memory embeddings are ready for the default agent.",
			`Verify: ${formatCliCommand("openclaw memory status --deep")}`
		].join("\n"), "Memory search");
		return;
	}
	const gatewayProbeWarning = buildGatewayProbeWarning(opts?.gatewayMemoryProbe);
	note([
		"Memory search is enabled, but no embedding provider is ready.",
		"Semantic recall needs at least one embedding provider.",
		gatewayProbeWarning ? gatewayProbeWarning : null,
		"",
		"Fix (pick one):",
		`- Set ${formatMemoryProviderEnvVarList(autoSelectProviders)} in your environment`,
		`- Configure credentials: ${formatCliCommand("openclaw configure --section model")}`,
		`- For local embeddings: configure agents.defaults.memorySearch.provider and local model path`,
		`- To disable: ${formatCliCommand("openclaw config set agents.defaults.memorySearch.enabled false")}`,
		"",
		`Verify: ${formatCliCommand("openclaw memory status --deep")}`
	].join("\n"), "Memory search");
}
/**
* Check whether local embeddings are available.
*
* When `useDefaultFallback` is true (explicit `provider: "local"`), an empty
* modelPath is treated as available because the runtime falls back to
* DEFAULT_LOCAL_MODEL (an auto-downloaded HuggingFace model).
*
* When false (provider: "auto"), we only consider local available if the user
* explicitly configured a local file path — matching `canAutoSelectLocal()`
* in the runtime, which skips local for empty/hf: model paths.
*/
function hasLocalEmbeddings(local, useDefaultFallback = false) {
	const modelPath = normalizeOptionalString(local.modelPath) || (useDefaultFallback ? "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf" : void 0);
	if (!modelPath) return false;
	if (/^(hf:|https?:)/i.test(modelPath)) return true;
	const resolved = resolveUserPath(modelPath);
	try {
		return fs.statSync(resolved).isFile();
	} catch {
		return false;
	}
}
async function hasApiKeyForProvider(provider, cfg, agentDir) {
	const authProviderId = resolveMemoryEmbeddingProviderDoctorMetadata(provider)?.authProviderId ?? provider;
	if (resolveEnvApiKey(authProviderId) || resolveUsableCustomProviderApiKey({
		cfg,
		provider: authProviderId
	})) return true;
	if (authProviderId !== "amazon-bedrock" && !hasAnyAuthProfileStoreSource(agentDir)) return false;
	try {
		await resolveApiKeyForProvider({
			provider: authProviderId,
			cfg,
			agentDir
		});
		return true;
	} catch {
		return false;
	}
}
function resolvePrimaryMemoryProviderEnvVar(provider) {
	return resolveMemoryEmbeddingProviderDoctorMetadata(provider)?.envVars[0] ?? `${provider.toUpperCase()}_API_KEY`;
}
function formatMemoryProviderEnvVarList(providers) {
	return [...new Set(providers.flatMap((provider) => provider.envVars).filter(Boolean))].join(", ");
}
function buildGatewayProbeWarning(probe) {
	if (!probe?.checked || probe.ready) return null;
	const detail = probe.error?.trim();
	return detail ? `Gateway memory probe for default agent is not ready: ${detail}` : "Gateway memory probe for default agent is not ready.";
}
//#endregion
export { maybeRepairMemoryRecallHealth, noteMemoryRecallHealth, noteMemorySearchHealth };
