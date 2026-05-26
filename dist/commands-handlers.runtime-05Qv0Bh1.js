import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, i as normalizeFastMode, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createLazyImportLoader } from "./lazy-promise-Djskx0qC.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { s as resolveArchiveKind } from "./archive-DBeZ8ywX.js";
import { p as resolveUserPath, r as clampInt } from "./utils-sBTEdeml.js";
import { r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { _ as resolveSessionAgentId, v as resolveSessionAgentIds } from "./agent-scope-CtLXGcWm.js";
import { r as normalizeOptionalAccountId } from "./account-id-B32J-iNN.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { n as parseGitPluginSpec, t as installPluginFromGitSpec } from "./git-install-NB3PSyj8.js";
import { t as loadInstalledPluginIndexInstallRecords } from "./installed-plugin-index-record-reader-BvE-GqxR.js";
import { t as parseClawHubPluginSpec } from "./clawhub-spec-J_MJr4Sl.js";
import { c as resolveOfficialExternalPluginInstall, n as getOfficialExternalPluginCatalogEntryForPackage, s as resolveOfficialExternalPluginId } from "./official-external-plugin-catalog-f6g4JsA2.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { M as resetConfigOverrides, N as setConfigOverride, P as unsetConfigOverride, T as validateConfigObjectWithPlugins, j as getConfigOverrides, u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import "./archive-CBe_wA_B.js";
import "./installed-plugin-index-records-BrXfmg6n.js";
import { _ as resolveResponseUsageMode, h as normalizeUsageDisplay, u as isSessionDefaultDirectiveValue } from "./thinking-DNSlsULp.js";
import { n as assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard-CW_6fgTB.js";
import { i as unsetConfigValueAtPath, n as parseConfigPath, r as setConfigValueAtPath, t as getConfigValueAtPath } from "./config-paths-C-HItaHN.js";
import { t as setPluginEnabledInConfig } from "./toggle-config-DID_OgqP.js";
import { t as parseDurationMs } from "./parse-duration-CD4d_yk2.js";
import { o as transformConfigFileWithRetry } from "./mutate-DLC8bveh.js";
import "./config-B6Oplu5W.js";
import { n as isRestartEnabled, t as isCommandFlagEnabled } from "./commands.flags-CeKA8V9z.js";
import { o as normalizeChannelId } from "./registry-CtWyD2pE.js";
import { r as isInternalMessageChannel, u as normalizeMessageChannel } from "./message-channel-CYCKkVrh.js";
import { f as scheduleGatewaySigusr1Restart, h as triggerOpenClawRestart } from "./restart-C-r_0sSG.js";
import { a as listOpenAIAuthProfileProvidersForAgentRuntime, c as resolveContextConfigProviderForRuntime } from "./openai-codex-routing-DwRY-_VI.js";
import { t as resolveAgentHarnessPolicy } from "./policy-BwWh-R0D.js";
import { t as getActivePluginChannelRegistry } from "./runtime-DHxRl5F1.js";
import { m as triggerInternalHook, n as createInternalHookEvent } from "./internal-hooks-DpfQDjis.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, r as resolveDefaultSessionStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import { a as normalizeChannelId$1, i as listChannelPlugins, n as getLoadedChannelPlugin, t as getChannelPlugin } from "./registry-Bf5TpUad.js";
import { u as updateSessionStore } from "./store-BmtchQvp.js";
import { n as resolveChannelApprovalCapability, t as resolveChannelApprovalAdapter } from "./plugins-DYTHbmt7.js";
import { o as resolveFreshSessionTotalTokens } from "./types-BgvyBC-3.js";
import { u as extractDeliveryInfo } from "./sessions-CQHHcgC_.js";
import { r as readLatestAssistantTextFromSessionTranscript } from "./transcript-BA0Ngd-A.js";
import { b as prepareProviderRuntimeAuth } from "./provider-runtime-D8jQEgmu.js";
import { n as ensureOpenClawModelsJson } from "./models-config-DNlTw_QX.js";
import { n as requireApiKey } from "./model-auth-runtime-shared-cdTr1v5l.js";
import { a as isNativeCommandTurn, s as resolveCommandTurnContext } from "./command-turn-context-BiMylvBj.js";
import { n as stripInboundMetadata } from "./strip-inbound-meta-D2-__BeH.js";
import { n as formatTaskStatusDetail, r as formatTaskStatusTitle, t as buildTaskStatusSnapshot } from "./task-status-BvwcU8qI.js";
import { f as replyRunRegistry } from "./reply-run-registry-CwZ9EftF.js";
import "./diagnostic-DEgTYLXt.js";
import { t as diagnosticLogger } from "./diagnostic-runtime-fqnhjrAV.js";
import { a as getActiveEmbeddedRunSnapshot, d as queueEmbeddedPiMessageWithOutcomeAsync, i as formatEmbeddedPiQueueFailureSummary, o as isEmbeddedPiRunActive, p as resolveActiveEmbeddedRunSessionId } from "./runs-DrbsiywK.js";
import { r as isSilentReplyPayloadText } from "./tokens-CFv3Qu_v.js";
import { n as estimateTokensFromChars } from "./cjk-chars-BtjJDifS.js";
import { o as resolveContextTokensForModel } from "./context-L0xQd5wI.js";
import { n as formatTokenCount, r as formatUsd } from "./usage-format-BEywPhmZ.js";
import { d as writeRestartSentinel, r as formatDoctorNonInteractiveHint, s as removeRestartSentinelFile, t as buildRestartSuccessContinuation } from "./restart-sentinel-BDtpdKoy.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { n as resolveSandboxRuntimeStatus } from "./runtime-status-BtoDvmSR.js";
import { i as selectAgentHarness, n as resolveAvailableAgentHarnessPolicy } from "./selection-hR-AeOeU.js";
import { t as formatDurationCompact } from "./format-duration-BrZ-AaEJ.js";
import { o as getFinishedSession, s as getSession } from "./bash-process-registry-DU_0t2zf.js";
import { t as analyzeBootstrapBudget } from "./bootstrap-budget-WP_UMPQC.js";
import { _ as resolveBootstrapMaxChars, y as resolveBootstrapTotalMaxChars } from "./pi-embedded-helpers-bmljPI1n.js";
import { i as resolveImageSanitizationLimits, n as sanitizeImageBlocks } from "./tool-images-Cv3ZnK02.js";
import { i as getApiKeyForModel } from "./model-auth-Db-JGIrg.js";
import { T as stripToolResultDetails } from "./openai-transport-stream-Pgx5hpN7.js";
import { t as EmbeddedBlockChunker } from "./pi-embedded-block-chunker-BQzqF871.js";
import { a as readChannelAllowFromStore, l as removeChannelAllowFromStoreEntry, t as addChannelAllowFromStoreEntry } from "./pairing-store-jPMfFWFn.js";
import { c as resolveMainSessionAlias, s as resolveInternalSessionKey } from "./sessions-helpers-AhiZZPDz.js";
import { a as clearSessionQueues } from "./queue-DskPlua9.js";
import { i as resolveReplyToMode } from "./reply-threading-Bgku_ISs.js";
import { n as routeReply } from "./route-reply-xAts-3Gi.js";
import { _ as authorizeConfigWriteShared, b as resolveConfigWriteTargetFromPathShared, v as canBypassConfigWritePolicyShared, y as formatConfigWriteDeniedMessageShared } from "./channel-config-helpers-xZ4-bv2H.js";
import { i as discoverModels, r as discoverAuthStorage } from "./pi-model-discovery-LbwIS40h.js";
import { C as setTtsMaxLength, S as setTtsEnabled, T as setTtsProvider, _ as resolveTtsPrefsPath, a as getTtsPersona, b as setSummarizationEnabled, c as isTtsEnabled, d as listTtsPersonas, g as resolveTtsConfig, i as getTtsMaxLength, k as textToSpeech, l as isTtsProviderConfigured, n as getLastTtsAttempt, o as getTtsProvider, r as getResolvedSpeechProviderConfig, s as isSummarizationEnabled, w as setTtsPersona, y as setLastTtsAttempt } from "./tts-runtime-B3-lBCQj.js";
import "./tts-Bd-K2Dd6.js";
import { t as registerProviderStreamForModel } from "./provider-stream-qFQv-LxD.js";
import "./sandbox-DiI74XYF.js";
import { t as buildSystemPromptReport } from "./system-prompt-report-OWmAgzTa.js";
import { i as streamWithPayloadPatch } from "./moonshot-thinking-stream-wrappers-D3FMTw1i.js";
import { r as matchPluginCommand, t as executePluginCommand } from "./commands-knen7QS8.js";
import { i as listSpeechProviders, n as getSpeechProvider, t as canonicalizeSpeechProviderId } from "./provider-registry-mISFpr4F.js";
import { i as resolveTextCommand, r as normalizeCommandBody } from "./commands-registry-normalize-CnHNsvCE.js";
import "./commands-registry-Bthd8JBl.js";
import { r as resolveModelWithRegistry } from "./model-cgt_Zkgh.js";
import { n as buildThreadingToolContext } from "./agent-runner-utils-Ues7rde4.js";
import { r as resolveConversationBindingContextFromAcpCommand } from "./conversation-binding-input-CG40gdHa.js";
import { o as stripMentions, s as stripStructuralPrefixes } from "./mentions-DmNrCnsQ.js";
import { i as setAbortMemory, r as isAbortTrigger } from "./abort-primitives-BPrDmF9O.js";
import { a as shouldPersistAbortCutoff, i as resolveAbortCutoffFromContext, t as applyAbortCutoffToSessionEntry } from "./abort-cutoff-cRHrB_Kx.js";
import { i as stopSubagentsForRequester, n as formatAbortReplyText, r as resolveSessionEntryForKey, t as abortSessionRunTarget } from "./abort-DgYZvSe-.js";
import { t as isApprovalNotFoundError } from "./approval-errors-s6AXlG1x.js";
import { n as formatTimeAgo } from "./format-relative-Bjc3l98W.js";
import { n as setChannelConversationBindingMaxAgeBySessionKey, t as setChannelConversationBindingIdleTimeoutBySessionKey } from "./conversation-bindings-ByEqopTS.js";
import { t as handleCrestodianCommand } from "./commands-crestodian-CwkDPsTy.js";
import { n as isImplicitSameChatApprovalAuthorization } from "./approval-auth-helpers-dxinAe5Y.js";
import { t as resolveApprovalOverGateway } from "./approval-gateway-resolver-BLIao43o.js";
import { n as parseActivationCommand } from "./group-activation-BxkIP-sT.js";
import { t as resolveFastModeState } from "./fast-mode-Dkm9UASH.js";
import { n as resolveSessionAuthProfileOverride } from "./session-override-C2UmI-DC.js";
import { t as extractExplicitGroupId } from "./group-id-BCOqsbKq.js";
import { t as formatElevatedUnavailableMessage } from "./elevated-unavailable-CESCLCLG.js";
import { t as resolveRuntimePolicySessionKey } from "./runtime-policy-session-key-BBFWw42v.js";
import { t as resolveEffectiveToolInventory } from "./tools-effective-inventory-DvFk0LI9.js";
import { t as extractBtwQuestion } from "./btw-command-cHadZPW0.js";
import { t as formatThreadBindingDurationLabel } from "./thread-bindings-messages-D73K8IGt.js";
import { a as requireGatewayClientScope, i as requireCommandFlagEnabled, n as rejectNonOwnerCommand, r as rejectUnauthorizedCommand, t as buildDisabledCommandReply } from "./command-gates-DbPt0txV.js";
import { t as handleAcpCommand } from "./commands-acp-Dcp1k18y.js";
import { n as buildCommandsMessagePaginated, r as buildHelpMessage, t as buildCommandsMessage } from "./command-status-builders-DIS2PKOq.js";
import { t as listSkillCommandsForAgents } from "./skill-commands-dLqoqLxl.js";
import { r as handleModelsCommand } from "./commands-models-C5hB5Z12.js";
import { r as createExecTool } from "./bash-tools-BDAkR9bh.js";
import { n as listTasksForAgentIdForStatus, r as listTasksForSessionKeyForStatus } from "./task-status-access-C4wDBrvB.js";
import { d as resolveChannelAccountId, f as resolveCommandSurfaceChannel, l as resolveSubagentsAction, o as resolveHandledPrefix, s as resolveRequesterSessionKey, u as stopWithText } from "./shared-DJehim_x.js";
import { t as buildToolsMessage } from "./status-CnBvVkWG.js";
import { i as parseConfigValue, n as setConfiguredMcpServer, r as unsetConfiguredMcpServer, t as listConfiguredMcpServers } from "./mcp-config-BDsyH-NL.js";
import { t as resolveCommandsSystemPromptBundle } from "./commands-system-prompt-DapLyGtl.js";
import "./command-export-VNYzc1XT.js";
import { t as buildStatusReply } from "./commands-status-DXkk1v-c.js";
import { n as persistPluginInstall, r as buildNpmInstallRecordFields } from "./plugins-install-persist-VD_D5Xyc.js";
import { a as installPluginFromNpmSpec, o as installPluginFromPath } from "./install-BG7jqqYt.js";
import { a as resolveOfficialExternalNpmPackageTrust } from "./plugin-install-plan-DDY2BScO.js";
import { a as buildPluginDiagnosticsReport, l as formatPluginCompatibilityNotice, o as buildPluginInspectReport, s as buildPluginRegistrySnapshotReport, t as buildAllPluginInspectReports } from "./status-BvY0BMpM.js";
import { d as resolveFileNpmSpecToLocalPath, r as createPluginInstallLogger } from "./plugins-command-helpers-BUsheNmo.js";
import { t as refreshPluginRegistryAfterConfigMutation } from "./plugins-registry-refresh-OLbBO5Xj.js";
import "./clawhub-B9rdLaiz.js";
import { r as installPluginFromClawHub } from "./clawhub-CFGNynZy.js";
import { i as loadSessionCostSummary, n as loadCostUsageSummary } from "./session-cost-usage-Dn79gKT8.js";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import fs$1, { readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import { buildSessionContext, migrateSessionEntries, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai";
import zlib from "node:zlib";
//#region src/auto-reply/reply/config-mutations.ts
var AutoReplyConfigMutationError = class extends Error {};
var AutoReplyConfigNoopMutation = class extends Error {};
function formatAutoReplyConfigMutationError(error) {
	return error instanceof AutoReplyConfigMutationError ? error.message : null;
}
function assertValidConfig(next, action) {
	const validated = validateConfigObjectWithPlugins(next);
	if (!validated.ok) {
		const issue = validated.issues[0];
		throw new AutoReplyConfigMutationError(`Config invalid after ${action} (${issue.path}: ${issue.message}).`);
	}
	return { config: validated.config };
}
async function unsetConfigPath(path) {
	try {
		await transformConfigFileWithRetry({
			base: "source",
			afterWrite: { mode: "auto" },
			transform: (currentConfig) => {
				const next = structuredClone(currentConfig);
				if (!unsetConfigValueAtPath(next, path)) throw new AutoReplyConfigNoopMutation();
				return { nextConfig: assertValidConfig(next, "unset").config };
			}
		});
		return true;
	} catch (error) {
		if (error instanceof AutoReplyConfigNoopMutation) return false;
		throw error;
	}
}
async function setConfigPath(path, value) {
	await transformConfigFileWithRetry({
		base: "source",
		afterWrite: { mode: "auto" },
		transform: (currentConfig) => {
			const next = structuredClone(currentConfig);
			setConfigValueAtPath(next, path, value);
			return { nextConfig: assertValidConfig(next, "set").config };
		}
	});
}
async function setPluginEnabledFromCommand(params) {
	return (await transformConfigFileWithRetry({
		afterWrite: { mode: "auto" },
		transform: (currentConfig) => {
			return { nextConfig: assertValidConfig(setPluginEnabledInConfig(structuredClone(currentConfig), params.pluginId, params.enabled), `/plugins ${params.action}`).config };
		}
	})).nextConfig;
}
async function applyAllowlistConfigMutation(params) {
	await transformConfigFileWithRetry({
		base: "source",
		afterWrite: { mode: "auto" },
		transform: async (currentConfig) => {
			const latestParsedConfig = structuredClone(currentConfig);
			const latestEditResult = await params.applyConfigEdit({
				cfg: currentConfig,
				parsedConfig: latestParsedConfig,
				accountId: params.accountId,
				scope: params.scope,
				action: params.action,
				entry: params.entry
			});
			if (!latestEditResult || latestEditResult.kind === "invalid-entry") throw new AutoReplyConfigMutationError("Invalid allowlist entry.");
			if (!latestEditResult.changed) return { nextConfig: currentConfig };
			return { nextConfig: assertValidConfig(latestParsedConfig, "update").config };
		}
	});
}
//#endregion
//#region src/channels/plugins/config-writes.ts
function isInternalConfigWriteMessageChannel(channel) {
	return normalizeLowercaseStringOrEmpty(channel) === "webchat";
}
function authorizeConfigWrite(params) {
	return authorizeConfigWriteShared(params);
}
function resolveConfigWriteTargetFromPath(path) {
	return resolveConfigWriteTargetFromPathShared({
		path,
		normalizeChannelId: (raw) => normalizeLowercaseStringOrEmpty(raw)
	});
}
function canBypassConfigWritePolicy(params) {
	return canBypassConfigWritePolicyShared({
		...params,
		isInternalMessageChannel: isInternalConfigWriteMessageChannel
	});
}
function formatConfigWriteDeniedMessage(params) {
	return formatConfigWriteDeniedMessageShared(params);
}
//#endregion
//#region src/auto-reply/reply/config-write-authorization.ts
function resolveConfigWriteDeniedText(params) {
	const writeAuth = authorizeConfigWrite({
		cfg: params.cfg,
		origin: {
			channelId: params.channelId,
			accountId: params.accountId
		},
		target: params.target,
		allowBypass: canBypassConfigWritePolicy({
			channel: params.channel ?? "",
			gatewayClientScopes: params.gatewayClientScopes
		})
	});
	if (writeAuth.allowed) return null;
	return formatConfigWriteDeniedMessage({
		result: writeAuth,
		fallbackChannelId: params.channelId
	});
}
//#endregion
//#region src/auto-reply/reply/commands-allowlist.ts
const ACTIONS = new Set([
	"list",
	"add",
	"remove"
]);
const SCOPES = new Set([
	"dm",
	"group",
	"all"
]);
function resolveAllowlistAccountId(params) {
	const explicitAccountId = normalizeOptionalAccountId(params.parsedAccount);
	if (explicitAccountId) return explicitAccountId;
	const configuredDefaultAccountId = normalizeOptionalString(getChannelPlugin(params.channelId)?.config.defaultAccountId?.(params.cfg));
	const ctxAccountId = normalizeOptionalAccountId(params.ctxAccountId);
	return configuredDefaultAccountId || ctxAccountId || "default";
}
function parseAllowlistCommand(raw) {
	const trimmed = raw.trim();
	if (!(normalizeOptionalLowercaseString(trimmed) ?? "").startsWith("/allowlist")) return null;
	const rest = trimmed.slice(10).trim();
	if (!rest) return {
		action: "list",
		scope: "dm"
	};
	const tokens = rest.split(/\s+/);
	let action = "list";
	let scope = "dm";
	let resolve = false;
	let target = "both";
	let channel;
	let account;
	const entryTokens = [];
	let i = 0;
	const firstAction = normalizeOptionalLowercaseString(tokens[i]);
	if (firstAction && ACTIONS.has(firstAction)) {
		action = firstAction;
		i += 1;
	}
	const firstScope = normalizeOptionalLowercaseString(tokens[i]);
	if (firstScope && SCOPES.has(firstScope)) {
		scope = firstScope;
		i += 1;
	}
	for (; i < tokens.length; i += 1) {
		const token = tokens[i];
		const lowered = normalizeOptionalLowercaseString(token) ?? "";
		if (lowered === "--resolve" || lowered === "resolve") {
			resolve = true;
			continue;
		}
		if (lowered === "--config" || lowered === "config") {
			target = "config";
			continue;
		}
		if (lowered === "--store" || lowered === "store") {
			target = "store";
			continue;
		}
		if (lowered === "--channel" && tokens[i + 1]) {
			channel = tokens[i + 1];
			i += 1;
			continue;
		}
		if (lowered === "--account" && tokens[i + 1]) {
			account = tokens[i + 1];
			i += 1;
			continue;
		}
		const kv = token.split("=");
		if (kv.length === 2) {
			const key = normalizeOptionalLowercaseString(kv[0]);
			const value = normalizeOptionalString(kv[1]);
			if (key === "channel") {
				if (value) channel = value;
				continue;
			}
			if (key === "account") {
				if (value) account = value;
				continue;
			}
			const normalizedValue = normalizeOptionalLowercaseString(value);
			if (key === "scope" && normalizedValue && SCOPES.has(normalizedValue)) {
				scope = normalizedValue;
				continue;
			}
		}
		entryTokens.push(token);
	}
	if (action === "add" || action === "remove") {
		const entry = entryTokens.join(" ").trim();
		if (!entry) return {
			action: "error",
			message: "Usage: /allowlist add|remove <entry>"
		};
		return {
			action,
			scope,
			entry,
			channel,
			account,
			resolve,
			target
		};
	}
	return {
		action: "list",
		scope,
		channel,
		account,
		resolve
	};
}
function normalizeAllowFrom(params) {
	const plugin = getChannelPlugin(params.channelId);
	if (plugin?.config.formatAllowFrom) return plugin.config.formatAllowFrom({
		cfg: params.cfg,
		accountId: params.accountId,
		allowFrom: params.values
	});
	return normalizeStringEntries(params.values);
}
function formatEntryList(entries, resolved) {
	if (entries.length === 0) return "(none)";
	return entries.map((entry) => {
		const name = resolved?.get(entry);
		return name ? `${entry} (${name})` : entry;
	}).join(", ");
}
async function updatePairingStoreAllowlist(params) {
	const storeEntry = {
		channel: params.channelId,
		entry: params.entry,
		accountId: params.accountId
	};
	if (params.action === "add") {
		await addChannelAllowFromStoreEntry(storeEntry);
		return;
	}
	await removeChannelAllowFromStoreEntry(storeEntry);
	if (params.accountId === "default") await removeChannelAllowFromStoreEntry({
		channel: params.channelId,
		entry: params.entry
	});
}
function mapResolvedAllowlistNames(entries) {
	const map = /* @__PURE__ */ new Map();
	for (const entry of entries) if (entry.resolved && entry.name) map.set(entry.input, entry.name);
	return map;
}
async function resolveAllowlistNames(params) {
	return mapResolvedAllowlistNames(await getChannelPlugin(params.channelId)?.allowlist?.resolveNames?.({
		cfg: params.cfg,
		accountId: params.accountId,
		scope: params.scope,
		entries: params.entries
	}) ?? []);
}
async function readAllowlistConfig(params) {
	return await getChannelPlugin(params.channelId)?.allowlist?.readConfig?.({
		cfg: params.cfg,
		accountId: params.accountId
	}) ?? {};
}
const handleAllowlistCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
	if (!parsed) return null;
	if (parsed.action === "error") return {
		shouldContinue: false,
		reply: { text: `⚠️ ${parsed.message}` }
	};
	const unauthorized = rejectUnauthorizedCommand(params, "/allowlist");
	if (unauthorized) return unauthorized;
	if (parsed.action !== "list") {
		const nonOwner = rejectNonOwnerCommand(params, "/allowlist");
		if (nonOwner) return nonOwner;
	}
	const channelId = normalizeChannelId(parsed.channel) ?? params.command.channelId ?? normalizeChannelId(params.command.channel);
	if (!channelId) return {
		shouldContinue: false,
		reply: { text: "⚠️ Unknown channel. Add channel=<id> to the command." }
	};
	if (normalizeOptionalString(parsed.account) && !normalizeOptionalAccountId(parsed.account)) return {
		shouldContinue: false,
		reply: { text: "⚠️ Invalid account id. Reserved keys (__proto__, constructor, prototype) are blocked." }
	};
	const accountId = resolveAllowlistAccountId({
		cfg: params.cfg,
		channelId,
		parsedAccount: parsed.account,
		ctxAccountId: params.ctx.AccountId
	});
	const plugin = getChannelPlugin(channelId);
	if (parsed.action === "list") {
		const supportsStore = Boolean(plugin?.pairing);
		if (!plugin?.allowlist?.readConfig && !supportsStore) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${channelId} does not expose allowlist configuration.` }
		};
		const storeAllowFrom = supportsStore ? await readChannelAllowFromStore(channelId, process.env, accountId).catch(() => []) : [];
		const configState = await readAllowlistConfig({
			cfg: params.cfg,
			channelId,
			accountId
		});
		const dmAllowFrom = (configState.dmAllowFrom ?? []).map(String);
		const groupAllowFrom = (configState.groupAllowFrom ?? []).map(String);
		const groupOverrides = (configState.groupOverrides ?? []).map((entry) => ({
			label: entry.label,
			entries: entry.entries.map(String).filter(Boolean)
		}));
		const dmDisplay = normalizeAllowFrom({
			cfg: params.cfg,
			channelId,
			accountId,
			values: dmAllowFrom
		});
		const groupDisplay = normalizeAllowFrom({
			cfg: params.cfg,
			channelId,
			accountId,
			values: groupAllowFrom
		});
		const groupOverrideEntries = groupOverrides.flatMap((entry) => entry.entries);
		const groupOverrideDisplay = normalizeAllowFrom({
			cfg: params.cfg,
			channelId,
			accountId,
			values: groupOverrideEntries
		});
		const resolvedDm = parsed.resolve && dmDisplay.length > 0 ? await resolveAllowlistNames({
			cfg: params.cfg,
			channelId,
			accountId,
			scope: "dm",
			entries: dmDisplay
		}) : void 0;
		const resolvedGroup = parsed.resolve && groupOverrideDisplay.length > 0 ? await resolveAllowlistNames({
			cfg: params.cfg,
			channelId,
			accountId,
			scope: "group",
			entries: groupOverrideDisplay
		}) : void 0;
		const lines = ["🧾 Allowlist"];
		lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);
		if (configState.dmPolicy) lines.push(`DM policy: ${configState.dmPolicy}`);
		if (configState.groupPolicy) lines.push(`Group policy: ${configState.groupPolicy}`);
		const showDm = parsed.scope === "dm" || parsed.scope === "all";
		const showGroup = parsed.scope === "group" || parsed.scope === "all";
		if (showDm) lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay, resolvedDm)}`);
		if (supportsStore && storeAllowFrom.length > 0) {
			const storeLabel = normalizeAllowFrom({
				cfg: params.cfg,
				channelId,
				accountId,
				values: storeAllowFrom
			});
			lines.push(`Paired allowFrom (store): ${formatEntryList(storeLabel)}`);
		}
		if (showGroup) {
			if (groupAllowFrom.length > 0) lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay, resolvedGroup)}`);
			if (groupOverrides.length > 0) {
				lines.push("Group overrides:");
				for (const entry of groupOverrides) {
					const normalized = normalizeAllowFrom({
						cfg: params.cfg,
						channelId,
						accountId,
						values: entry.entries
					});
					lines.push(`- ${entry.label}: ${formatEntryList(normalized, resolvedGroup)}`);
				}
			}
		}
		return {
			shouldContinue: false,
			reply: { text: lines.join("\n") }
		};
	}
	const missingAdminScope = requireGatewayClientScope(params, {
		label: "/allowlist write",
		allowedScopes: ["operator.admin"],
		missingText: "❌ /allowlist add|remove requires operator.admin for gateway clients."
	});
	if (missingAdminScope) return missingAdminScope;
	const disabled = requireCommandFlagEnabled(params.cfg, {
		label: "/allowlist edits",
		configKey: "config",
		disabledVerb: "are"
	});
	if (disabled) return disabled;
	const shouldUpdateConfig = parsed.target !== "store";
	const shouldTouchStore = parsed.target !== "config" && Boolean(plugin?.pairing);
	if (shouldUpdateConfig) {
		if (parsed.scope === "all") return {
			shouldContinue: false,
			reply: { text: "⚠️ /allowlist add|remove requires scope dm or group." }
		};
		if (!plugin?.allowlist?.applyConfigEdit) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.` }
		};
		const applyConfigEdit = plugin.allowlist.applyConfigEdit;
		const editScope = parsed.scope;
		const snapshot = await readConfigFileSnapshot();
		if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") return {
			shouldContinue: false,
			reply: { text: "⚠️ Config file is invalid; fix it before using /allowlist." }
		};
		const parsedConfig = structuredClone(snapshot.parsed);
		const editResult = await plugin.allowlist.applyConfigEdit({
			cfg: params.cfg,
			parsedConfig,
			accountId,
			scope: parsed.scope,
			action: parsed.action,
			entry: parsed.entry
		});
		if (!editResult) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.` }
		};
		if (editResult.kind === "invalid-entry") return {
			shouldContinue: false,
			reply: { text: "⚠️ Invalid allowlist entry." }
		};
		const deniedText = resolveConfigWriteDeniedText({
			cfg: params.cfg,
			channel: params.command.channel,
			channelId,
			accountId,
			gatewayClientScopes: params.ctx.GatewayClientScopes,
			target: editResult.writeTarget
		});
		if (deniedText) return {
			shouldContinue: false,
			reply: { text: deniedText }
		};
		const configChanged = editResult.changed;
		if (configChanged) try {
			await applyAllowlistConfigMutation({
				cfg: params.cfg,
				accountId,
				scope: editScope,
				action: parsed.action,
				entry: parsed.entry,
				applyConfigEdit
			});
		} catch (error) {
			if (error instanceof AutoReplyConfigMutationError) return {
				shouldContinue: false,
				reply: { text: `⚠️ ${error.message}` }
			};
			throw error;
		}
		if (!configChanged && !shouldTouchStore) return {
			shouldContinue: false,
			reply: { text: parsed.action === "add" ? "✅ Already allowlisted." : "⚠️ Entry not found." }
		};
		if (shouldTouchStore) await updatePairingStoreAllowlist({
			action: parsed.action,
			channelId,
			accountId,
			entry: parsed.entry
		});
		const actionLabel = parsed.action === "add" ? "added" : "removed";
		const scopeLabel = parsed.scope === "dm" ? "DM" : "group";
		const locations = [];
		if (configChanged) locations.push(editResult.pathLabel);
		if (shouldTouchStore) locations.push("pairing store");
		return {
			shouldContinue: false,
			reply: { text: `✅ ${scopeLabel} allowlist ${actionLabel}: ${locations.length > 0 ? locations.join(" + ") : "no-op"}.` }
		};
	}
	if (!shouldTouchStore) return {
		shouldContinue: false,
		reply: { text: "⚠️ This channel does not support allowlist storage." }
	};
	await updatePairingStoreAllowlist({
		action: parsed.action,
		channelId,
		accountId,
		entry: parsed.entry
	});
	const actionLabel = parsed.action === "add" ? "added" : "removed";
	return {
		shouldContinue: false,
		reply: { text: `✅ ${parsed.scope === "dm" ? "DM" : "group"} allowlist ${actionLabel} in pairing store.` }
	};
};
//#endregion
//#region src/infra/channel-approval-auth.ts
function resolveApprovalCommandAuthorization(params) {
	const channel = normalizeMessageChannel(params.channel);
	if (!channel) return {
		authorized: true,
		explicit: false
	};
	const approvalCapability = resolveChannelApprovalCapability(getChannelPlugin(channel));
	const resolved = approvalCapability?.authorizeActorAction?.({
		cfg: params.cfg,
		accountId: params.accountId,
		senderId: params.senderId,
		action: "approve",
		approvalKind: params.kind
	});
	if (!resolved) return {
		authorized: true,
		explicit: false
	};
	const implicitSameChatAuthorization = isImplicitSameChatApprovalAuthorization(resolved);
	const availability = approvalCapability?.getActionAvailabilityState?.({
		cfg: params.cfg,
		accountId: params.accountId,
		action: "approve",
		approvalKind: params.kind
	});
	return {
		authorized: resolved.authorized,
		reason: resolved.reason,
		explicit: resolved.authorized ? !implicitSameChatAuthorization && availability?.kind !== "disabled" : true
	};
}
//#endregion
//#region src/auto-reply/reply/commands-approve.ts
const COMMAND_REGEX = /^\/?approve(?:\s|$)/i;
const FOREIGN_COMMAND_MENTION_REGEX = /^\/approve@([^\s]+)(?:\s|$)/i;
const DECISION_ALIASES = {
	allow: "allow-once",
	once: "allow-once",
	"allow-once": "allow-once",
	allowonce: "allow-once",
	always: "allow-always",
	"allow-always": "allow-always",
	allowalways: "allow-always",
	deny: "deny",
	reject: "deny",
	block: "deny"
};
const APPROVE_USAGE_TEXT = "Usage: /approve <id> <decision> (see the pending approval message for available decisions)";
function parseApproveCommand(raw) {
	const trimmed = raw.trim();
	if (FOREIGN_COMMAND_MENTION_REGEX.test(trimmed)) return {
		ok: false,
		error: "❌ This /approve command targets a different Telegram bot."
	};
	const commandMatch = trimmed.match(COMMAND_REGEX);
	if (!commandMatch) return null;
	const rest = trimmed.slice(commandMatch[0].length).trim();
	if (!rest) return {
		ok: false,
		error: APPROVE_USAGE_TEXT
	};
	const tokens = rest.split(/\s+/).filter(Boolean);
	if (tokens.length < 2) return {
		ok: false,
		error: APPROVE_USAGE_TEXT
	};
	const first = normalizeLowercaseStringOrEmpty(tokens[0]);
	const second = normalizeLowercaseStringOrEmpty(tokens[1]);
	if (DECISION_ALIASES[first]) return {
		ok: true,
		decision: DECISION_ALIASES[first],
		id: tokens.slice(1).join(" ").trim()
	};
	if (DECISION_ALIASES[second]) return {
		ok: true,
		decision: DECISION_ALIASES[second],
		id: tokens[0]
	};
	return {
		ok: false,
		error: APPROVE_USAGE_TEXT
	};
}
function buildResolvedByLabel(params) {
	return `${params.command.channel}:${params.command.senderId ?? "unknown"}`;
}
function formatApprovalSubmitError(error) {
	return formatErrorMessage(error);
}
function resolveApprovalMethods(params) {
	if (params.approvalId.startsWith("plugin:")) return params.pluginAuthorization.authorized ? ["plugin.approval.resolve"] : [];
	if (params.execAuthorization.authorized && params.pluginAuthorization.authorized) return ["exec.approval.resolve", "plugin.approval.resolve"];
	if (params.execAuthorization.authorized) return ["exec.approval.resolve"];
	if (params.pluginAuthorization.authorized) return ["plugin.approval.resolve"];
	return [];
}
function resolveApprovalAuthorizationError(params) {
	if (params.approvalId.startsWith("plugin:")) return params.pluginAuthorization.reason ?? "❌ You are not authorized to approve this request.";
	return params.execAuthorization.reason ?? params.pluginAuthorization.reason ?? "❌ You are not authorized to approve this request.";
}
const handleApproveCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	const parsed = parseApproveCommand(normalized);
	if (!parsed) return null;
	if (!parsed.ok) return {
		shouldContinue: false,
		reply: { text: parsed.error }
	};
	const isPluginId = parsed.id.startsWith("plugin:");
	const effectiveAccountId = resolveChannelAccountId({
		cfg: params.cfg,
		ctx: params.ctx,
		command: params.command
	});
	const approveCommandBehavior = resolveChannelApprovalCapability(getChannelPlugin(params.command.channel))?.resolveApproveCommandBehavior?.({
		cfg: params.cfg,
		accountId: effectiveAccountId,
		senderId: params.command.senderId,
		approvalKind: isPluginId ? "plugin" : "exec"
	});
	if (approveCommandBehavior?.kind === "ignore") return { shouldContinue: false };
	if (approveCommandBehavior?.kind === "reply") return {
		shouldContinue: false,
		reply: { text: approveCommandBehavior.text }
	};
	const execApprovalAuthorization = resolveApprovalCommandAuthorization({
		cfg: params.cfg,
		channel: params.command.channel,
		accountId: effectiveAccountId,
		senderId: params.command.senderId,
		kind: "exec"
	});
	const pluginApprovalAuthorization = resolveApprovalCommandAuthorization({
		cfg: params.cfg,
		channel: params.command.channel,
		accountId: effectiveAccountId,
		senderId: params.command.senderId,
		kind: "plugin"
	});
	const hasExplicitApprovalAuthorization = execApprovalAuthorization.explicit && execApprovalAuthorization.authorized || pluginApprovalAuthorization.explicit && pluginApprovalAuthorization.authorized;
	if (!params.command.isAuthorizedSender && !hasExplicitApprovalAuthorization) {
		logVerbose(`Ignoring /approve from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const missingScope = requireGatewayClientScope(params, {
		label: "/approve",
		allowedScopes: ["operator.approvals", "operator.admin"],
		missingText: "❌ /approve requires operator.approvals for gateway clients."
	});
	if (missingScope) return missingScope;
	const resolvedBy = buildResolvedByLabel(params);
	const callApprovalMethod = async (method) => {
		await resolveApprovalOverGateway({
			cfg: params.cfg,
			approvalId: parsed.id,
			decision: parsed.decision,
			senderId: params.command.senderId,
			...method === "plugin.approval.resolve" ? { resolveMethod: "plugin" } : {},
			clientDisplayName: `Chat approval (${resolvedBy})`
		});
	};
	const methods = resolveApprovalMethods({
		approvalId: parsed.id,
		execAuthorization: execApprovalAuthorization,
		pluginAuthorization: pluginApprovalAuthorization
	});
	if (methods.length === 0) return {
		shouldContinue: false,
		reply: { text: resolveApprovalAuthorizationError({
			approvalId: parsed.id,
			execAuthorization: execApprovalAuthorization,
			pluginAuthorization: pluginApprovalAuthorization
		}) }
	};
	for (const [index, method] of methods.entries()) try {
		await callApprovalMethod(method);
		break;
	} catch (error) {
		const isLastMethod = index === methods.length - 1;
		if (!isApprovalNotFoundError(error) || isLastMethod) return {
			shouldContinue: false,
			reply: { text: `❌ Failed to submit approval: ${formatApprovalSubmitError(error)}` }
		};
	}
	return {
		shouldContinue: false,
		reply: { text: `✅ Approval ${parsed.decision} submitted for ${parsed.id}.` }
	};
};
//#endregion
//#region src/auto-reply/reply/bash-command.ts
const CHAT_BASH_SCOPE_KEY = "chat:bash";
const DEFAULT_FOREGROUND_MS = 2e3;
const MAX_FOREGROUND_MS = 3e4;
let activeJob = null;
function resolveForegroundMs(cfg) {
	const raw = cfg.commands?.bashForegroundMs;
	if (typeof raw !== "number" || Number.isNaN(raw)) return DEFAULT_FOREGROUND_MS;
	return clampInt(raw, 0, MAX_FOREGROUND_MS);
}
function formatSessionSnippet(sessionId) {
	const trimmed = sessionId.trim();
	if (trimmed.length <= 12) return trimmed;
	return `${trimmed.slice(0, 8)}…`;
}
function formatOutputBlock(text) {
	const trimmed = text.trim();
	if (!trimmed) return "(no output)";
	return `\`\`\`txt\n${trimmed}\n\`\`\``;
}
function parseBashRequest(raw) {
	const trimmed = raw.trimStart();
	let restSource = "";
	if (normalizeLowercaseStringOrEmpty(trimmed).startsWith("/bash")) {
		const match = trimmed.match(/^\/bash(?:\s*:\s*|\s+|$)([\s\S]*)$/i);
		if (!match) return null;
		restSource = match[1] ?? "";
	} else if (trimmed.startsWith("!")) {
		restSource = trimmed.slice(1);
		if (restSource.trimStart().startsWith(":")) restSource = restSource.trimStart().slice(1);
	} else return null;
	const rest = restSource.trimStart();
	if (!rest) return { action: "help" };
	const tokenMatch = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
	const token = normalizeOptionalString(tokenMatch?.[1]) ?? "";
	const remainder = normalizeOptionalString(tokenMatch?.[2]) ?? "";
	const lowered = normalizeLowercaseStringOrEmpty(token);
	if (lowered === "poll") return {
		action: "poll",
		sessionId: remainder || void 0
	};
	if (lowered === "stop") return {
		action: "stop",
		sessionId: remainder || void 0
	};
	if (lowered === "help") return { action: "help" };
	return {
		action: "run",
		command: rest
	};
}
function resolveRawCommandBody(params) {
	const stripped = stripStructuralPrefixes(params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body ?? "");
	return params.isGroup ? stripMentions(stripped, params.ctx, params.cfg, params.agentId) : stripped;
}
function getScopedSession(sessionId) {
	const running = getSession(sessionId);
	if (running && running.scopeKey === CHAT_BASH_SCOPE_KEY) return { running };
	const finished = getFinishedSession(sessionId);
	if (finished && finished.scopeKey === CHAT_BASH_SCOPE_KEY) return { finished };
	return {};
}
function ensureActiveJobState() {
	if (!activeJob) return null;
	if (activeJob.state === "starting") return activeJob;
	const { running, finished } = getScopedSession(activeJob.sessionId);
	if (running) return activeJob;
	if (finished) {
		activeJob = null;
		return null;
	}
	activeJob = null;
	return null;
}
function attachActiveWatcher(sessionId) {
	if (!activeJob || activeJob.state !== "running") return;
	if (activeJob.sessionId !== sessionId) return;
	if (activeJob.watcherAttached) return;
	const { running } = getScopedSession(sessionId);
	const child = running?.child;
	if (!child) return;
	activeJob.watcherAttached = true;
	child.once("close", () => {
		if (activeJob?.state === "running" && activeJob.sessionId === sessionId) activeJob = null;
	});
}
function buildUsageReply() {
	return { text: [
		"⚙️ Usage:",
		"- ! <command>",
		"- !poll | ! poll",
		"- !stop | ! stop",
		"- /bash ... (alias; same subcommands as !)"
	].join("\n") };
}
async function handleBashChatCommand(params) {
	if (!isCommandFlagEnabled(params.cfg, "bash")) return buildDisabledCommandReply({
		label: "bash",
		configKey: "bash",
		docsUrl: "https://docs.openclaw.ai/tools/slash-commands#config"
	});
	const agentId = params.agentId ?? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	if (!params.elevated.enabled || !params.elevated.allowed) {
		const runtimeSandboxed = resolveSandboxRuntimeStatus({
			cfg: params.cfg,
			sessionKey: resolveRuntimePolicySessionKey({
				cfg: params.cfg,
				ctx: params.ctx,
				sessionKey: params.sessionKey
			})
		}).sandboxed;
		return { text: formatElevatedUnavailableMessage({
			runtimeSandboxed,
			failures: params.elevated.failures,
			sessionKey: params.sessionKey
		}) };
	}
	const request = parseBashRequest(resolveRawCommandBody({
		ctx: params.ctx,
		cfg: params.cfg,
		agentId,
		isGroup: params.isGroup
	}).trim());
	if (!request) return { text: "⚠️ Unrecognized bash request." };
	const liveJob = ensureActiveJobState();
	if (request.action === "help") return buildUsageReply();
	if (request.action === "poll") {
		const sessionId = normalizeOptionalString(request.sessionId) || (liveJob?.state === "running" ? liveJob.sessionId : "");
		if (!sessionId) return { text: "⚙️ No active bash job." };
		const { running, finished } = getScopedSession(sessionId);
		if (running) {
			attachActiveWatcher(sessionId);
			const runtimeSec = Math.max(0, Math.floor((Date.now() - running.startedAt) / 1e3));
			const tail = running.tail || "(no output yet)";
			return { text: [
				`⚙️ bash still running (session ${formatSessionSnippet(sessionId)}, ${runtimeSec}s).`,
				formatOutputBlock(tail),
				"Hint: !stop (or /bash stop)"
			].join("\n") };
		}
		if (finished) {
			if (activeJob?.state === "running" && activeJob.sessionId === sessionId) activeJob = null;
			const exitLabel = finished.exitSignal ? `signal ${String(finished.exitSignal)}` : `code ${String(finished.exitCode ?? 0)}`;
			return { text: [
				`${finished.status === "completed" ? "⚙️" : "⚠️"} bash finished (session ${formatSessionSnippet(sessionId)}).`,
				`Exit: ${exitLabel}`,
				formatOutputBlock(finished.aggregated || finished.tail)
			].join("\n") };
		}
		if (activeJob?.state === "running" && activeJob.sessionId === sessionId) activeJob = null;
		return { text: `⚙️ No bash session found for ${formatSessionSnippet(sessionId)}.` };
	}
	if (request.action === "stop") {
		const sessionId = normalizeOptionalString(request.sessionId) || (liveJob?.state === "running" ? liveJob.sessionId : "");
		if (!sessionId) return { text: "⚙️ No active bash job." };
		const { running } = getScopedSession(sessionId);
		if (!running) {
			if (activeJob?.state === "running" && activeJob.sessionId === sessionId) activeJob = null;
			return { text: `⚙️ No running bash job found for ${formatSessionSnippet(sessionId)}.` };
		}
		if (!running.backgrounded) return { text: `⚠️ Session ${formatSessionSnippet(sessionId)} is not backgrounded.` };
		const pid = running.pid ?? running.child?.pid;
		if (!pid) return { text: `⚠️ Unable to stop bash session ${formatSessionSnippet(sessionId)} because no process ID is available. Use !poll ${sessionId} to check whether it exits on its own.` };
		const { killProcessTree } = await import("./kill-tree-C6QPKFFm.js");
		killProcessTree(pid);
		return { text: `⚙️ bash stopping (session ${formatSessionSnippet(sessionId)}). Use !poll ${sessionId} to confirm exit.` };
	}
	if (liveJob) return { text: `⚠️ A bash job is already running (${liveJob.state === "running" ? formatSessionSnippet(liveJob.sessionId) : "starting"}). Use !poll / !stop (or /bash poll / /bash stop).` };
	const commandText = request.command.trim();
	if (!commandText) return buildUsageReply();
	activeJob = {
		state: "starting",
		startedAt: Date.now(),
		command: commandText
	};
	try {
		const foregroundMs = resolveForegroundMs(params.cfg);
		const shouldBackgroundImmediately = foregroundMs <= 0;
		const timeoutSec = params.cfg.tools?.exec?.timeoutSec;
		const notifyOnExit = params.cfg.tools?.exec?.notifyOnExit;
		const notifyOnExitEmptySuccess = params.cfg.tools?.exec?.notifyOnExitEmptySuccess;
		const result = await createExecTool({
			scopeKey: CHAT_BASH_SCOPE_KEY,
			allowBackground: true,
			timeoutSec,
			sessionKey: params.sessionKey,
			mainKey: params.cfg.session?.mainKey,
			sessionScope: params.cfg.session?.scope,
			notifyOnExit,
			notifyOnExitEmptySuccess,
			elevated: {
				enabled: params.elevated.enabled,
				allowed: params.elevated.allowed,
				defaultLevel: "on"
			}
		}).execute("chat-bash", {
			command: commandText,
			background: shouldBackgroundImmediately,
			yieldMs: shouldBackgroundImmediately ? void 0 : foregroundMs,
			timeout: timeoutSec,
			elevated: true
		});
		if (result.details?.status === "running") {
			const sessionId = result.details.sessionId;
			activeJob = {
				state: "running",
				sessionId,
				startedAt: result.details.startedAt,
				command: commandText,
				watcherAttached: false
			};
			attachActiveWatcher(sessionId);
			logVerbose(`Started bash session ${formatSessionSnippet(sessionId)}: ${commandText}`);
			return { text: `⚙️ bash started (session ${sessionId}). Still running; use !poll / !stop (or /bash poll / /bash stop).` };
		}
		activeJob = null;
		const exitCode = result.details?.status === "completed" ? result.details.exitCode : 0;
		const output = result.details?.status === "completed" ? result.details.aggregated : result.content.map((chunk) => chunk.type === "text" ? chunk.text : "").join("\n");
		return { text: [
			`⚙️ bash: ${commandText}`,
			`Exit: ${exitCode}`,
			formatOutputBlock(output || "(no output)")
		].join("\n") };
	} catch (err) {
		activeJob = null;
		const message = formatErrorMessage(err);
		return { text: [`⚠️ bash failed: ${commandText}`, formatOutputBlock(message)].join("\n") };
	}
}
//#endregion
//#region src/auto-reply/reply/commands-bash.ts
const handleBashCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const { command } = params;
	const bashSlashRequested = command.commandBodyNormalized === "/bash" || command.commandBodyNormalized.startsWith("/bash ");
	const bashBangRequested = command.commandBodyNormalized.startsWith("!");
	if (!bashSlashRequested && !(bashBangRequested && command.isAuthorizedSender)) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/bash");
	if (unauthorized) return unauthorized;
	const agentId = params.sessionKey ? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	}) : params.agentId;
	return {
		shouldContinue: false,
		reply: await handleBashChatCommand({
			ctx: params.ctx,
			cfg: params.cfg,
			agentId,
			sessionKey: params.sessionKey,
			isGroup: params.isGroup,
			elevated: params.elevated
		})
	};
};
//#endregion
//#region src/agents/btw-transcript.ts
function resolveBtwSessionTranscriptPath(params) {
	try {
		const agentId = params.sessionKey?.split(":")[1];
		const pathOpts = resolveSessionFilePathOptions({
			agentId,
			storePath: params.storePath
		});
		return resolveSessionFilePath(params.sessionId, params.sessionEntry, pathOpts);
	} catch (error) {
		diagnosticLogger.debug(`resolveSessionTranscriptPath failed: sessionId=${params.sessionId} err=${String(error)}`);
		return;
	}
}
function readSessionEntryId(entry) {
	const id = entry.id;
	return typeof id === "string" && id.trim().length > 0 ? id : void 0;
}
function readSessionEntryParentId(entry) {
	const parentId = entry.parentId;
	if (parentId === null) return null;
	return typeof parentId === "string" && parentId.trim().length > 0 ? parentId : void 0;
}
function hasParentLinkedEntries(entries) {
	return entries.some((entry) => Boolean(readSessionEntryId(entry) && "parentId" in entry));
}
function buildSessionBranchEntries(entries, leafId) {
	if (!leafId) return;
	const byId = /* @__PURE__ */ new Map();
	for (const entry of entries) {
		const id = readSessionEntryId(entry);
		if (id) byId.set(id, entry);
	}
	const branch = [];
	const seen = /* @__PURE__ */ new Set();
	let currentId = leafId;
	while (currentId) {
		if (seen.has(currentId)) return;
		seen.add(currentId);
		const entry = byId.get(currentId);
		if (!entry) return;
		branch.push(entry);
		currentId = readSessionEntryParentId(entry) ?? void 0;
	}
	return branch.toReversed();
}
function readDefaultLeafId(entries) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const id = readSessionEntryId(entries[index]);
		if (id) return id;
	}
}
function isTrailingUserMessage(entry) {
	return entry?.type === "message" && entry.message?.role === "user";
}
async function readBtwTranscriptMessages(params) {
	try {
		const entries = parseSessionEntries(await readFile(params.sessionFile, "utf-8"));
		migrateSessionEntries(entries);
		const sessionEntries = entries.filter((entry) => entry.type !== "session");
		if (!hasParentLinkedEntries(sessionEntries)) return buildSessionContext(sessionEntries).messages;
		let branchEntries = params.snapshotLeafId ? buildSessionBranchEntries(sessionEntries, params.snapshotLeafId) : void 0;
		if (params.snapshotLeafId && !branchEntries) diagnosticLogger.debug(`btw snapshot leaf unavailable: sessionId=${params.sessionId} leaf=${params.snapshotLeafId}`);
		branchEntries ??= buildSessionBranchEntries(sessionEntries, readDefaultLeafId(sessionEntries));
		if (!params.snapshotLeafId && isTrailingUserMessage(branchEntries?.at(-1))) {
			const parentId = readSessionEntryParentId(branchEntries.at(-1));
			branchEntries = parentId ? buildSessionBranchEntries(sessionEntries, parentId) ?? [] : [];
		}
		const sessionContext = buildSessionContext(branchEntries ?? sessionEntries);
		return Array.isArray(sessionContext.messages) ? sessionContext.messages : [];
	} catch {
		return [];
	}
}
//#endregion
//#region src/agents/btw.ts
function collectTextContent(content) {
	return content.filter((part) => part.type === "text").map((part) => part.text).join("");
}
function collectThinkingContent(content) {
	return content.filter((part) => part.type === "thinking").map((part) => part.thinking).join("");
}
function buildBtwSystemPrompt() {
	return [
		"You are answering an ephemeral /btw side question about the current conversation.",
		"Use the conversation only as background context.",
		"Answer only the side question in the last user message.",
		"Do not continue, resume, or complete any unfinished task from the conversation.",
		"Do not emit tool calls, pseudo-tool calls, shell commands, file writes, patches, or code unless the side question explicitly asks for them.",
		"Do not say you will continue the main task after answering.",
		"If the question can be answered briefly, answer briefly."
	].join("\n");
}
function buildBtwQuestionPrompt(question, inFlightPrompt) {
	const lines = ["Answer this side question only.", "Ignore any unfinished task in the conversation while answering it."];
	const trimmedPrompt = inFlightPrompt?.trim();
	if (trimmedPrompt) lines.push("", "Current in-flight main task request for background context only:", "<in_flight_main_task>", trimmedPrompt, "</in_flight_main_task>", "Do not continue or complete that task while answering the side question.");
	lines.push("", "<btw_side_question>", question.trim(), "</btw_side_question>");
	return lines.join("\n");
}
function normalizeBtwContentBlocks(content) {
	if (Array.isArray(content)) return content;
	if (content && typeof content === "object") return [content];
}
function isBtwTextBlock(block) {
	if (!block || typeof block !== "object") return false;
	const record = block;
	return normalizeLowercaseStringOrEmpty(record.type) === "text" && typeof record.text === "string";
}
function isBtwImageBlock(block) {
	if (!block || typeof block !== "object") return false;
	const record = block;
	return normalizeLowercaseStringOrEmpty(record.type) === "image" && typeof record.data === "string" && typeof record.mimeType === "string";
}
async function sanitizeBtwUserMessage(params) {
	if (typeof params.message.content === "string") return params.message;
	const blocks = normalizeBtwContentBlocks(params.message.content);
	if (!blocks) return;
	const content = [];
	for (const block of blocks) {
		if (isBtwTextBlock(block)) {
			content.push({
				type: "text",
				text: block.text
			});
			continue;
		}
		if (!isBtwImageBlock(block)) continue;
		const { images } = await sanitizeImageBlocks([block], "btw:context", params.imageLimits);
		const image = images[0];
		if (image) content.push(image);
	}
	if (content.length === 0) return;
	return {
		...params.message,
		content
	};
}
function sanitizeBtwAssistantMessage(message) {
	const rawContent = message.content;
	if (typeof rawContent === "string") {
		const trimmed = rawContent.trim();
		return trimmed.length > 0 ? {
			...message,
			content: [{
				type: "text",
				text: trimmed
			}]
		} : void 0;
	}
	const blocks = normalizeBtwContentBlocks(rawContent);
	if (!blocks) return;
	const content = blocks.flatMap((block) => isBtwTextBlock(block) ? [{
		type: "text",
		text: block.text
	}] : []);
	if (content.length === 0) return;
	return {
		...message,
		content
	};
}
async function toSimpleContextMessages(params) {
	const contextMessages = [];
	for (const message of params.messages) {
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		if (role === "user") {
			const sanitizedMessage = await sanitizeBtwUserMessage({
				message,
				imageLimits: params.imageLimits
			});
			if (sanitizedMessage) contextMessages.push(sanitizedMessage);
			continue;
		}
		if (role !== "assistant") continue;
		const sanitizedMessage = sanitizeBtwAssistantMessage(message);
		if (sanitizedMessage) contextMessages.push(sanitizedMessage);
	}
	return stripToolResultDetails(contextMessages);
}
async function resolveRuntimeModel(params) {
	const modelsOptions = params.workspaceDir ? { workspaceDir: params.workspaceDir } : void 0;
	await ensureOpenClawModelsJson(params.cfg, params.agentDir, modelsOptions);
	const modelRegistry = discoverModels(discoverAuthStorage(params.agentDir), params.agentDir);
	const model = resolveModelWithRegistry({
		provider: params.provider,
		modelId: params.model,
		modelRegistry,
		cfg: params.cfg
	});
	if (!model) throw new Error(`Unknown model: ${params.provider}/${params.model}`);
	return {
		model,
		authProfileId: await resolveSessionAuthProfileOverride({
			cfg: params.cfg,
			provider: params.provider,
			acceptedProviderIds: listOpenAIAuthProfileProvidersForAgentRuntime({
				provider: params.provider,
				harnessRuntime: resolveAvailableAgentHarnessPolicy({
					provider: params.provider,
					modelId: params.model,
					config: params.cfg,
					agentId: params.agentId,
					sessionKey: params.sessionKey
				}).runtime,
				config: params.cfg
			}),
			agentDir: params.agentDir,
			sessionEntry: params.sessionEntry,
			sessionStore: params.sessionStore,
			sessionKey: params.sessionKey,
			storePath: params.storePath,
			isNewSession: params.isNewSession
		}),
		authProfileIdSource: params.sessionEntry?.authProfileOverrideSource
	};
}
async function runBtwSideQuestion(params) {
	const sessionId = params.sessionEntry.sessionId?.trim();
	if (!sessionId) throw new Error("No active session context.");
	const sessionFile = resolveBtwSessionTranscriptPath({
		sessionId,
		sessionEntry: params.sessionEntry,
		sessionKey: params.sessionKey,
		storePath: params.storePath
	});
	if (!sessionFile) throw new Error("No active session transcript.");
	const sessionAgentId = resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, sessionAgentId);
	const harness = selectAgentHarness({
		provider: params.provider,
		modelId: params.model,
		config: params.cfg,
		agentId: sessionAgentId,
		sessionKey: params.sessionKey
	});
	if (harness.runSideQuestion) {
		const { model, authProfileId, authProfileIdSource } = await resolveRuntimeModel({
			cfg: params.cfg,
			provider: params.provider,
			model: params.model,
			agentId: sessionAgentId,
			agentDir: params.agentDir,
			workspaceDir,
			sessionEntry: params.sessionEntry,
			sessionStore: params.sessionStore,
			sessionKey: params.sessionKey,
			storePath: params.storePath,
			isNewSession: params.isNewSession
		});
		return { text: (await harness.runSideQuestion({
			...params,
			provider: model.provider,
			model: model.id,
			runtimeModel: model,
			sessionId,
			sessionFile,
			agentId: sessionAgentId,
			workspaceDir,
			authProfileId,
			authProfileIdSource
		})).text };
	}
	if (harness.id === "codex") throw new Error(`Selected agent harness "${harness.id}" does not support /btw side questions.`);
	const activeRunSnapshot = getActiveEmbeddedRunSnapshot(sessionId);
	const imageLimits = resolveImageSanitizationLimits(params.cfg);
	let messages = [];
	let inFlightPrompt;
	if (Array.isArray(activeRunSnapshot?.messages) && activeRunSnapshot.messages.length > 0) {
		messages = await toSimpleContextMessages({
			messages: activeRunSnapshot.messages,
			imageLimits
		});
		inFlightPrompt = activeRunSnapshot.inFlightPrompt;
	} else if (activeRunSnapshot) inFlightPrompt = activeRunSnapshot.inFlightPrompt;
	if (messages.length === 0) messages = await toSimpleContextMessages({
		messages: await readBtwTranscriptMessages({
			sessionFile,
			sessionId,
			snapshotLeafId: activeRunSnapshot?.transcriptLeafId
		}),
		imageLimits
	});
	if (messages.length === 0 && !inFlightPrompt?.trim()) throw new Error("No active session context.");
	const { model, authProfileId } = await resolveRuntimeModel({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		agentId: sessionAgentId,
		agentDir: params.agentDir,
		workspaceDir,
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		isNewSession: params.isNewSession
	});
	const apiKeyInfo = await getApiKeyForModel({
		model,
		cfg: params.cfg,
		profileId: authProfileId,
		agentDir: params.agentDir
	});
	let runtimeModel = model;
	let apiKey = apiKeyInfo.mode === "aws-sdk" && !apiKeyInfo.apiKey ? void 0 : requireApiKey(apiKeyInfo, model.provider);
	if (apiKey) {
		const preparedAuth = await prepareProviderRuntimeAuth({
			provider: model.provider,
			config: params.cfg,
			workspaceDir,
			env: process.env,
			context: {
				config: params.cfg,
				agentDir: params.agentDir,
				workspaceDir,
				env: process.env,
				provider: model.provider,
				modelId: model.id,
				model,
				apiKey,
				authMode: apiKeyInfo.mode,
				profileId: authProfileId
			}
		});
		if (preparedAuth?.baseUrl) runtimeModel = {
			...runtimeModel,
			baseUrl: preparedAuth.baseUrl
		};
		if (preparedAuth?.apiKey) apiKey = preparedAuth.apiKey;
	}
	const providerStreamFn = registerProviderStreamForModel({
		model: runtimeModel,
		cfg: params.cfg,
		agentDir: params.agentDir,
		workspaceDir,
		env: process.env
	});
	const chunker = params.opts?.onBlockReply && params.blockReplyChunking ? new EmbeddedBlockChunker(params.blockReplyChunking) : void 0;
	let emittedBlocks = 0;
	let blockEmitChain = Promise.resolve();
	let answerText = "";
	let reasoningText = "";
	let assistantStarted = false;
	let sawTextEvent = false;
	const emitBlockChunk = async (text) => {
		if (!text.trim() || !params.opts?.onBlockReply) return;
		emittedBlocks += 1;
		blockEmitChain = blockEmitChain.then(async () => {
			await params.opts?.onBlockReply?.({
				text,
				btw: { question: params.question }
			});
		});
		await blockEmitChain;
	};
	const stream = await streamWithPayloadPatch(providerStreamFn ?? streamSimple, runtimeModel, {
		systemPrompt: buildBtwSystemPrompt(),
		messages: [...messages, {
			role: "user",
			content: [{
				type: "text",
				text: buildBtwQuestionPrompt(params.question, inFlightPrompt)
			}],
			timestamp: Date.now()
		}]
	}, {
		apiKey,
		reasoning: void 0,
		signal: params.opts?.abortSignal
	}, (payloadObj) => {
		if (Array.isArray(payloadObj.tools) && payloadObj.tools.length === 0) delete payloadObj.tools;
	});
	let finalEvent;
	for await (const event of stream) {
		finalEvent = event.type === "done" || event.type === "error" ? event : finalEvent;
		if (!assistantStarted && (event.type === "text_start" || event.type === "start")) {
			assistantStarted = true;
			await params.opts?.onAssistantMessageStart?.();
		}
		if (event.type === "text_delta") {
			sawTextEvent = true;
			answerText += event.delta;
			chunker?.append(event.delta);
			if (chunker && params.resolvedBlockStreamingBreak === "text_end") chunker.drain({
				force: false,
				emit: (chunk) => void emitBlockChunk(chunk)
			});
			continue;
		}
		if (event.type === "text_end" && chunker && params.resolvedBlockStreamingBreak === "text_end") {
			chunker.drain({
				force: true,
				emit: (chunk) => void emitBlockChunk(chunk)
			});
			continue;
		}
		if (event.type === "thinking_delta") {
			reasoningText += event.delta;
			if (params.resolvedReasoningLevel !== "off") await params.opts?.onReasoningStream?.({
				text: reasoningText,
				isReasoning: true
			});
			continue;
		}
		if (event.type === "thinking_end" && params.resolvedReasoningLevel !== "off") await params.opts?.onReasoningEnd?.();
	}
	if (chunker && params.resolvedBlockStreamingBreak !== "text_end" && chunker.hasBuffered()) chunker.drain({
		force: true,
		emit: (chunk) => void emitBlockChunk(chunk)
	});
	await blockEmitChain;
	if (finalEvent?.type === "error") {
		const message = collectTextContent(finalEvent.error.content);
		throw new Error(message || finalEvent.error.errorMessage || "BTW failed.");
	}
	const finalMessage = finalEvent?.type === "done" ? finalEvent.message : void 0;
	if (finalMessage) {
		if (!sawTextEvent) answerText = collectTextContent(finalMessage.content);
		if (!reasoningText) reasoningText = collectThinkingContent(finalMessage.content);
	}
	const answer = answerText.trim();
	if (!answer) throw new Error("No BTW response generated.");
	if (emittedBlocks > 0) return;
	return { text: answer };
}
//#endregion
//#region src/auto-reply/reply/commands-btw.ts
const BTW_USAGE = "Usage: /btw [side question]";
const handleBtwCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const question = extractBtwQuestion(params.command.commandBodyNormalized);
	if (question === null) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/btw");
	if (unauthorized) return unauthorized;
	if (!question) return {
		shouldContinue: false,
		reply: { text: BTW_USAGE }
	};
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	if (!targetSessionEntry?.sessionId) return {
		shouldContinue: false,
		reply: { text: "⚠️ /btw requires an active session with existing context." }
	};
	const sessionAgentId = params.sessionKey ? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	}) : params.agentId;
	const agentDir = (sessionAgentId ? resolveAgentDir(params.cfg, sessionAgentId) : void 0) ?? params.agentDir;
	if (!agentDir) return {
		shouldContinue: false,
		reply: { text: "⚠️ /btw is unavailable because the active agent directory could not be resolved." }
	};
	try {
		await params.typing?.startTypingLoop();
		const currentChannelId = params.ctx.OriginatingTo?.trim() || params.command.to || params.command.channelId;
		const reply = await runBtwSideQuestion({
			cfg: params.cfg,
			agentDir,
			provider: params.provider,
			model: params.model,
			question,
			sessionEntry: targetSessionEntry,
			sessionStore: params.sessionStore,
			sessionKey: params.sessionKey,
			storePath: params.storePath,
			resolvedThinkLevel: "off",
			resolvedReasoningLevel: "off",
			blockReplyChunking: params.blockReplyChunking,
			resolvedBlockStreamingBreak: params.resolvedBlockStreamingBreak,
			opts: params.opts,
			isNewSession: false,
			...params.command.channel ? { messageChannel: params.command.channel } : {},
			...params.command.channel ? { messageProvider: params.command.channel } : {},
			...currentChannelId ? { currentChannelId } : {}
		});
		return {
			shouldContinue: false,
			reply: reply ? {
				...reply,
				btw: { question }
			} : reply
		};
	} catch (error) {
		const message = error instanceof Error ? error.message.trim() : "";
		return {
			shouldContinue: false,
			reply: {
				text: `⚠️ /btw failed${message ? `: ${message}` : "."}`,
				btw: { question },
				isError: true
			}
		};
	}
};
//#endregion
//#region src/auto-reply/reply/commands-compact.ts
const compactRuntimeLoader = createLazyImportLoader(() => import("./commands-compact.runtime.js"));
function loadCompactRuntime() {
	return compactRuntimeLoader.load();
}
function extractCompactInstructions(params) {
	const raw = stripStructuralPrefixes(params.rawBody ?? "");
	const trimmed = (params.isGroup ? stripMentions(raw, params.ctx, params.cfg, params.agentId) : raw).trim();
	if (!trimmed) return;
	const prefix = normalizeLowercaseStringOrEmpty(trimmed).startsWith("/compact") ? "/compact" : null;
	if (!prefix) return;
	let rest = trimmed.slice(prefix.length).trimStart();
	if (rest.startsWith(":")) rest = rest.slice(1).trimStart();
	return rest.length ? rest : void 0;
}
function isCompactionSkipReason(reason) {
	const text = normalizeOptionalLowercaseString(reason) ?? "";
	return text.includes("nothing to compact") || text.includes("below threshold") || text.includes("already compacted") || text.includes("no real conversation messages");
}
function formatCompactionReason(reason) {
	const text = normalizeOptionalString(reason);
	if (!text) return;
	const lower = normalizeLowercaseStringOrEmpty(text);
	if (lower.includes("nothing to compact")) return "nothing compactable in this session yet";
	if (lower.includes("below threshold")) return "context is below the compaction threshold";
	if (lower.includes("already compacted")) return "session was already compacted recently";
	if (lower.includes("no real conversation messages")) return "no real conversation messages yet";
	return text;
}
function resolveManualCompactContextTokenBudget(params) {
	const liveContextTokens = typeof params.liveContextTokens === "number" && Number.isFinite(params.liveContextTokens) && params.liveContextTokens > 0 ? Math.floor(params.liveContextTokens) : void 0;
	const model = normalizeOptionalString(params.model);
	const provider = normalizeOptionalString(params.provider);
	if (!model || !provider) return liveContextTokens ?? resolvePersistedContextTokens(params.persistedContextTokens);
	const contextConfigProvider = resolveContextConfigProviderForRuntime({
		provider,
		runtimeId: resolveAgentHarnessPolicy({
			provider,
			modelId: model,
			config: params.cfg,
			agentId: params.agentId,
			sessionKey: params.sessionKey
		}).runtime
	});
	const configuredContextTokens = resolveContextTokensForModel({
		cfg: params.cfg,
		provider: contextConfigProvider,
		model: resolveManualCompactContextModelId({
			provider,
			contextConfigProvider,
			model
		}),
		allowAsyncLoad: false
	});
	if (typeof configuredContextTokens === "number" && configuredContextTokens > 0) {
		const configuredBudget = Math.floor(configuredContextTokens);
		return liveContextTokens !== void 0 ? Math.min(liveContextTokens, configuredBudget) : configuredBudget;
	}
	if (liveContextTokens !== void 0) return liveContextTokens;
	return resolvePersistedContextTokens(params.persistedContextTokens);
}
function resolvePersistedContextTokens(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function resolveManualCompactContextModelId(params) {
	const model = params.model.trim();
	const slashIndex = model.indexOf("/");
	if (slashIndex <= 0) return model;
	const modelProvider = normalizeProviderId(model.slice(0, slashIndex));
	const selectedProvider = normalizeProviderId(params.provider);
	const contextConfigProvider = normalizeProviderId(params.contextConfigProvider);
	const modelId = model.slice(slashIndex + 1).trim();
	if (!modelId) return model;
	if (modelProvider === selectedProvider || modelProvider === contextConfigProvider || modelProvider === "openai" && contextConfigProvider === "openai-codex") return modelId;
	return model;
}
const handleCompactCommand = async (params) => {
	if (!(params.command.commandBodyNormalized === "/compact" || params.command.commandBodyNormalized.startsWith("/compact "))) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /compact from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	if (!targetSessionEntry?.sessionId) return {
		shouldContinue: false,
		reply: { text: "⚙️ Compaction unavailable (missing session id)." }
	};
	const runtime = await loadCompactRuntime();
	const sessionId = targetSessionEntry.sessionId;
	if (runtime.isEmbeddedPiRunActive(sessionId)) {
		runtime.abortEmbeddedPiRun(sessionId);
		await runtime.waitForEmbeddedPiRunEnd(sessionId, 15e3);
	}
	const sessionAgentId = params.sessionKey ? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	}) : params.agentId ?? "main";
	const sessionAgentDir = sessionAgentId === (params.agentId ?? "main") && params.agentDir ? params.agentDir : resolveAgentDir(params.cfg, sessionAgentId);
	const customInstructions = extractCompactInstructions({
		rawBody: params.ctx.CommandBody ?? params.ctx.RawBody ?? params.ctx.Body,
		ctx: params.ctx,
		cfg: params.cfg,
		agentId: sessionAgentId,
		isGroup: params.isGroup
	});
	const contextTokenBudget = resolveManualCompactContextTokenBudget({
		cfg: params.cfg,
		provider: params.provider,
		model: params.model,
		agentId: sessionAgentId,
		sessionKey: params.sessionKey,
		liveContextTokens: params.contextTokens,
		persistedContextTokens: targetSessionEntry.contextTokens
	});
	const result = await runtime.compactEmbeddedPiSession({
		sessionId,
		sessionKey: params.sessionKey,
		allowGatewaySubagentBinding: true,
		messageChannel: params.command.channel,
		groupId: targetSessionEntry.groupId,
		groupChannel: targetSessionEntry.groupChannel,
		groupSpace: targetSessionEntry.space,
		spawnedBy: targetSessionEntry.spawnedBy,
		senderId: params.command.senderId,
		senderName: params.ctx.SenderName,
		senderUsername: params.ctx.SenderUsername,
		senderE164: params.ctx.SenderE164,
		sessionFile: runtime.resolveSessionFilePath(sessionId, targetSessionEntry, runtime.resolveSessionFilePathOptions({
			agentId: sessionAgentId,
			storePath: params.storePath
		})),
		workspaceDir: params.workspaceDir,
		agentDir: sessionAgentDir,
		config: params.cfg,
		skillsSnapshot: targetSessionEntry.skillsSnapshot,
		provider: params.provider,
		model: params.model,
		contextTokenBudget,
		agentHarnessId: targetSessionEntry.sessionId === sessionId ? targetSessionEntry.agentHarnessId : void 0,
		thinkLevel: params.resolvedThinkLevel ?? await params.resolveDefaultThinkingLevel(),
		bashElevated: {
			enabled: false,
			allowed: false,
			defaultLevel: "off"
		},
		customInstructions,
		trigger: "manual",
		ownerNumbers: params.command.ownerList.length > 0 ? params.command.ownerList : void 0
	});
	const compactLabel = result.ok || isCompactionSkipReason(result.reason) ? result.compacted ? result.result?.tokensBefore != null && result.result?.tokensAfter != null ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} → ${runtime.formatTokenCount(result.result.tokensAfter)})` : result.result?.tokensBefore ? `Compacted (${runtime.formatTokenCount(result.result.tokensBefore)} before)` : "Compacted" : "Compaction skipped" : "Compaction failed";
	if (result.ok && result.compacted) await runtime.incrementCompactionCount({
		cfg: params.cfg,
		sessionEntry: targetSessionEntry,
		sessionStore: params.sessionStore,
		sessionKey: params.sessionKey,
		storePath: params.storePath,
		tokensAfter: result.result?.tokensAfter,
		newSessionId: result.result?.sessionId,
		newSessionFile: result.result?.sessionFile
	});
	const totalTokens = result.result?.tokensAfter ?? runtime.resolveFreshSessionTotalTokens(targetSessionEntry);
	const contextSummary = runtime.formatContextUsageShort(typeof totalTokens === "number" && totalTokens > 0 ? totalTokens : null, contextTokenBudget ?? null);
	const reason = formatCompactionReason(result.reason);
	const line = reason ? `${compactLabel}: ${reason} • ${contextSummary}` : `${compactLabel} • ${contextSummary}`;
	runtime.enqueueSystemEvent(line, { sessionKey: params.sessionKey });
	return {
		shouldContinue: false,
		reply: { text: `⚙️ ${line}` }
	};
};
//#endregion
//#region src/auto-reply/reply/commands-slash-parse.ts
function parseSlashCommandActionArgs(raw, slash) {
	const trimmed = raw.trim();
	const slashLower = normalizeLowercaseStringOrEmpty(slash);
	if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith(slashLower)) return { kind: "no-match" };
	const charAfter = trimmed.charAt(slash.length);
	if (charAfter && !/[\s:]/.test(charAfter)) return { kind: "no-match" };
	const rest = trimmed.slice(slash.length).trim();
	if (!rest) return { kind: "empty" };
	const match = rest.match(/^(\S+)(?:\s+([\s\S]+))?$/);
	if (!match) return { kind: "invalid" };
	return {
		kind: "parsed",
		action: normalizeLowercaseStringOrEmpty(match[1]),
		args: (match[2] ?? "").trim()
	};
}
function parseSlashCommandOrNull(raw, slash, opts) {
	const parsed = parseSlashCommandActionArgs(raw, slash);
	if (parsed.kind === "no-match") return null;
	if (parsed.kind === "invalid") return {
		ok: false,
		message: opts.invalidMessage
	};
	if (parsed.kind === "empty") return {
		ok: true,
		action: opts.defaultAction ?? "show",
		args: ""
	};
	return {
		ok: true,
		action: parsed.action,
		args: parsed.args
	};
}
//#endregion
//#region src/auto-reply/reply/commands-setunset.ts
function parseSetUnsetCommand(params) {
	const action = params.action;
	const args = params.args.trim();
	if (action === "unset") {
		if (!args) return {
			kind: "error",
			message: `Usage: ${params.slash} unset path`
		};
		return {
			kind: "unset",
			path: args
		};
	}
	if (!args) return {
		kind: "error",
		message: `Usage: ${params.slash} set path=value`
	};
	const eqIndex = args.indexOf("=");
	if (eqIndex <= 0) return {
		kind: "error",
		message: `Usage: ${params.slash} set path=value`
	};
	const path = args.slice(0, eqIndex).trim();
	const rawValue = args.slice(eqIndex + 1);
	if (!path) return {
		kind: "error",
		message: `Usage: ${params.slash} set path=value`
	};
	const parsed = parseConfigValue(rawValue);
	if (parsed.error) return {
		kind: "error",
		message: parsed.error
	};
	return {
		kind: "set",
		path,
		value: parsed.value
	};
}
function parseSetUnsetCommandAction(params) {
	if (params.action !== "set" && params.action !== "unset") return null;
	const parsed = parseSetUnsetCommand({
		slash: params.slash,
		action: params.action,
		args: params.args
	});
	if (parsed.kind === "error") return params.onError(parsed.message);
	return parsed.kind === "set" ? params.onSet(parsed.path, parsed.value) : params.onUnset(parsed.path);
}
function parseSlashCommandWithSetUnset(params) {
	const parsed = parseSlashCommandOrNull(params.raw, params.slash, { invalidMessage: params.invalidMessage });
	if (!parsed) return null;
	if (!parsed.ok) return params.onError(parsed.message);
	const { action, args } = parsed;
	const setUnset = parseSetUnsetCommandAction({
		slash: params.slash,
		action,
		args,
		onSet: params.onSet,
		onUnset: params.onUnset,
		onError: params.onError
	});
	if (setUnset) return setUnset;
	const knownAction = params.onKnownAction(action, args);
	if (knownAction) return knownAction;
	return params.onError(params.usageMessage);
}
//#endregion
//#region src/auto-reply/reply/commands-setunset-standard.ts
function parseStandardSetUnsetSlashCommand(params) {
	return parseSlashCommandWithSetUnset({
		raw: params.raw,
		slash: params.slash,
		invalidMessage: params.invalidMessage,
		usageMessage: params.usageMessage,
		onKnownAction: params.onKnownAction,
		onSet: params.onSet ?? ((path, value) => ({
			action: "set",
			path,
			value
		})),
		onUnset: params.onUnset ?? ((path) => ({
			action: "unset",
			path
		})),
		onError: params.onError ?? ((message) => ({
			action: "error",
			message
		}))
	});
}
//#endregion
//#region src/auto-reply/reply/config-commands.ts
function parseConfigCommand(raw) {
	return parseStandardSetUnsetSlashCommand({
		raw,
		slash: "/config",
		invalidMessage: "Invalid /config syntax.",
		usageMessage: "Usage: /config show|set|unset",
		onKnownAction: (action, args) => {
			if (action === "show" || action === "get") return {
				action: "show",
				path: args || void 0
			};
		}
	});
}
//#endregion
//#region src/auto-reply/reply/debug-commands.ts
function parseDebugCommand(raw) {
	return parseStandardSetUnsetSlashCommand({
		raw,
		slash: "/debug",
		invalidMessage: "Invalid /debug syntax.",
		usageMessage: "Usage: /debug show|set|unset|reset",
		onKnownAction: (action) => {
			if (action === "show") return { action: "show" };
			if (action === "reset") return { action: "reset" };
		}
	});
}
//#endregion
//#region src/auto-reply/reply/commands-config.ts
const handleConfigCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const configCommand = parseConfigCommand(params.command.commandBodyNormalized);
	if (!configCommand) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/config");
	if (unauthorized) return unauthorized;
	const nonOwner = configCommand.action === "show" && isInternalMessageChannel(params.command.channel) ? null : rejectNonOwnerCommand(params, "/config");
	if (nonOwner) return nonOwner;
	const disabled = requireCommandFlagEnabled(params.cfg, {
		label: "/config",
		configKey: "config"
	});
	if (disabled) return disabled;
	if (configCommand.action === "error") return {
		shouldContinue: false,
		reply: { text: `⚠️ ${configCommand.message}` }
	};
	let parsedWritePath;
	if (configCommand.action === "set" || configCommand.action === "unset") {
		const missingAdminScope = requireGatewayClientScope(params, {
			label: "/config write",
			allowedScopes: ["operator.admin"],
			missingText: "❌ /config set|unset requires operator.admin for gateway clients."
		});
		if (missingAdminScope) return missingAdminScope;
		const parsedPath = parseConfigPath(configCommand.path);
		if (!parsedPath.ok || !parsedPath.path) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` }
		};
		parsedWritePath = parsedPath.path;
		const channelId = params.command.channelId ?? normalizeChannelId(params.command.channel);
		const deniedText = resolveConfigWriteDeniedText({
			cfg: params.cfg,
			channel: params.command.channel,
			channelId,
			accountId: resolveChannelAccountId({
				cfg: params.cfg,
				ctx: params.ctx,
				command: params.command
			}),
			gatewayClientScopes: params.ctx.GatewayClientScopes,
			target: resolveConfigWriteTargetFromPath(parsedWritePath)
		});
		if (deniedText) return {
			shouldContinue: false,
			reply: { text: deniedText }
		};
	}
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") return {
		shouldContinue: false,
		reply: { text: "⚠️ Config file is invalid; fix it before using /config." }
	};
	const parsedBase = structuredClone(snapshot.parsed);
	if (configCommand.action === "show") {
		const pathRaw = normalizeOptionalString(configCommand.path);
		if (pathRaw) {
			const parsedPath = parseConfigPath(pathRaw);
			if (!parsedPath.ok || !parsedPath.path) return {
				shouldContinue: false,
				reply: { text: `⚠️ ${parsedPath.error ?? "Invalid path."}` }
			};
			const value = getConfigValueAtPath(parsedBase, parsedPath.path);
			return {
				shouldContinue: false,
				reply: { text: `⚙️ Config ${pathRaw}:\n\`\`\`json\n${JSON.stringify(value ?? null, null, 2)}\n\`\`\`` }
			};
		}
		return {
			shouldContinue: false,
			reply: { text: `⚙️ Config (raw):\n\`\`\`json\n${JSON.stringify(parsedBase, null, 2)}\n\`\`\`` }
		};
	}
	if (configCommand.action === "unset") {
		const path = parsedWritePath ?? [];
		try {
			if (!await unsetConfigPath(path)) return {
				shouldContinue: false,
				reply: { text: `⚙️ No config value found for ${configCommand.path}.` }
			};
		} catch (error) {
			const message = formatAutoReplyConfigMutationError(error);
			if (message) return {
				shouldContinue: false,
				reply: { text: `⚠️ ${message}` }
			};
			throw error;
		}
		return {
			shouldContinue: false,
			reply: { text: `⚙️ Config updated: ${configCommand.path} removed.` }
		};
	}
	if (configCommand.action === "set") {
		const path = parsedWritePath ?? [];
		try {
			await setConfigPath(path, configCommand.value);
		} catch (error) {
			const message = formatAutoReplyConfigMutationError(error);
			if (message) return {
				shouldContinue: false,
				reply: { text: `⚠️ ${message}` }
			};
			throw error;
		}
		const valueLabel = typeof configCommand.value === "string" ? `"${configCommand.value}"` : JSON.stringify(configCommand.value);
		return {
			shouldContinue: false,
			reply: { text: `⚙️ Config updated: ${configCommand.path}=${valueLabel ?? "null"}` }
		};
	}
	return null;
};
const handleDebugCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const debugCommand = parseDebugCommand(params.command.commandBodyNormalized);
	if (!debugCommand) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/debug");
	if (unauthorized) return unauthorized;
	const nonOwner = rejectNonOwnerCommand(params, "/debug");
	if (nonOwner) return nonOwner;
	const disabled = requireCommandFlagEnabled(params.cfg, {
		label: "/debug",
		configKey: "debug"
	});
	if (disabled) return disabled;
	if (debugCommand.action === "error") return {
		shouldContinue: false,
		reply: { text: `⚠️ ${debugCommand.message}` }
	};
	if (debugCommand.action === "show") {
		const overrides = getConfigOverrides();
		if (!(Object.keys(overrides).length > 0)) return {
			shouldContinue: false,
			reply: { text: "⚙️ Debug overrides: (none)" }
		};
		return {
			shouldContinue: false,
			reply: { text: `⚙️ Debug overrides (memory-only):\n\`\`\`json\n${JSON.stringify(overrides, null, 2)}\n\`\`\`` }
		};
	}
	if (debugCommand.action === "reset") {
		resetConfigOverrides();
		return {
			shouldContinue: false,
			reply: { text: "⚙️ Debug overrides cleared; using config on disk." }
		};
	}
	if (debugCommand.action === "unset") {
		const result = unsetConfigOverride(debugCommand.path);
		if (!result.ok) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${result.error ?? "Invalid path."}` }
		};
		if (!result.removed) return {
			shouldContinue: false,
			reply: { text: `⚙️ No debug override found for ${debugCommand.path}.` }
		};
		return {
			shouldContinue: false,
			reply: { text: `⚙️ Debug override removed for ${debugCommand.path}.` }
		};
	}
	if (debugCommand.action === "set") {
		const result = setConfigOverride(debugCommand.path, debugCommand.value);
		if (!result.ok) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${result.error ?? "Invalid override."}` }
		};
		const valueLabel = typeof debugCommand.value === "string" ? `"${debugCommand.value}"` : JSON.stringify(debugCommand.value);
		return {
			shouldContinue: false,
			reply: { text: `⚙️ Debug override set: ${debugCommand.path}=${valueLabel ?? "null"}` }
		};
	}
	return null;
};
//#endregion
//#region src/auto-reply/reply/context-treemap.ts
const WIDTH = 1280;
const HEIGHT = 860;
const HEADER_HEIGHT = 88;
const FOOTER_HEIGHT = 54;
const LEGEND_WIDTH = 274;
const PADDING = 22;
const TREEMAP_GAP = 4;
const FONT = {
	" ": [
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"00000"
	],
	"-": [
		"00000",
		"00000",
		"00000",
		"11111",
		"00000",
		"00000",
		"00000"
	],
	".": [
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"01100",
		"01100"
	],
	"/": [
		"00001",
		"00010",
		"00010",
		"00100",
		"01000",
		"01000",
		"10000"
	],
	":": [
		"00000",
		"01100",
		"01100",
		"00000",
		"01100",
		"01100",
		"00000"
	],
	_: [
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"00000",
		"11111"
	],
	"0": [
		"01110",
		"10001",
		"10011",
		"10101",
		"11001",
		"10001",
		"01110"
	],
	"1": [
		"00100",
		"01100",
		"00100",
		"00100",
		"00100",
		"00100",
		"01110"
	],
	"2": [
		"01110",
		"10001",
		"00001",
		"00010",
		"00100",
		"01000",
		"11111"
	],
	"3": [
		"11110",
		"00001",
		"00001",
		"01110",
		"00001",
		"00001",
		"11110"
	],
	"4": [
		"00010",
		"00110",
		"01010",
		"10010",
		"11111",
		"00010",
		"00010"
	],
	"5": [
		"11111",
		"10000",
		"10000",
		"11110",
		"00001",
		"00001",
		"11110"
	],
	"6": [
		"00110",
		"01000",
		"10000",
		"11110",
		"10001",
		"10001",
		"01110"
	],
	"7": [
		"11111",
		"00001",
		"00010",
		"00100",
		"01000",
		"01000",
		"01000"
	],
	"8": [
		"01110",
		"10001",
		"10001",
		"01110",
		"10001",
		"10001",
		"01110"
	],
	"9": [
		"01110",
		"10001",
		"10001",
		"01111",
		"00001",
		"00010",
		"01100"
	],
	A: [
		"01110",
		"10001",
		"10001",
		"11111",
		"10001",
		"10001",
		"10001"
	],
	B: [
		"11110",
		"10001",
		"10001",
		"11110",
		"10001",
		"10001",
		"11110"
	],
	C: [
		"01111",
		"10000",
		"10000",
		"10000",
		"10000",
		"10000",
		"01111"
	],
	D: [
		"11110",
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"11110"
	],
	E: [
		"11111",
		"10000",
		"10000",
		"11110",
		"10000",
		"10000",
		"11111"
	],
	F: [
		"11111",
		"10000",
		"10000",
		"11110",
		"10000",
		"10000",
		"10000"
	],
	G: [
		"01111",
		"10000",
		"10000",
		"10111",
		"10001",
		"10001",
		"01110"
	],
	H: [
		"10001",
		"10001",
		"10001",
		"11111",
		"10001",
		"10001",
		"10001"
	],
	I: [
		"01110",
		"00100",
		"00100",
		"00100",
		"00100",
		"00100",
		"01110"
	],
	J: [
		"00001",
		"00001",
		"00001",
		"00001",
		"10001",
		"10001",
		"01110"
	],
	K: [
		"10001",
		"10010",
		"10100",
		"11000",
		"10100",
		"10010",
		"10001"
	],
	L: [
		"10000",
		"10000",
		"10000",
		"10000",
		"10000",
		"10000",
		"11111"
	],
	M: [
		"10001",
		"11011",
		"10101",
		"10101",
		"10001",
		"10001",
		"10001"
	],
	N: [
		"10001",
		"11001",
		"10101",
		"10011",
		"10001",
		"10001",
		"10001"
	],
	O: [
		"01110",
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"01110"
	],
	P: [
		"11110",
		"10001",
		"10001",
		"11110",
		"10000",
		"10000",
		"10000"
	],
	Q: [
		"01110",
		"10001",
		"10001",
		"10001",
		"10101",
		"10010",
		"01101"
	],
	R: [
		"11110",
		"10001",
		"10001",
		"11110",
		"10100",
		"10010",
		"10001"
	],
	S: [
		"01111",
		"10000",
		"10000",
		"01110",
		"00001",
		"00001",
		"11110"
	],
	T: [
		"11111",
		"00100",
		"00100",
		"00100",
		"00100",
		"00100",
		"00100"
	],
	U: [
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"01110"
	],
	V: [
		"10001",
		"10001",
		"10001",
		"10001",
		"10001",
		"01010",
		"00100"
	],
	W: [
		"10001",
		"10001",
		"10001",
		"10101",
		"10101",
		"10101",
		"01010"
	],
	X: [
		"10001",
		"10001",
		"01010",
		"00100",
		"01010",
		"10001",
		"10001"
	],
	Y: [
		"10001",
		"10001",
		"01010",
		"00100",
		"00100",
		"00100",
		"00100"
	],
	Z: [
		"11111",
		"00001",
		"00010",
		"00100",
		"01000",
		"10000",
		"11111"
	]
};
function rgba(r, g, b, a = 255) {
	return {
		r,
		g,
		b,
		a
	};
}
function mixColor(a, b, amount) {
	const t = Math.max(0, Math.min(1, amount));
	return rgba(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t);
}
function formatInt$1(value) {
	return new Intl.NumberFormat("en-US").format(value);
}
function formatSize(value) {
	return `${formatInt$1(value)} CH / ~${formatInt$1(estimateTokensFromChars(value))} TOK`;
}
function totalValue(items) {
	return items.reduce((sum, item) => sum + item.value, 0);
}
function sanitizeLabel(value) {
	return value.replace(/[^a-zA-Z0-9/_.:-]+/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
}
function truncateLabel(value, maxChars) {
	if (maxChars <= 0) return "";
	if (value.length <= maxChars) return value;
	if (maxChars <= 2) return value.slice(0, maxChars);
	return value.slice(0, maxChars - 1);
}
function layoutBinary(rawItems, rect) {
	const items = rawItems.filter((item) => item.value > 0).toSorted((a, b) => b.value - a.value);
	if (items.length === 0 || rect.width <= 0 || rect.height <= 0) return [];
	if (items.length === 1) return [{
		item: items[0],
		rect
	}];
	const total = totalValue(items);
	let splitIndex = 1;
	let splitSum = items[0]?.value ?? 0;
	for (let i = 1; i < items.length - 1; i += 1) {
		const next = splitSum + items[i].value;
		if (Math.abs(total / 2 - next) > Math.abs(total / 2 - splitSum)) break;
		splitSum = next;
		splitIndex = i + 1;
	}
	const first = items.slice(0, splitIndex);
	const second = items.slice(splitIndex);
	const ratio = splitSum / total;
	if (rect.width >= rect.height) {
		const firstWidth = rect.width * ratio;
		return [...layoutBinary(first, {
			...rect,
			width: firstWidth
		}), ...layoutBinary(second, {
			x: rect.x + firstWidth,
			y: rect.y,
			width: rect.width - firstWidth,
			height: rect.height
		})];
	}
	const firstHeight = rect.height * ratio;
	return [...layoutBinary(first, {
		...rect,
		height: firstHeight
	}), ...layoutBinary(second, {
		x: rect.x,
		y: rect.y + firstHeight,
		width: rect.width,
		height: rect.height - firstHeight
	})];
}
var PngCanvas = class {
	constructor() {
		this.data = Buffer.alloc(WIDTH * HEIGHT * 4);
	}
	fill(color) {
		for (let i = 0; i < this.data.length; i += 4) {
			this.data[i] = color.r;
			this.data[i + 1] = color.g;
			this.data[i + 2] = color.b;
			this.data[i + 3] = color.a;
		}
	}
	rect(rect, color) {
		const x0 = Math.max(0, Math.floor(rect.x));
		const y0 = Math.max(0, Math.floor(rect.y));
		const x1 = Math.min(WIDTH, Math.ceil(rect.x + rect.width));
		const y1 = Math.min(HEIGHT, Math.ceil(rect.y + rect.height));
		for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
			const offset = (y * WIDTH + x) * 4;
			this.data[offset] = color.r;
			this.data[offset + 1] = color.g;
			this.data[offset + 2] = color.b;
			this.data[offset + 3] = color.a;
		}
	}
	stroke(rect, color, width) {
		this.rect({
			x: rect.x,
			y: rect.y,
			width: rect.width,
			height: width
		}, color);
		this.rect({
			x: rect.x,
			y: rect.y + rect.height - width,
			width: rect.width,
			height: width
		}, color);
		this.rect({
			x: rect.x,
			y: rect.y,
			width,
			height: rect.height
		}, color);
		this.rect({
			x: rect.x + rect.width - width,
			y: rect.y,
			width,
			height: rect.height
		}, color);
	}
	text(x, y, text, color, scale) {
		let cursorX = Math.floor(x);
		const cursorY = Math.floor(y);
		for (const rawChar of text) {
			const glyph = FONT[rawChar.toUpperCase()] ?? FONT[" "];
			for (let row = 0; row < glyph.length; row += 1) {
				const line = glyph[row];
				for (let col = 0; col < line.length; col += 1) {
					if (line[col] !== "1") continue;
					this.rect({
						x: cursorX + col * scale,
						y: cursorY + row * scale,
						width: scale,
						height: scale
					}, color);
				}
			}
			cursorX += 6 * scale;
		}
	}
};
function inset(rect, padding) {
	return {
		x: rect.x + padding,
		y: rect.y + padding,
		width: Math.max(0, rect.width - padding * 2),
		height: Math.max(0, rect.height - padding * 2)
	};
}
function drawLabel(canvas, rect, lines, color, scale) {
	const charWidth = 6 * scale;
	const lineHeight = 9 * scale;
	const maxChars = Math.floor((rect.width - 12) / charWidth);
	const maxLines = Math.floor((rect.height - 12) / lineHeight);
	if (maxChars < 4 || maxLines < 1) return;
	lines.slice(0, maxLines).map((line) => truncateLabel(sanitizeLabel(line), maxChars)).forEach((line, index) => {
		canvas.text(rect.x + 7, rect.y + 7 + index * lineHeight, line, color, scale);
	});
}
function crc32(buffer) {
	let crc = 4294967295;
	for (const byte of buffer) {
		crc ^= byte;
		for (let i = 0; i < 8; i += 1) crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0);
	}
	return (crc ^ 4294967295) >>> 0;
}
function pngChunk(type, data) {
	const typeBuffer = Buffer.from(type, "ascii");
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
	return Buffer.concat([
		length,
		typeBuffer,
		data,
		crc
	]);
}
function encodePng(data) {
	const signature = Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(WIDTH, 0);
	ihdr.writeUInt32BE(HEIGHT, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const stride = WIDTH * 4;
	const raw = Buffer.alloc(5121 * HEIGHT);
	for (let y = 0; y < HEIGHT; y += 1) {
		const rowStart = y * 5121;
		raw[rowStart] = 0;
		data.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
	}
	return Buffer.concat([
		signature,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0))
	]);
}
function treemapGroup(params) {
	return {
		...params,
		value: totalValue(params.leaves)
	};
}
function buildGroups(report) {
	const injectedTotal = report.injectedWorkspaceFiles.reduce((sum, file) => sum + file.injectedChars, 0);
	const projectFrameChars = Math.max(0, report.systemPrompt.projectContextChars - injectedTotal);
	const skillTotal = report.skills.entries.reduce((sum, skill) => sum + skill.blockChars, 0);
	const systemBaseChars = Math.max(0, report.systemPrompt.nonProjectContextChars - skillTotal);
	const tools = report.tools.entries.map((tool) => ({
		name: tool.name,
		value: tool.schemaChars ?? 0
	})).filter((tool) => tool.value > 0);
	const currentTurnLeaves = report.currentTurn ? [{
		name: "Model prompt",
		value: report.currentTurn.promptChars
	}, {
		name: "Runtime context",
		value: report.currentTurn.runtimeContextChars
	}].filter((leaf) => leaf.value > 0) : [];
	return [
		treemapGroup({
			name: report.currentTurn?.kind === "room_event" ? "Room event" : "Current turn",
			color: rgba(72, 135, 197),
			leaves: currentTurnLeaves
		}),
		treemapGroup({
			name: "Workspace files",
			color: rgba(58, 145, 91),
			leaves: [...report.injectedWorkspaceFiles.map((file) => ({
				name: file.name,
				value: file.injectedChars
			})), {
				name: "Project context frame",
				value: projectFrameChars
			}]
		}),
		treemapGroup({
			name: "System prompt",
			color: rgba(222, 138, 46),
			leaves: [{
				name: "Base instructions",
				value: systemBaseChars
			}]
		}),
		treemapGroup({
			name: "Tool schemas",
			color: rgba(59, 118, 184),
			leaves: tools
		}),
		treemapGroup({
			name: "Skills",
			color: rgba(132, 91, 173),
			leaves: report.skills.entries.map((skill) => ({
				name: skill.name,
				value: skill.blockChars
			}))
		})
	].filter((group) => group.value > 0);
}
function drawTreemap(canvas, groups, rect) {
	layoutBinary(groups, rect).forEach(({ item: group, rect: groupRect }, groupIndex) => {
		const groupFill = mixColor(group.color, rgba(18, 22, 27), .16);
		canvas.rect(groupRect, groupFill);
		canvas.stroke(groupRect, rgba(14, 18, 22), 3);
		drawLabel(canvas, {
			x: groupRect.x + 4,
			y: groupRect.y + 4,
			width: groupRect.width - 8,
			height: 38
		}, [group.name, formatSize(group.value)], rgba(248, 250, 252), groupRect.width > 260 && groupRect.height > 120 ? 2 : 1);
		const childRect = inset({
			x: groupRect.x + TREEMAP_GAP,
			y: groupRect.y + (groupRect.height > 92 ? 44 : TREEMAP_GAP),
			width: groupRect.width - TREEMAP_GAP * 2,
			height: groupRect.height - (groupRect.height > 92 ? 48 : TREEMAP_GAP * 2)
		}, 0);
		layoutBinary(group.leaves.filter((leaf) => leaf.value > 0), childRect).forEach(({ item: leaf, rect: leafRect }, leafIndex) => {
			const shade = leafIndex % 7 / 10 + groupIndex % 2 * .08;
			const fill = mixColor(group.color, rgba(255, 255, 255), shade);
			const inner = inset(leafRect, 1.5);
			canvas.rect(inner, fill);
			canvas.stroke(inner, rgba(8, 12, 16), 1);
			if (inner.width * inner.height > 5200) {
				const textColor = fill.r * .299 + fill.g * .587 + fill.b * .114 > 150 ? rgba(16, 23, 31) : rgba(248, 250, 252);
				drawLabel(canvas, inner, [leaf.name, formatSize(leaf.value)], textColor, 1);
			}
		});
	});
}
function drawLegend(canvas, groups, rect, total) {
	canvas.rect(rect, rgba(245, 247, 250));
	canvas.stroke(rect, rgba(213, 220, 228), 1);
	canvas.text(rect.x + 18, rect.y + 18, "LEGEND", rgba(30, 41, 59), 2);
	let y = rect.y + 58;
	groups.forEach((group) => {
		canvas.rect({
			x: rect.x + 18,
			y,
			width: 18,
			height: 18
		}, group.color);
		canvas.stroke({
			x: rect.x + 18,
			y,
			width: 18,
			height: 18
		}, rgba(15, 23, 42), 1);
		const pct = total > 0 ? `${Math.round(group.value / total * 100)} PCT` : "0 PCT";
		drawLabel(canvas, {
			x: rect.x + 46,
			y: y - 1,
			width: rect.width - 62,
			height: 38
		}, [group.name, pct], rgba(30, 41, 59), 1);
		y += 54;
	});
}
async function renderContextTreemapPng(params) {
	const groups = buildGroups(params.report);
	const trackedChars = totalValue(groups);
	const canvas = new PngCanvas();
	canvas.fill(rgba(238, 241, 245));
	canvas.rect({
		x: 0,
		y: 0,
		width: WIDTH,
		height: HEADER_HEIGHT
	}, rgba(20, 26, 34));
	canvas.text(PADDING, 24, "CONTEXT TREEMAP", rgba(248, 250, 252), 3);
	const sourceLine = `${params.report.source.toUpperCase()} / ${params.report.provider ?? "provider"} / ${params.report.model ?? "model"}`;
	canvas.text(PADDING, 58, sanitizeLabel(sourceLine), rgba(176, 196, 222), 1);
	const treemapRect = {
		x: PADDING,
		y: 110,
		width: WIDTH - LEGEND_WIDTH - PADDING * 3,
		height: HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT - PADDING * 2
	};
	drawTreemap(canvas, groups, treemapRect);
	drawLegend(canvas, groups, {
		x: WIDTH - LEGEND_WIDTH - PADDING,
		y: 110,
		width: LEGEND_WIDTH,
		height: treemapRect.height
	}, trackedChars);
	const footerY = 824;
	const actual = params.session.cachedContextTokens == null ? "ACTUAL CTX UNKNOWN" : `ACTUAL CTX ${formatInt$1(params.session.cachedContextTokens)} TOK`;
	const window = params.session.contextWindowTokens == null || params.session.contextWindowTokens <= 0 ? "WINDOW UNKNOWN" : `WINDOW ${formatInt$1(params.session.contextWindowTokens)} TOK`;
	canvas.text(PADDING, footerY, `${formatSize(trackedChars)} / ${actual} / ${window}`, rgba(51, 65, 85), 1);
	const outPath = path.join(resolvePreferredOpenClawTmpDir(), `openclaw-context-map-${crypto.randomUUID()}.png`);
	await writeFile(outPath, encodePng(canvas.data));
	return {
		path: outPath,
		trackedChars,
		caption: [
			"Context treemap",
			`Source: ${params.report.source}`,
			`Tracked: ${formatInt$1(trackedChars)} chars (~${formatInt$1(estimateTokensFromChars(trackedChars))} tok)`,
			params.session.cachedContextTokens == null ? "Actual cached context: unavailable" : `Actual cached context: ${formatInt$1(params.session.cachedContextTokens)} tok`
		].join("\n")
	};
}
//#endregion
//#region src/auto-reply/reply/commands-context-report.ts
function formatInt(n) {
	return new Intl.NumberFormat("en-US").format(n);
}
function formatCharsAndTokens(chars) {
	return `${formatInt(chars)} chars (~${formatInt(estimateTokensFromChars(chars))} tok)`;
}
function parseContextArgs(commandBodyNormalized) {
	if (commandBodyNormalized === "/context") return "";
	if (commandBodyNormalized.startsWith("/context ")) return commandBodyNormalized.slice(8).trim();
	return "";
}
function formatListTop(entries, cap) {
	const sorted = [...entries].toSorted((a, b) => b.value - a.value);
	const top = sorted.slice(0, cap);
	const omitted = Math.max(0, sorted.length - top.length);
	return {
		lines: top.map((e) => `- ${e.name}: ${formatCharsAndTokens(e.value)}`),
		omitted
	};
}
function resolveRunContextReport(params) {
	const existing = (params.sessionStore?.[params.sessionKey] ?? params.sessionEntry)?.systemPromptReport;
	return existing?.source === "run" ? existing : null;
}
function resolveContextReportAgentId(params) {
	return resolveSessionAgentIds({
		sessionKey: params.sessionKey,
		config: params.cfg,
		agentId: params.agentId
	}).sessionAgentId;
}
async function resolveContextReport(params) {
	const runReport = resolveRunContextReport(params);
	if (runReport) return runReport;
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const sessionAgentId = resolveContextReportAgentId(params);
	const bootstrapMaxChars = resolveBootstrapMaxChars(params.cfg, sessionAgentId);
	const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.cfg, sessionAgentId);
	const { resolveCommandsSystemPromptBundle } = await import("./commands-system-prompt-Dq2Q2auA.js");
	const { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime } = await resolveCommandsSystemPromptBundle(params);
	return buildSystemPromptReport({
		source: "estimate",
		generatedAt: Date.now(),
		sessionId: targetSessionEntry?.sessionId,
		sessionKey: params.sessionKey,
		provider: params.provider,
		model: params.model,
		workspaceDir: params.workspaceDir,
		bootstrapMaxChars,
		bootstrapTotalMaxChars,
		sandbox: {
			mode: sandboxRuntime.mode,
			sandboxed: sandboxRuntime.sandboxed
		},
		systemPrompt,
		bootstrapFiles,
		injectedFiles,
		skillsPrompt,
		tools
	});
}
async function buildContextReply(params) {
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const sub = normalizeLowercaseStringOrEmpty(parseContextArgs(params.command.commandBodyNormalized).split(/\s+/).find(Boolean));
	if (!sub || sub === "help") return { text: [
		"🧠 /context",
		"",
		"What counts as context (high-level), plus a breakdown mode.",
		"",
		"Try:",
		"- /context list   (short breakdown)",
		"- /context detail (per-file + per-tool + per-skill + system prompt size)",
		"- /context map    (WinDirStat-style treemap image)",
		"- /context json   (same, machine-readable)",
		"",
		"Inline shortcut = a command token inside a normal message (e.g. “hey /status”). It runs immediately (allowlisted senders only) and is stripped before the model sees the remaining text."
	].join("\n") };
	const cachedContextUsageTokens = resolveFreshSessionTotalTokens(targetSessionEntry);
	const session = {
		totalTokens: targetSessionEntry?.totalTokens ?? null,
		totalTokensFresh: targetSessionEntry?.totalTokensFresh ?? null,
		inputTokens: targetSessionEntry?.inputTokens ?? null,
		outputTokens: targetSessionEntry?.outputTokens ?? null,
		contextTokens: params.contextTokens ?? null
	};
	if (sub === "map") {
		const report = resolveRunContextReport(params);
		if (!report) return { text: [
			"Context treemap unavailable.",
			"No actual run context is cached for this session yet.",
			"Send a normal message, then run /context map again."
		].join("\n") };
		const treemap = await renderContextTreemapPng({
			report,
			session: {
				cachedContextTokens: cachedContextUsageTokens ?? null,
				contextWindowTokens: session.contextTokens
			}
		});
		return {
			text: treemap.caption,
			mediaUrl: treemap.path,
			trustedLocalMedia: true,
			sensitiveMedia: true
		};
	}
	const report = await resolveContextReport(params);
	if (sub === "json") return { text: JSON.stringify({
		report,
		session
	}, null, 2) };
	if (sub !== "list" && sub !== "show" && sub !== "detail" && sub !== "deep") return { text: ["Unknown /context mode.", "Use: /context, /context list, /context detail, /context map, or /context json"].join("\n") };
	const fileLines = report.injectedWorkspaceFiles.map((f) => {
		const status = f.missing ? "MISSING" : f.truncated ? "TRUNCATED" : "OK";
		const raw = f.missing ? "0" : formatCharsAndTokens(f.rawChars);
		const injected = f.missing ? "0" : formatCharsAndTokens(f.injectedChars);
		return `- ${f.name}: ${status} | raw ${raw} | injected ${injected}`;
	});
	const sandboxLine = `Sandbox: mode=${report.sandbox?.mode ?? "unknown"} sandboxed=${report.sandbox?.sandboxed ?? false}`;
	const toolSchemaLine = `Tool schemas (JSON): ${formatCharsAndTokens(report.tools.schemaChars)} (counts toward context; not shown as text)`;
	const toolListLine = `Tool list (system prompt text): ${formatCharsAndTokens(report.tools.listChars)}`;
	const skillNameSet = new Set(report.skills.entries.map((s) => s.name));
	const skillNames = Array.from(skillNameSet);
	const toolNames = report.tools.entries.map((t) => t.name);
	const formatNameList = (names, cap) => names.length <= cap ? names.join(", ") : `${names.slice(0, cap).join(", ")}, … (+${names.length - cap} more)`;
	const skillsLine = `Skills list (system prompt text): ${formatCharsAndTokens(report.skills.promptChars)} (${skillNameSet.size} skills)`;
	const skillsNamesLine = skillNameSet.size ? `Skills: ${formatNameList(skillNames, 20)}` : "Skills: (none)";
	const toolsNamesLine = toolNames.length ? `Tools: ${formatNameList(toolNames, 30)}` : "Tools: (none)";
	const systemPromptLine = `System prompt (${report.source}): ${formatCharsAndTokens(report.systemPrompt.chars)} (Project Context ${formatCharsAndTokens(report.systemPrompt.projectContextChars)})`;
	const workspaceLabel = report.workspaceDir ?? params.workspaceDir;
	const sessionAgentId = resolveContextReportAgentId(params);
	const bootstrapMaxChars = typeof report.bootstrapMaxChars === "number" && Number.isFinite(report.bootstrapMaxChars) && report.bootstrapMaxChars > 0 ? report.bootstrapMaxChars : resolveBootstrapMaxChars(params.cfg, sessionAgentId);
	const bootstrapTotalMaxChars = typeof report.bootstrapTotalMaxChars === "number" && Number.isFinite(report.bootstrapTotalMaxChars) && report.bootstrapTotalMaxChars > 0 ? report.bootstrapTotalMaxChars : resolveBootstrapTotalMaxChars(params.cfg, sessionAgentId);
	const bootstrapMaxLabel = `${formatInt(bootstrapMaxChars)} chars`;
	const bootstrapTotalLabel = `${formatInt(bootstrapTotalMaxChars)} chars`;
	const bootstrapAnalysis = analyzeBootstrapBudget({
		files: report.injectedWorkspaceFiles,
		bootstrapMaxChars,
		bootstrapTotalMaxChars
	});
	const truncatedBootstrapFiles = bootstrapAnalysis.truncatedFiles;
	const truncationCauseCounts = truncatedBootstrapFiles.reduce((acc, file) => {
		for (const cause of file.causes) if (cause === "per-file-limit") acc.perFile += 1;
		else if (cause === "total-limit") acc.total += 1;
		return acc;
	}, {
		perFile: 0,
		total: 0
	});
	const truncationCauseParts = [truncationCauseCounts.perFile > 0 ? `${truncationCauseCounts.perFile} file(s) exceeded max/file` : null, truncationCauseCounts.total > 0 ? `${truncationCauseCounts.total} file(s) hit max/total` : null].filter(Boolean);
	const bootstrapWarningLines = truncatedBootstrapFiles.length > 0 ? [
		`⚠ Bootstrap context is over configured limits: ${truncatedBootstrapFiles.length} file(s) truncated (${formatInt(bootstrapAnalysis.totals.rawChars)} raw chars -> ${formatInt(bootstrapAnalysis.totals.injectedChars)} injected chars).`,
		...truncationCauseParts.length ? [`Causes: ${truncationCauseParts.join("; ")}.`] : [],
		"Tip: increase this agent's `agents.list[].bootstrapMaxChars` / `agents.list[].bootstrapTotalMaxChars` override, or the matching `agents.defaults.*` fallback, if this truncation is not intentional."
	] : [];
	const contextWindowLabel = session.contextTokens != null ? formatInt(session.contextTokens) : "?";
	const totalsLine = cachedContextUsageTokens != null ? `Session tokens (cached): ${formatInt(cachedContextUsageTokens)} total / ctx=${contextWindowLabel}` : `Session tokens (cached): unknown / ctx=${contextWindowLabel}`;
	const sharedContextLines = [
		`Workspace: ${workspaceLabel}`,
		`Bootstrap max/file: ${bootstrapMaxLabel}`,
		`Bootstrap max/total: ${bootstrapTotalLabel}`,
		sandboxLine,
		systemPromptLine,
		...bootstrapWarningLines.length ? ["", ...bootstrapWarningLines] : [],
		"",
		"Injected workspace files:",
		...fileLines,
		"",
		skillsLine,
		skillsNamesLine
	];
	if (sub === "detail" || sub === "deep") {
		const perSkill = formatListTop(report.skills.entries.map((s) => ({
			name: s.name,
			value: s.blockChars
		})), 30);
		const perToolSchema = formatListTop(report.tools.entries.map((t) => ({
			name: t.name,
			value: t.schemaChars
		})), 30);
		const perToolSummary = formatListTop(report.tools.entries.map((t) => ({
			name: t.name,
			value: t.summaryChars
		})), 30);
		const toolPropsLines = report.tools.entries.filter((t) => t.propertiesCount != null).toSorted((a, b) => (b.propertiesCount ?? 0) - (a.propertiesCount ?? 0)).slice(0, 30).map((t) => `- ${t.name}: ${t.propertiesCount} params`);
		const currentTurnChars = report.currentTurn ? report.currentTurn.promptChars + report.currentTurn.runtimeContextChars : 0;
		const trackedPromptChars = report.systemPrompt.chars + report.tools.schemaChars + currentTurnChars;
		const trackedPromptLine = `Tracked prompt estimate: ${formatCharsAndTokens(trackedPromptChars)}`;
		const actualContextLine = cachedContextUsageTokens != null ? `Actual context usage (cached): ${formatInt(cachedContextUsageTokens)} tok` : "Actual context usage (cached): unavailable";
		const overheadTokens = cachedContextUsageTokens != null ? cachedContextUsageTokens - estimateTokensFromChars(trackedPromptChars) : null;
		const overheadLine = overheadTokens == null ? null : overheadTokens > 0 ? `Untracked provider/runtime overhead: ~${formatInt(overheadTokens)} tok` : "Untracked provider/runtime overhead: not observed in cached usage";
		return { text: [
			"🧠 Context breakdown (detailed)",
			...sharedContextLines,
			...perSkill.lines.length ? ["Top skills (prompt entry size):", ...perSkill.lines] : [],
			...perSkill.omitted ? [`… (+${perSkill.omitted} more skills)`] : [],
			"",
			toolListLine,
			toolSchemaLine,
			toolsNamesLine,
			"Top tools (schema size):",
			...perToolSchema.lines,
			...perToolSchema.omitted ? [`… (+${perToolSchema.omitted} more tools)`] : [],
			"",
			"Top tools (summary text size):",
			...perToolSummary.lines,
			...perToolSummary.omitted ? [`… (+${perToolSummary.omitted} more tools)`] : [],
			...toolPropsLines.length ? [
				"",
				"Tools (param count):",
				...toolPropsLines
			] : [],
			"",
			trackedPromptLine,
			actualContextLine,
			...overheadLine ? [overheadLine] : [],
			"",
			totalsLine,
			"",
			"Inline shortcut: a command token inside normal text (e.g. “hey /status”) that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message."
		].filter(Boolean).join("\n") };
	}
	return { text: [
		"🧠 Context breakdown",
		...sharedContextLines,
		toolListLine,
		toolSchemaLine,
		toolsNamesLine,
		"",
		totalsLine,
		"",
		"Inline shortcut: a command token inside normal text (e.g. “hey /status”) that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message."
	].join("\n") };
}
//#endregion
//#region src/auto-reply/reply/commands-context-command.ts
const handleContextCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	if (normalized !== "/context" && !normalized.startsWith("/context ")) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /context from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	return {
		shouldContinue: false,
		reply: await buildContextReply(params)
	};
};
//#endregion
//#region src/auto-reply/reply/commands-openclaw-cli.ts
function quoteShellArg(value) {
	if (process.platform === "win32") return `'${value.replaceAll("'", "''")}'`;
	return `'${value.replaceAll("'", "'\\''")}'`;
}
function buildCurrentOpenClawCliArgv(args) {
	const entry = process.argv[1]?.trim();
	return entry && entry !== process.execPath ? [
		process.execPath,
		...process.execArgv,
		entry,
		...args
	] : [process.execPath, ...args];
}
function buildCurrentOpenClawCliCommand(args) {
	return buildCurrentOpenClawCliArgv(args).map(quoteShellArg).join(" ");
}
//#endregion
//#region src/auto-reply/reply/commands-private-route.ts
async function resolvePrivateCommandRouteTargets(params) {
	const originChannel = params.commandParams.command.channel;
	const targets = [];
	for (const candidate of listPrivateCommandRouteCandidateChannels(originChannel)) {
		const native = resolveChannelApprovalAdapter(candidate.plugin)?.native;
		if (!native?.resolveApproverDmTargets) continue;
		const accountId = candidate.channel === originChannel ? params.commandParams.ctx.AccountId ?? void 0 : void 0;
		const capabilities = native.describeDeliveryCapabilities({
			cfg: params.commandParams.cfg,
			accountId,
			approvalKind: "exec",
			request: params.request
		});
		if (!capabilities.enabled || !capabilities.supportsApproverDmSurface) continue;
		const resolvedTargets = await native.resolveApproverDmTargets({
			cfg: params.commandParams.cfg,
			accountId,
			approvalKind: "exec",
			request: params.request
		});
		for (const target of resolvedTargets) targets.push({
			channel: candidate.channel,
			to: target.to,
			accountId,
			threadId: target.threadId
		});
	}
	return sortPrivateCommandRouteTargets({
		cfg: params.commandParams.cfg,
		originChannel,
		targets: filterPrivateCommandRouteOwnerTargets({
			cfg: params.commandParams.cfg,
			targets: dedupePrivateCommandRouteTargets(targets)
		})
	});
}
async function deliverPrivateCommandReply(params) {
	return (await Promise.allSettled(params.targets.map((target) => routeReply({
		payload: params.reply,
		channel: target.channel,
		to: target.to,
		accountId: target.accountId ?? void 0,
		threadId: target.threadId ?? void 0,
		cfg: params.commandParams.cfg,
		sessionKey: params.commandParams.sessionKey,
		policyConversationType: "direct",
		mirror: false,
		isGroup: false
	})))).some((result) => result.status === "fulfilled" && result.value.ok);
}
function readCommandMessageThreadId(params) {
	return typeof params.ctx.MessageThreadId === "string" || typeof params.ctx.MessageThreadId === "number" ? String(params.ctx.MessageThreadId) : void 0;
}
function readCommandDeliveryTarget(params) {
	return normalizeOptionalString(params.ctx.OriginatingTo) ?? normalizeOptionalString(params.command.to) ?? normalizeOptionalString(params.command.from);
}
function listPrivateCommandRouteCandidateChannels(originChannel) {
	const plugins = [getLoadedChannelPlugin(originChannel), ...listChannelPlugins()].filter((plugin) => Boolean(plugin?.id));
	const seen = /* @__PURE__ */ new Set();
	const candidates = [];
	for (const plugin of plugins) {
		const channel = normalizeOptionalString(plugin.id) ?? "";
		if (!channel || seen.has(channel)) continue;
		seen.add(channel);
		candidates.push({
			channel,
			plugin
		});
	}
	return candidates;
}
function resolveOwnerPreferenceIndex(params) {
	const owners = params.cfg.commands?.ownerAllowFrom;
	if (!Array.isArray(owners) || owners.length === 0) return Number.MAX_SAFE_INTEGER;
	const keys = buildPrivateCommandRouteOwnerKeys(params.target);
	const index = owners.findIndex((owner) => keys.has(normalizeLowercaseStringOrEmpty(String(owner))));
	return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}
function buildPrivateCommandRouteOwnerKeys(target) {
	const channel = normalizeLowercaseStringOrEmpty(target.channel);
	const to = normalizeLowercaseStringOrEmpty(target.to);
	const keys = /* @__PURE__ */ new Set();
	if (to) {
		keys.add(to);
		keys.add(`user:${to}`);
	}
	if (channel && to) {
		keys.add(`${channel}:${to}`);
		if (channel === "telegram") keys.add(`tg:${to}`);
	}
	return keys;
}
function sortPrivateCommandRouteTargets(params) {
	return params.targets.map((target, index) => ({
		target,
		index,
		ownerPreference: resolveOwnerPreferenceIndex({
			cfg: params.cfg,
			target
		}),
		originPreference: target.channel === params.originChannel ? 0 : 1
	})).toSorted((a, b) => {
		if (a.originPreference !== b.originPreference) return a.originPreference - b.originPreference;
		if (a.ownerPreference !== b.ownerPreference) return a.ownerPreference - b.ownerPreference;
		return a.index - b.index;
	}).map((entry) => entry.target);
}
function filterPrivateCommandRouteOwnerTargets(params) {
	return params.targets.filter((target) => resolveOwnerPreferenceIndex({
		cfg: params.cfg,
		target
	}) !== Number.MAX_SAFE_INTEGER);
}
function dedupePrivateCommandRouteTargets(targets) {
	const seen = /* @__PURE__ */ new Set();
	const deduped = [];
	for (const target of targets) {
		const key = [
			target.channel,
			target.to,
			target.accountId ?? "",
			target.threadId == null ? "" : String(target.threadId)
		].join("\0");
		if (seen.has(key)) continue;
		seen.add(key);
		deduped.push(target);
	}
	return deduped;
}
//#endregion
//#region src/auto-reply/reply/commands-diagnostics.ts
const DIAGNOSTICS_COMMAND = "/diagnostics";
const CODEX_DIAGNOSTICS_COMMAND = "/codex diagnostics";
const DIAGNOSTICS_DOCS_URL = "https://docs.openclaw.ai/gateway/diagnostics";
const GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL = "openclaw gateway diagnostics export --json";
const DIAGNOSTICS_EXEC_SCOPE_KEY = "chat:diagnostics";
const DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE = "I couldn't find a private owner approval route for diagnostics. Run /diagnostics from an owner DM so the sensitive diagnostics details are not posted in this chat.";
const DIAGNOSTICS_PRIVATE_ROUTE_ACK = "Diagnostics are sensitive. I sent the diagnostics details and approval prompts to the owner privately.";
const defaultDiagnosticsCommandDeps = {
	createExecTool,
	resolvePrivateDiagnosticsTargets: resolvePrivateDiagnosticsTargetsForCommand,
	deliverPrivateDiagnosticsReply
};
function createDiagnosticsCommandHandler(deps = {}) {
	const resolvedDeps = {
		...defaultDiagnosticsCommandDeps,
		...deps
	};
	return async (params, allowTextCommands) => await handleDiagnosticsCommandWithDeps(resolvedDeps, params, allowTextCommands);
}
const handleDiagnosticsCommand = createDiagnosticsCommandHandler();
async function handleDiagnosticsCommandWithDeps(deps, params, allowTextCommands) {
	if (!allowTextCommands) return null;
	const args = parseDiagnosticsArgs(params.command.commandBodyNormalized);
	if (args == null) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /diagnostics from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	if (isCodexDiagnosticsConfirmationAction(args)) {
		const codexResult = await executeCodexDiagnosticsAddon(params, args);
		const reply = codexResult ? rewriteCodexDiagnosticsResult(codexResult) : { text: "No Codex diagnostics confirmation handler is available for this session." };
		if (params.isGroup) return await deliverGroupDiagnosticsReplyPrivately(deps, params, reply);
		return {
			shouldContinue: false,
			reply
		};
	}
	if (params.isGroup) {
		const targets = await deps.resolvePrivateDiagnosticsTargets(params);
		if (targets.length === 0) return {
			shouldContinue: false,
			reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE }
		};
		const privateTarget = targets[0];
		if (!privateTarget) return {
			shouldContinue: false,
			reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE }
		};
		const privateReply = await buildDiagnosticsReply(deps, params, args, {
			diagnosticsPrivateRouted: true,
			privateApprovalTarget: privateTarget
		});
		if (!privateReply) return {
			shouldContinue: false,
			reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_ACK }
		};
		return {
			shouldContinue: false,
			reply: { text: await deps.deliverPrivateDiagnosticsReply({
				commandParams: params,
				targets: [privateTarget],
				reply: privateReply
			}) ? DIAGNOSTICS_PRIVATE_ROUTE_ACK : DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE }
		};
	}
	const reply = await buildDiagnosticsReply(deps, params, args);
	return reply ? {
		shouldContinue: false,
		reply
	} : { shouldContinue: false };
}
async function buildDiagnosticsReply(deps, params, args, options = {}) {
	const gatewayApproval = await requestGatewayDiagnosticsExportApproval(deps, params, options, await buildCodexDiagnosticsApprovalIntegration(params, args, options));
	if (gatewayApproval.status === "pending") return;
	return gatewayApproval.reply;
}
async function deliverGroupDiagnosticsReplyPrivately(deps, params, reply) {
	const targets = await deps.resolvePrivateDiagnosticsTargets(params);
	if (targets.length === 0) return {
		shouldContinue: false,
		reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE }
	};
	const privateTarget = targets[0];
	if (!privateTarget) return {
		shouldContinue: false,
		reply: { text: DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE }
	};
	return {
		shouldContinue: false,
		reply: { text: await deps.deliverPrivateDiagnosticsReply({
			commandParams: params,
			targets: [privateTarget],
			reply
		}) ? DIAGNOSTICS_PRIVATE_ROUTE_ACK : DIAGNOSTICS_PRIVATE_ROUTE_UNAVAILABLE }
	};
}
function parseDiagnosticsArgs(commandBody) {
	const trimmed = commandBody.trim();
	if (trimmed === DIAGNOSTICS_COMMAND) return "";
	if (trimmed.startsWith(`${DIAGNOSTICS_COMMAND} `)) return trimmed.slice(13).trim();
	if (trimmed.startsWith(`${DIAGNOSTICS_COMMAND}:`)) return trimmed.slice(13).trim();
}
function buildDiagnosticsPreamble() {
	return ["Diagnostics can include sensitive local logs and host-level runtime metadata.", `Treat diagnostics bundles like secrets and review what they contain before sharing: ${DIAGNOSTICS_DOCS_URL}`];
}
function buildDiagnosticsApprovalWarning(codexApprovalText) {
	const lines = buildDiagnosticsPreamble();
	if (codexApprovalText) lines.push("", codexApprovalText);
	return lines.join("\n");
}
async function resolvePrivateDiagnosticsTargetsForCommand(params) {
	return await resolvePrivateCommandRouteTargets({
		commandParams: params,
		request: buildDiagnosticsApprovalRequest(params)
	});
}
function buildDiagnosticsApprovalRequest(params) {
	const now = Date.now();
	const agentId = params.agentId ?? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	return {
		id: "diagnostics-private-route",
		request: {
			command: buildGatewayDiagnosticsExportJsonCommand(),
			agentId,
			...params.sessionKey ? { sessionKey: params.sessionKey } : {},
			turnSourceChannel: params.command.channel,
			turnSourceTo: readCommandDeliveryTarget(params) ?? null,
			turnSourceAccountId: params.ctx.AccountId ?? null,
			turnSourceThreadId: readCommandMessageThreadId(params) ?? null
		},
		createdAtMs: now,
		expiresAtMs: now + 5 * 6e4
	};
}
function buildGatewayDiagnosticsExportJsonCommand() {
	return buildCurrentOpenClawCliCommand([
		"gateway",
		"diagnostics",
		"export",
		"--json"
	]);
}
async function deliverPrivateDiagnosticsReply(params) {
	return await deliverPrivateCommandReply(params);
}
async function requestGatewayDiagnosticsExportApproval(deps, params, options = {}, codexDiagnostics = {}) {
	const timeoutSec = params.cfg.tools?.exec?.timeoutSec;
	const agentId = params.agentId ?? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	const messageThreadId = readCommandMessageThreadId(params);
	const command = buildGatewayDiagnosticsExportJsonCommand();
	try {
		const result = await deps.createExecTool({
			host: "gateway",
			security: "allowlist",
			ask: "always",
			trigger: "diagnostics",
			scopeKey: DIAGNOSTICS_EXEC_SCOPE_KEY,
			approvalWarningText: buildDiagnosticsApprovalWarning(codexDiagnostics.approvalText),
			approvalFollowup: codexDiagnostics.approvalFollowup,
			approvalFollowupMode: "direct",
			allowBackground: true,
			timeoutSec,
			cwd: params.workspaceDir,
			agentId,
			sessionKey: params.sessionKey,
			mainKey: params.cfg.session?.mainKey,
			sessionScope: params.cfg.session?.scope,
			messageProvider: options.privateApprovalTarget?.channel ?? params.command.channel,
			currentChannelId: options.privateApprovalTarget?.to ?? readCommandDeliveryTarget(params),
			currentThreadTs: options.privateApprovalTarget ? options.privateApprovalTarget.threadId == null ? void 0 : String(options.privateApprovalTarget.threadId) : messageThreadId,
			accountId: options.privateApprovalTarget ? options.privateApprovalTarget.accountId ?? void 0 : params.ctx.AccountId ?? void 0,
			notifyOnExit: params.cfg.tools?.exec?.notifyOnExit,
			notifyOnExitEmptySuccess: params.cfg.tools?.exec?.notifyOnExitEmptySuccess
		}).execute("chat-diagnostics-gateway-export", {
			command,
			security: "allowlist",
			ask: "always",
			background: true,
			timeout: timeoutSec
		});
		if (result.details?.status === "approval-pending") return { status: "pending" };
		const codexFollowupText = result.details?.status === "completed" || result.details?.status === "failed" ? await codexDiagnostics.approvalFollowup?.() : void 0;
		const lines = buildDiagnosticsPreamble();
		lines.push("", `Local Gateway bundle: requested \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL}\` through exec approval. Approve once to create the bundle; do not use allow-all for diagnostics.`, formatExecToolResultForDiagnostics(result));
		if (codexFollowupText) lines.push("", codexFollowupText);
		return {
			status: "reply",
			reply: { text: lines.join("\n") }
		};
	} catch (error) {
		const lines = buildDiagnosticsPreamble();
		lines.push("", `Local Gateway bundle: could not request exec approval for \`${GATEWAY_DIAGNOSTICS_EXPORT_JSON_LABEL}\`.`, formatExecDiagnosticsText(formatErrorMessage(error)));
		return {
			status: "reply",
			reply: { text: lines.join("\n") }
		};
	}
}
async function buildCodexDiagnosticsApprovalIntegration(params, args, options = {}) {
	const hasHarnessMetadata = hasCodexHarnessMetadata(params);
	const previewResult = await executeCodexDiagnosticsAddon(params, args, {
		...options,
		diagnosticsPreviewOnly: true
	});
	if (!previewResult) return hasHarnessMetadata ? { approvalText: "OpenAI Codex harness: selected for this session, but the bundled Codex diagnostics command is not registered." } : void 0;
	const preview = rewriteCodexDiagnosticsResult(previewResult);
	if (!hasHarnessMetadata && isCodexDiagnosticsUnavailableText(preview.text)) return;
	return {
		approvalText: preview.text ? ["OpenAI Codex harness:", preview.text].join("\n") : void 0,
		approvalFollowup: async () => {
			const uploadResult = await executeCodexDiagnosticsAddon(params, args, {
				...options,
				diagnosticsUploadApproved: true
			});
			if (!uploadResult) return hasHarnessMetadata ? "OpenAI Codex harness: selected for this session, but the bundled Codex diagnostics command is not registered." : void 0;
			const uploaded = rewriteCodexDiagnosticsResult(uploadResult);
			if (!hasHarnessMetadata && isCodexDiagnosticsUnavailableText(uploaded.text)) return;
			return uploaded.text ? ["OpenAI Codex harness:", uploaded.text].join("\n") : void 0;
		}
	};
}
function isCodexDiagnosticsConfirmationAction(args) {
	const [action, token] = args.trim().split(/\s+/, 2);
	const normalized = action?.toLowerCase();
	return Boolean(token && (normalized === "confirm" || normalized === "--confirm" || normalized === "cancel" || normalized === "--cancel"));
}
function hasCodexHarnessMetadata(params) {
	if ((params.sessionStore?.[params.sessionKey] ?? params.sessionEntry)?.agentHarnessId === "codex") return true;
	return Object.values(params.sessionStore ?? {}).some((entry) => entry?.agentHarnessId === "codex");
}
function isCodexDiagnosticsUnavailableText(text) {
	return text?.startsWith("No Codex thread is attached to this OpenClaw session yet.") === true || text?.startsWith("Cannot send Codex diagnostics because this command did not include an OpenClaw session file.") === true;
}
async function executeCodexDiagnosticsAddon(params, args, options = {}) {
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const commandBody = args ? `${CODEX_DIAGNOSTICS_COMMAND} ${args}` : CODEX_DIAGNOSTICS_COMMAND;
	const match = matchPluginCommand(commandBody);
	if (!match || match.command.pluginId !== "codex") return;
	return await executePluginCommand({
		command: match.command,
		args: match.args,
		senderId: params.command.senderId,
		channel: params.command.channel,
		channelId: params.command.channelId,
		isAuthorizedSender: params.command.isAuthorizedSender,
		senderIsOwner: params.command.senderIsOwner,
		gatewayClientScopes: params.ctx.GatewayClientScopes,
		sessionKey: params.sessionKey,
		sessionId: targetSessionEntry?.sessionId,
		sessionFile: targetSessionEntry?.sessionFile,
		commandBody,
		config: params.cfg,
		from: params.command.from,
		to: params.command.to,
		accountId: params.ctx.AccountId ?? void 0,
		messageThreadId: typeof params.ctx.MessageThreadId === "string" || typeof params.ctx.MessageThreadId === "number" ? params.ctx.MessageThreadId : void 0,
		threadParentId: normalizeOptionalString(params.ctx.ThreadParentId),
		diagnosticsSessions: buildCodexDiagnosticsSessions(params),
		...options.diagnosticsUploadApproved === void 0 ? {} : { diagnosticsUploadApproved: options.diagnosticsUploadApproved },
		...options.diagnosticsPreviewOnly === void 0 ? {} : { diagnosticsPreviewOnly: options.diagnosticsPreviewOnly },
		...options.diagnosticsPrivateRouted === void 0 ? {} : { diagnosticsPrivateRouted: options.diagnosticsPrivateRouted }
	});
}
function buildCodexDiagnosticsSessions(params) {
	const sessions = /* @__PURE__ */ new Map();
	const activeEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	if (activeEntry) sessions.set(params.sessionKey, activeEntry);
	for (const [sessionKey, entry] of Object.entries(params.sessionStore ?? {})) if (entry) sessions.set(sessionKey, entry);
	return Array.from(sessions.entries()).filter(([, entry]) => Boolean(entry.sessionFile)).map(([sessionKey, entry]) => ({
		sessionKey,
		sessionId: entry.sessionId,
		sessionFile: entry.sessionFile,
		agentHarnessId: entry.agentHarnessId,
		channel: resolveDiagnosticsSessionChannel(entry, params, sessionKey),
		channelId: resolveDiagnosticsSessionChannelId(entry, params, sessionKey),
		accountId: normalizeOptionalString(entry.deliveryContext?.accountId) ?? normalizeOptionalString(entry.origin?.accountId) ?? normalizeOptionalString(entry.lastAccountId) ?? (sessionKey === params.sessionKey ? params.ctx.AccountId ?? void 0 : void 0),
		messageThreadId: entry.deliveryContext?.threadId ?? entry.origin?.threadId ?? entry.lastThreadId ?? (sessionKey === params.sessionKey && (typeof params.ctx.MessageThreadId === "string" || typeof params.ctx.MessageThreadId === "number") ? params.ctx.MessageThreadId : void 0),
		threadParentId: sessionKey === params.sessionKey ? normalizeOptionalString(params.ctx.ThreadParentId) : void 0
	}));
}
function resolveDiagnosticsSessionChannel(entry, params, sessionKey) {
	return normalizeOptionalString(entry.deliveryContext?.channel) ?? normalizeOptionalString(entry.origin?.provider) ?? normalizeOptionalString(entry.channel) ?? normalizeOptionalString(entry.lastChannel) ?? (sessionKey === params.sessionKey ? params.command.channel : void 0);
}
function resolveDiagnosticsSessionChannelId(entry, params, sessionKey) {
	return normalizeOptionalString(entry.origin?.nativeChannelId) ?? (sessionKey === params.sessionKey ? params.command.channelId : void 0);
}
function formatExecToolResultForDiagnostics(result) {
	const text = result.content?.map((chunk) => chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : "").filter(Boolean).join("\n").trim();
	if (text) return formatExecDiagnosticsText(text);
	const details = result.details;
	if (details?.status === "approval-pending") {
		const decisions = details.allowedDecisions?.join(", ") || "allow-once, deny";
		return formatExecDiagnosticsText(`Exec approval pending (${details.approvalSlug}). Allowed decisions: ${decisions}.`);
	}
	if (details?.status === "running") return formatExecDiagnosticsText(`Gateway diagnostics export is running (exec session ${details.sessionId}).`);
	if (details?.status === "completed" || details?.status === "failed") return formatExecDiagnosticsText(details.aggregated);
	return "(no exec details returned)";
}
function formatExecDiagnosticsText(text) {
	const trimmed = text.trim();
	if (!trimmed) return "(no exec output)";
	return trimmed;
}
function rewriteCodexDiagnosticsResult(result) {
	const { continueAgent: _continueAgent, ...reply } = result;
	return {
		...reply,
		...reply.text ? { text: rewriteCodexDiagnosticsCommandPrefix(reply.text) } : {},
		...reply.interactive ? { interactive: rewriteInteractive(reply.interactive) } : {}
	};
}
function rewriteInteractive(interactive) {
	return { blocks: interactive.blocks.map((block) => {
		if (block.type === "buttons") return {
			...block,
			buttons: block.buttons.map((button) => ({
				...button,
				...button.value ? { value: rewriteCodexDiagnosticsCommandPrefix(button.value) } : {}
			}))
		};
		if (block.type === "select") return {
			...block,
			options: block.options.map((option) => ({
				...option,
				value: rewriteCodexDiagnosticsCommandPrefix(option.value)
			}))
		};
		return block;
	}) };
}
function rewriteCodexDiagnosticsCommandPrefix(value) {
	return value.replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} confirm`, `${DIAGNOSTICS_COMMAND} confirm`).replaceAll(`${CODEX_DIAGNOSTICS_COMMAND} cancel`, `${DIAGNOSTICS_COMMAND} cancel`);
}
//#endregion
//#region src/auto-reply/reply/commands-session-store.ts
async function persistSessionEntry(params) {
	if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) return false;
	params.sessionEntry.updatedAt = Date.now();
	params.sessionStore[params.sessionKey] = params.sessionEntry;
	if (params.storePath) await updateSessionStore(params.storePath, (store) => {
		store[params.sessionKey] = params.sessionEntry;
	});
	return true;
}
async function persistAbortTargetEntry(params) {
	const { entry, key, sessionStore, storePath, abortCutoff } = params;
	if (!entry || !key || !sessionStore) return false;
	entry.abortedLastRun = true;
	applyAbortCutoffToSessionEntry(entry, abortCutoff);
	entry.updatedAt = Date.now();
	sessionStore[key] = entry;
	if (storePath) await updateSessionStore(storePath, (store) => {
		const nextEntry = store[key] ?? entry;
		if (!nextEntry) return;
		nextEntry.abortedLastRun = true;
		applyAbortCutoffToSessionEntry(nextEntry, abortCutoff);
		nextEntry.updatedAt = Date.now();
		store[key] = nextEntry;
	});
	return true;
}
//#endregion
//#region src/auto-reply/reply/commands-dock.ts
const DOCK_KEY_PREFIX = "dock:";
function resolveDockCommandTarget(params) {
	const resolved = resolveTextCommand(params.command.commandBodyNormalized, params.cfg);
	if (!resolved?.command.key.startsWith(DOCK_KEY_PREFIX)) return null;
	if (resolved.command.category !== "docks") return null;
	return normalizeLowercaseStringOrEmpty(resolved.command.key.slice(5)) || null;
}
function resolveTargetChannelAccountId(params, targetChannel) {
	const plugin = getActivePluginChannelRegistry()?.channels.find((entry) => normalizeLowercaseStringOrEmpty(entry.plugin.id) === targetChannel)?.plugin;
	return normalizeOptionalString(plugin?.config.defaultAccountId?.(params.cfg)) || "default";
}
function isDirectDockSource(params) {
	return normalizeLowercaseStringOrEmpty(params.ctx.ChatType) === "direct";
}
function collectSourcePeerCandidates(params) {
	return [
		params.ctx.NativeDirectUserId,
		params.ctx.SenderId,
		params.command.senderId,
		params.ctx.SenderE164,
		params.ctx.SenderUsername,
		params.ctx.From,
		params.command.from,
		params.ctx.OriginatingTo,
		params.ctx.To
	].map((value) => normalizeOptionalString(value)).filter((value) => Boolean(value));
}
function buildSourceIdentityCandidates(params, sourceChannel) {
	const candidates = /* @__PURE__ */ new Set();
	for (const peerId of collectSourcePeerCandidates(params)) {
		const raw = normalizeLowercaseStringOrEmpty(peerId);
		if (raw) candidates.add(raw);
		if (sourceChannel) {
			const scoped = normalizeLowercaseStringOrEmpty(`${sourceChannel}:${peerId}`);
			if (scoped) candidates.add(scoped);
		}
	}
	return candidates;
}
function resolveLinkedDockTarget(params) {
	if (!params.identityLinks || params.sourceCandidates.size === 0) return null;
	const targetPrefix = `${params.targetChannel}:`;
	for (const ids of Object.values(params.identityLinks)) {
		if (!Array.isArray(ids)) continue;
		if (!ids.map((id) => normalizeLowercaseStringOrEmpty(id)).filter(Boolean).some((id) => params.sourceCandidates.has(id))) continue;
		for (const id of ids) {
			const trimmed = normalizeOptionalString(id);
			if (!trimmed) continue;
			if (!normalizeLowercaseStringOrEmpty(trimmed).startsWith(targetPrefix)) continue;
			return { peerId: trimmed.slice(targetPrefix.length).trim() };
		}
	}
	return null;
}
const handleDockCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const targetChannel = resolveDockCommandTarget(params);
	if (!targetChannel) return null;
	if (!params.command.isAuthorizedSender) return { shouldContinue: false };
	const sourceChannel = resolveCommandSurfaceChannel(params);
	if (sourceChannel === targetChannel) return {
		shouldContinue: false,
		reply: { text: `Already docked to ${targetChannel}.` }
	};
	if (!isDirectDockSource(params)) return {
		shouldContinue: false,
		reply: { text: `Cannot dock to ${targetChannel}: docking is only available from direct chats.` }
	};
	const sourceCandidates = buildSourceIdentityCandidates(params, sourceChannel);
	if (sourceCandidates.size === 0) return {
		shouldContinue: false,
		reply: { text: `Cannot dock to ${targetChannel}: sender id is unavailable.` }
	};
	const target = resolveLinkedDockTarget({
		identityLinks: params.cfg.session?.identityLinks,
		sourceCandidates,
		targetChannel
	});
	if (!target?.peerId) return {
		shouldContinue: false,
		reply: { text: `Cannot dock to ${targetChannel}: add this sender and a ${targetChannel}:... peer to session.identityLinks.` }
	};
	const sessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	if (!sessionEntry || !params.sessionStore || !params.sessionKey) return {
		shouldContinue: false,
		reply: { text: `Cannot dock to ${targetChannel}: no active session entry was found.` }
	};
	sessionEntry.lastChannel = targetChannel;
	sessionEntry.lastTo = target.peerId;
	sessionEntry.lastAccountId = resolveTargetChannelAccountId(params, targetChannel);
	params.sessionEntry = sessionEntry;
	if (!await persistSessionEntry(params)) return {
		shouldContinue: false,
		reply: { text: `Cannot dock to ${targetChannel}: session route could not be saved.` }
	};
	return {
		shouldContinue: false,
		reply: { text: `Docked replies to ${targetChannel}.` }
	};
};
//#endregion
//#region src/auto-reply/reply/commands-export-common.ts
const MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS = 512;
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function parseExportCommandOutputPath(commandBodyNormalized, aliases) {
	const normalized = commandBodyNormalized.trim();
	if (aliases.some((alias) => normalized === `/${alias}`)) return {};
	const aliasPattern = aliases.map(escapeRegExp).join("|");
	const outputPath = normalized.replace(new RegExp(`^/(${aliasPattern})\\s*`), "").trim().split(/\s+/).find((part) => !part.startsWith("-"));
	if (outputPath && outputPath.length > MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS) return { error: `❌ Output path is too long. Keep it at ${MAX_EXPORT_COMMAND_OUTPUT_PATH_CHARS} characters or less.` };
	return { outputPath };
}
function resolveExportCommandSessionTarget(params) {
	const targetAgentId = resolveAgentIdFromSessionKey(params.sessionKey) || params.agentId;
	const storePath = params.storePath ?? resolveDefaultSessionStorePath(targetAgentId);
	const entry = loadSessionStore(storePath, { skipCache: true })[params.sessionKey];
	if (!entry?.sessionId) return { text: `❌ Session not found: ${params.sessionKey}` };
	try {
		return {
			entry,
			sessionFile: resolveSessionFilePath(entry.sessionId, entry, resolveSessionFilePathOptions({
				agentId: targetAgentId,
				storePath
			}))
		};
	} catch (err) {
		return { text: `❌ Failed to resolve session file: ${formatErrorMessage(err)}` };
	}
}
function isReplyPayload(value) {
	return "text" in value;
}
//#endregion
//#region src/auto-reply/reply/commands-export-session.ts
const EXPORT_HTML_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "export-html");
async function loadTemplate(fileName) {
	return await fs$1.readFile(path.join(EXPORT_HTML_DIR, fileName), "utf-8");
}
function replaceHtmlPlaceholder(template, name, value) {
	let replaced = false;
	const placeholder = new RegExp(`(<(?:script|style)\\b(?=[^>]*\\bdata-openclaw-export-placeholder="${name}")[^>]*>)(</(?:script|style)>)`);
	const next = template.replace(placeholder, (_match, openTag, closeTag) => {
		replaced = true;
		return `${openTag.replace(/\sdata-openclaw-export-placeholder="[^"]*"/, "")}${value}${closeTag}`;
	});
	if (!replaced) throw new Error(`Export HTML template missing ${name} placeholder`);
	return next;
}
async function generateHtml(sessionData) {
	const [template, templateCss, templateJs, markedJs, hljsJs] = await Promise.all([
		loadTemplate("template.html"),
		loadTemplate("template.css"),
		loadTemplate("template.js"),
		loadTemplate(path.join("vendor", "marked.min.js")),
		loadTemplate(path.join("vendor", "highlight.min.js"))
	]);
	const themeVars = `
    --cyan: #00d7ff;
    --blue: #5f87ff;
    --green: #b5bd68;
    --red: #cc6666;
    --yellow: #ffff00;
    --gray: #808080;
    --dimGray: #666666;
    --darkGray: #505050;
    --accent: #8abeb7;
    --selectedBg: #3a3a4a;
    --userMsgBg: #343541;
    --toolPendingBg: #282832;
    --toolSuccessBg: #283228;
    --toolErrorBg: #3c2828;
    --customMsgBg: #2d2838;
    --text: #e0e0e0;
    --dim: #666666;
    --muted: #808080;
    --border: #5f87ff;
    --borderAccent: #00d7ff;
    --borderMuted: #505050;
    --success: #b5bd68;
    --error: #cc6666;
    --warning: #ffff00;
    --thinkingText: #808080;
    --userMessageBg: #343541;
    --userMessageText: #e0e0e0;
    --customMessageBg: #2d2838;
    --customMessageText: #e0e0e0;
    --customMessageLabel: #9575cd;
    --toolTitle: #e0e0e0;
    --toolOutput: #808080;
    --mdHeading: #f0c674;
    --mdLink: #81a2be;
    --mdLinkUrl: #666666;
    --mdCode: #8abeb7;
    --mdCodeBlock: #b5bd68;
  `;
	const bodyBg = "#1e1e28";
	const containerBg = "#282832";
	const infoBg = "#343541";
	const sessionDataBase64 = Buffer.from(JSON.stringify(sessionData)).toString("base64");
	return [
		["CSS", templateCss.replace("/* {{THEME_VARS}} */", themeVars.trim()).replace("/* {{BODY_BG_DECL}} */", `--body-bg: ${bodyBg};`).replace("/* {{CONTAINER_BG_DECL}} */", `--container-bg: ${containerBg};`).replace("/* {{INFO_BG_DECL}} */", `--info-bg: ${infoBg};`)],
		["SESSION_DATA", sessionDataBase64],
		["MARKED_JS", markedJs],
		["HIGHLIGHT_JS", hljsJs],
		["JS", templateJs]
	].reduce((html, [name, value]) => replaceHtmlPlaceholder(html, name, value), template);
}
function addCollisionSuffix(filePath, suffix) {
	const ext = path.extname(filePath);
	const baseName = path.basename(filePath, ext);
	return path.join(path.dirname(filePath), `${baseName}-${suffix}${ext}`);
}
async function writeNewDefaultExportFile(filePath, html) {
	for (let suffix = 1; suffix <= 100; suffix++) {
		const candidate = suffix === 1 ? filePath : addCollisionSuffix(filePath, suffix);
		try {
			await fs$1.writeFile(candidate, html, {
				encoding: "utf-8",
				flag: "wx"
			});
			return candidate;
		} catch (error) {
			if (typeof error === "object" && error && "code" in error && error.code === "EEXIST") continue;
			throw error;
		}
	}
	throw new Error(`Could not find an unused export filename near ${filePath}`);
}
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isSessionFileEntry(value) {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type !== "message") return true;
	const message = value.message;
	return isRecord(message) && typeof message.role === "string";
}
function parseSessionEntriesWithWarnings(content) {
	const entries = [];
	const warnings = [];
	const rows = content.split(/\r?\n/u);
	for (const [index, rawLine] of rows.entries()) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line);
			if (!isSessionFileEntry(parsed)) {
				warnings.push({
					code: "invalid-session-row",
					row: index + 1
				});
				continue;
			}
			entries.push(parsed);
		} catch {
			warnings.push({
				code: "invalid-session-json",
				row: index + 1
			});
		}
	}
	return {
		entries,
		warnings
	};
}
function summarizeSessionExportWarnings(warnings) {
	const summaries = /* @__PURE__ */ new Map();
	for (const warning of warnings) {
		const summary = summaries.get(warning.code);
		if (summary) {
			summary.count += 1;
			if (summary.rows.length < 20) summary.rows.push(warning.row);
			continue;
		}
		summaries.set(warning.code, {
			code: warning.code,
			count: 1,
			rows: [warning.row]
		});
	}
	return [...summaries.values()];
}
function formatSkippedRows(count) {
	return `${count.toLocaleString()} malformed transcript ${count === 1 ? "row" : "rows"}`;
}
function formatSessionExportWarning(summary) {
	const rows = summary.rows.length > 0 ? ` rows ${summary.rows.join(", ")}` : "";
	const verb = summary.count === 1 ? "was" : "were";
	switch (summary.code) {
		case "invalid-session-json": return `⚠️ Skipped ${formatSkippedRows(summary.count)} that ${verb} not valid JSON.${rows}`;
		case "invalid-session-row": return summary.count === 1 ? `⚠️ Skipped ${formatSkippedRows(summary.count)} that was not a session entry.${rows}` : `⚠️ Skipped ${formatSkippedRows(summary.count)} that were not session entries.${rows}`;
	}
	return summary.code;
}
async function readSessionDataFromTranscript(sessionFile) {
	const { entries: fileEntries, warnings } = parseSessionEntriesWithWarnings(await fs$1.readFile(sessionFile, "utf-8"));
	migrateSessionEntries(fileEntries);
	const header = fileEntries.find((entry) => entry.type === "session") ?? null;
	const entries = fileEntries.filter((entry) => entry.type !== "session");
	const lastEntry = entries.at(-1);
	return {
		header,
		entries,
		leafId: typeof lastEntry?.id === "string" ? lastEntry.id : null,
		warnings: summarizeSessionExportWarnings(warnings)
	};
}
async function buildExportSessionReply(params) {
	const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, ["export-session", "export"]);
	if (args.error) return { text: args.error };
	const sessionTarget = resolveExportCommandSessionTarget(params);
	if (isReplyPayload(sessionTarget)) return sessionTarget;
	const { entry, sessionFile } = sessionTarget;
	if (!await pathExists(sessionFile)) return { text: `❌ Session file not found: ${sessionFile}` };
	const { entries, header, leafId, warnings } = await readSessionDataFromTranscript(sessionFile);
	const { systemPrompt, tools } = await resolveCommandsSystemPromptBundle({
		...params,
		sessionEntry: entry
	});
	const html = await generateHtml({
		header,
		entries,
		leafId,
		systemPrompt,
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters
		}))
	});
	const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const defaultFileName = `openclaw-session-${entry.sessionId.slice(0, 8)}-${timestamp}.html`;
	let outputPath = args.outputPath ? path.resolve(args.outputPath.startsWith("~") ? args.outputPath.replace("~", process.env.HOME ?? "") : args.outputPath) : path.join(params.workspaceDir, defaultFileName);
	const outputDir = path.dirname(outputPath);
	await fs$1.mkdir(outputDir, { recursive: true });
	if (args.outputPath) await fs$1.writeFile(outputPath, html, "utf-8");
	else outputPath = await writeNewDefaultExportFile(outputPath, html);
	const relativePath = path.relative(params.workspaceDir, outputPath);
	return { text: [
		"✅ Session exported!",
		"",
		`📄 File: ${relativePath.startsWith("..") ? outputPath : relativePath}`,
		`📊 Entries: ${entries.length}`,
		...warnings.map(formatSessionExportWarning),
		`🧠 System prompt: ${systemPrompt.length.toLocaleString()} chars`,
		`🔧 Tools: ${tools.length}`
	].join("\n") };
}
//#endregion
//#region src/auto-reply/reply/commands-export-trajectory.ts
const EXPORT_TRAJECTORY_DOCS_URL = "https://docs.openclaw.ai/tools/trajectory";
const EXPORT_TRAJECTORY_EXEC_SCOPE_KEY = "chat:export-trajectory";
const MAX_TRAJECTORY_EXPORT_ENCODED_REQUEST_CHARS = 8192;
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE = "I couldn't find a private owner approval route for the trajectory export. Run /export-trajectory from an owner DM so the sensitive trajectory bundle is not posted in this chat.";
const EXPORT_TRAJECTORY_PRIVATE_ROUTE_ACK = "Trajectory exports are sensitive. I sent the export request and approval prompt to the owner privately.";
const defaultExportTrajectoryCommandDeps = {
	createExecTool,
	resolvePrivateTrajectoryTargets: resolvePrivateTrajectoryTargetsForCommand,
	deliverPrivateTrajectoryReply
};
async function buildExportTrajectoryCommandReply(params, deps = {}) {
	const resolvedDeps = {
		...defaultExportTrajectoryCommandDeps,
		...deps
	};
	const args = parseExportCommandOutputPath(params.command.commandBodyNormalized, ["export-trajectory", "trajectory"]);
	if (args.error) return { text: args.error };
	let request;
	try {
		request = buildTrajectoryExportExecRequest(params, args.outputPath);
	} catch (error) {
		return { text: `❌ Failed to prepare trajectory export request: ${formatErrorMessage(error)}` };
	}
	if (params.isGroup) {
		const targets = await resolvedDeps.resolvePrivateTrajectoryTargets(params, request);
		if (targets.length === 0) return { text: EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE };
		const privateTarget = targets[0];
		if (!privateTarget) return { text: EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE };
		const privateReply = await buildExportTrajectoryApprovalReply(resolvedDeps, params, request, { privateApprovalTarget: privateTarget });
		return { text: await resolvedDeps.deliverPrivateTrajectoryReply({
			commandParams: params,
			targets: [privateTarget],
			reply: privateReply
		}) ? EXPORT_TRAJECTORY_PRIVATE_ROUTE_ACK : EXPORT_TRAJECTORY_PRIVATE_ROUTE_UNAVAILABLE };
	}
	return await buildExportTrajectoryApprovalReply(resolvedDeps, params, request);
}
async function buildExportTrajectoryApprovalReply(deps, params, request, options = {}) {
	return { text: [
		"Trajectory exports can include prompts, model messages, tool schemas, tool results, runtime events, and local paths.",
		`Treat trajectory bundles like secrets and review them before sharing: ${EXPORT_TRAJECTORY_DOCS_URL}`,
		"",
		formatTrajectoryExportRequestDetails(request.request),
		"",
		await requestTrajectoryExportApproval(deps, params, request, options)
	].join("\n") };
}
async function resolvePrivateTrajectoryTargetsForCommand(params, request) {
	return await resolvePrivateCommandRouteTargets({
		commandParams: params,
		request: buildTrajectoryExportApprovalRequest(params, request)
	});
}
async function deliverPrivateTrajectoryReply(params) {
	return await deliverPrivateCommandReply(params);
}
function buildTrajectoryExportApprovalRequest(params, request) {
	const now = Date.now();
	const agentId = params.agentId ?? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	return {
		id: "trajectory-export-private-route",
		request: {
			command: request.command,
			commandArgv: request.argv,
			agentId,
			...params.sessionKey ? { sessionKey: params.sessionKey } : {},
			turnSourceChannel: params.command.channel,
			turnSourceTo: readCommandDeliveryTarget(params) ?? null,
			turnSourceAccountId: params.ctx.AccountId ?? null,
			turnSourceThreadId: readCommandMessageThreadId(params) ?? null
		},
		createdAtMs: now,
		expiresAtMs: now + 5 * 6e4
	};
}
async function requestTrajectoryExportApproval(deps, params, request, options = {}) {
	const timeoutSec = params.cfg.tools?.exec?.timeoutSec;
	const agentId = params.agentId ?? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	const messageThreadId = readCommandMessageThreadId(params);
	try {
		const result = await deps.createExecTool({
			host: "gateway",
			security: "allowlist",
			ask: "always",
			trigger: "export-trajectory",
			scopeKey: EXPORT_TRAJECTORY_EXEC_SCOPE_KEY,
			allowBackground: true,
			timeoutSec,
			cwd: params.workspaceDir,
			agentId,
			sessionKey: params.sessionKey,
			mainKey: params.cfg.session?.mainKey,
			sessionScope: params.cfg.session?.scope,
			messageProvider: options.privateApprovalTarget?.channel ?? params.command.channel,
			currentChannelId: options.privateApprovalTarget?.to ?? readCommandDeliveryTarget(params),
			currentThreadTs: options.privateApprovalTarget ? options.privateApprovalTarget.threadId == null ? void 0 : String(options.privateApprovalTarget.threadId) : messageThreadId,
			accountId: options.privateApprovalTarget ? options.privateApprovalTarget.accountId ?? void 0 : params.ctx.AccountId ?? void 0,
			notifyOnExit: params.cfg.tools?.exec?.notifyOnExit,
			notifyOnExitEmptySuccess: params.cfg.tools?.exec?.notifyOnExitEmptySuccess
		}).execute("chat-export-trajectory", {
			command: request.command,
			security: "allowlist",
			ask: "always",
			background: true,
			timeout: timeoutSec
		});
		return [`Trajectory bundle: requested \`${request.displayCommand}\` through exec approval. Approve once to create the bundle; do not use allow-all for trajectory exports.`, formatExecToolResultForTrajectory(result)].join("\n");
	} catch (error) {
		return [`Trajectory bundle: could not request exec approval for \`${request.displayCommand}\`.`, formatExecTrajectoryText(formatErrorMessage(error))].join("\n");
	}
}
function formatExecToolResultForTrajectory(result) {
	const text = result.content?.map((chunk) => chunk.type === "text" && typeof chunk.text === "string" ? chunk.text : "").filter(Boolean).join("\n").trim();
	if (text) return formatExecTrajectoryText(text);
	const details = result.details;
	if (details?.status === "approval-pending") {
		const decisions = details.allowedDecisions?.join(", ") || "allow-once, deny";
		return formatExecTrajectoryText(`Exec approval pending (${details.approvalSlug}). Allowed decisions: ${decisions}.`);
	}
	if (details?.status === "running") return formatExecTrajectoryText(`Trajectory export is running (exec session ${details.sessionId}).`);
	if (details?.status === "completed" || details?.status === "failed") return formatExecTrajectoryText(details.aggregated);
	return "(no exec details returned)";
}
function formatExecTrajectoryText(text) {
	const trimmed = text.trim();
	if (!trimmed) return "(no exec output)";
	return trimmed;
}
function buildTrajectoryExportExecRequest(params, outputPath) {
	const request = {
		sessionKey: params.sessionKey,
		workspace: params.workspaceDir
	};
	if (outputPath) request.output = outputPath;
	if (params.storePath && params.storePath !== "(multiple)") request.store = params.storePath;
	if (params.agentId) request.agent = params.agentId;
	const encodedRequest = Buffer.from(JSON.stringify(request), "utf8").toString("base64url");
	if (encodedRequest.length > MAX_TRAJECTORY_EXPORT_ENCODED_REQUEST_CHARS) throw new Error("Encoded trajectory export request is too large");
	const args = [
		"sessions",
		"export-trajectory",
		"--request-json-base64",
		encodedRequest,
		"--json"
	];
	return {
		argv: buildCurrentOpenClawCliArgv(args),
		command: buildCurrentOpenClawCliCommand(args),
		displayCommand: ["openclaw", ...args].join(" "),
		encodedRequest,
		request
	};
}
function formatTrajectoryExportRequestDetails(request) {
	const lines = [
		`Session: ${request.sessionKey}`,
		`Workspace: ${request.workspace}`,
		`Output: ${request.output ?? "(default)"}`
	];
	if (request.store) lines.push(`Store: ${request.store}`);
	if (request.agent) lines.push(`Agent: ${request.agent}`);
	return lines.join("\n");
}
//#endregion
//#region src/auto-reply/reply/commands-whoami.ts
const handleWhoamiCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	if (params.command.commandBodyNormalized !== "/whoami") return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /whoami from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const senderId = params.ctx.SenderId ?? "";
	const senderUsername = params.ctx.SenderUsername ?? "";
	const lines = ["🧭 Identity", `Channel: ${params.command.channel}`];
	if (senderId) lines.push(`User id: ${senderId}`);
	if (senderUsername) {
		const handle = senderUsername.startsWith("@") ? senderUsername : `@${senderUsername}`;
		lines.push(`Username: ${handle}`);
	}
	if (params.ctx.ChatType === "group" && params.ctx.From) lines.push(`Chat: ${params.ctx.From}`);
	if (params.ctx.MessageThreadId != null) lines.push(`Thread: ${params.ctx.MessageThreadId}`);
	const allowFromSender = params.command.senderId ?? "";
	if (allowFromSender) lines.push(`AllowFrom: ${allowFromSender}`);
	return {
		shouldContinue: false,
		reply: { text: lines.join("\n") }
	};
};
//#endregion
//#region src/auto-reply/reply/commands-info.ts
const handleHelpCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	if (params.command.commandBodyNormalized !== "/help") return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /help from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	return {
		shouldContinue: false,
		reply: { text: buildHelpMessage(params.cfg) }
	};
};
const handleCommandsListCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	if (params.command.commandBodyNormalized !== "/commands") return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /commands from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const agentId = params.sessionKey ? resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	}) : params.agentId;
	const skillCommands = params.skillCommands ?? listSkillCommandsForAgents({
		cfg: params.cfg,
		agentIds: agentId ? [agentId] : void 0
	});
	const surface = params.ctx.Surface;
	const commandPlugin = surface ? getChannelPlugin(surface) : null;
	const paginated = buildCommandsMessagePaginated(params.cfg, skillCommands, {
		page: 1,
		surface
	});
	const channelData = commandPlugin?.commands?.buildCommandsListChannelData?.({
		currentPage: paginated.currentPage,
		totalPages: paginated.totalPages,
		agentId
	});
	if (channelData) return {
		shouldContinue: false,
		reply: {
			text: paginated.text,
			channelData
		}
	};
	return {
		shouldContinue: false,
		reply: { text: buildCommandsMessage(params.cfg, skillCommands, { surface }) }
	};
};
const handleToolsCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	let verbose = false;
	if (normalized === "/tools" || normalized === "/tools compact") verbose = false;
	else if (normalized === "/tools verbose") verbose = true;
	else if (normalized.startsWith("/tools ")) return {
		shouldContinue: false,
		reply: { text: "Usage: /tools [compact|verbose]" }
	};
	else return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /tools from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	try {
		const effectiveAccountId = resolveChannelAccountId({
			cfg: params.cfg,
			ctx: params.ctx,
			command: params.command
		});
		const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
		const sessionBound = Boolean(params.sessionKey);
		const agentId = sessionBound ? resolveSessionAgentId({
			sessionKey: params.sessionKey,
			config: params.cfg
		}) : params.agentId;
		const threadingContext = buildThreadingToolContext({
			sessionCtx: params.ctx,
			config: params.cfg,
			hasRepliedRef: void 0
		});
		return {
			shouldContinue: false,
			reply: { text: buildToolsMessage(resolveEffectiveToolInventory({
				cfg: params.cfg,
				agentId,
				sessionKey: params.sessionKey,
				workspaceDir: params.workspaceDir,
				agentDir: sessionBound ? void 0 : params.agentDir,
				modelProvider: params.provider,
				modelId: params.model,
				messageProvider: params.command.channel,
				senderId: params.command.senderId,
				senderName: params.ctx.SenderName,
				senderUsername: params.ctx.SenderUsername,
				senderE164: params.ctx.SenderE164,
				accountId: effectiveAccountId,
				currentChannelId: threadingContext.currentChannelId,
				currentThreadTs: typeof params.ctx.MessageThreadId === "string" || typeof params.ctx.MessageThreadId === "number" ? String(params.ctx.MessageThreadId) : void 0,
				currentMessageId: threadingContext.currentMessageId,
				groupId: targetSessionEntry?.groupId ?? extractExplicitGroupId(params.ctx.From),
				groupChannel: targetSessionEntry?.groupChannel ?? params.ctx.GroupChannel ?? params.ctx.GroupSubject,
				groupSpace: targetSessionEntry?.space ?? params.ctx.GroupSpace,
				replyToMode: resolveReplyToMode(params.cfg, params.ctx.OriginatingChannel ?? params.ctx.Provider, effectiveAccountId, params.ctx.ChatType)
			}), { verbose }) }
		};
	} catch (err) {
		return {
			shouldContinue: false,
			reply: { text: String(err).includes("missing scope:") ? "You do not have permission to view available tools." : "Couldn't load available tools right now. Try again in a moment." }
		};
	}
};
const handleStatusCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	if (!(params.directives.hasStatusDirective || params.command.commandBodyNormalized === "/status")) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /status from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	return {
		shouldContinue: false,
		reply: await buildStatusReply({
			cfg: params.cfg,
			command: params.command,
			sessionEntry: targetSessionEntry,
			sessionKey: params.sessionKey,
			parentSessionKey: targetSessionEntry?.parentSessionKey ?? params.ctx.ParentSessionKey,
			sessionScope: params.sessionScope,
			storePath: params.storePath,
			provider: params.provider,
			model: params.model,
			contextTokens: params.contextTokens,
			workspaceDir: params.workspaceDir,
			resolvedThinkLevel: params.resolvedThinkLevel,
			resolvedFastMode: params.resolvedFastMode,
			resolvedVerboseLevel: params.resolvedVerboseLevel,
			resolvedReasoningLevel: params.resolvedReasoningLevel,
			resolvedElevatedLevel: params.resolvedElevatedLevel,
			resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel,
			isGroup: params.isGroup,
			defaultGroupActivation: params.defaultGroupActivation,
			mediaDecisions: params.ctx.MediaUnderstandingDecisions
		})
	};
};
const handleExportSessionCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	if (normalized !== "/export-session" && !normalized.startsWith("/export-session ") && normalized !== "/export" && !normalized.startsWith("/export ")) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /export-session from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	return {
		shouldContinue: false,
		reply: await buildExportSessionReply(params)
	};
};
const handleExportTrajectoryCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	if (normalized !== "/export-trajectory" && !normalized.startsWith("/export-trajectory ") && normalized !== "/trajectory" && !normalized.startsWith("/trajectory ")) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/export-trajectory");
	if (unauthorized) return unauthorized;
	return {
		shouldContinue: false,
		reply: await buildExportTrajectoryCommandReply(params)
	};
};
//#endregion
//#region src/auto-reply/reply/mcp-commands.ts
function parseMcpCommand(raw) {
	return parseStandardSetUnsetSlashCommand({
		raw,
		slash: "/mcp",
		invalidMessage: "Invalid /mcp syntax.",
		usageMessage: "Usage: /mcp show|set|unset",
		onKnownAction: (action, args) => {
			if (action === "show" || action === "get") return {
				action: "show",
				name: args || void 0
			};
		},
		onSet: (name, value) => ({
			action: "set",
			name,
			value
		}),
		onUnset: (name) => ({
			action: "unset",
			name
		})
	});
}
//#endregion
//#region src/auto-reply/reply/commands-mcp.ts
function renderJsonBlock$1(label, value) {
	return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
const handleMcpCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const mcpCommand = parseMcpCommand(params.command.commandBodyNormalized);
	if (!mcpCommand) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/mcp");
	if (unauthorized) return unauthorized;
	const disabled = requireCommandFlagEnabled(params.cfg, {
		label: "/mcp",
		configKey: "mcp"
	});
	if (disabled) return disabled;
	if (mcpCommand.action === "error") return {
		shouldContinue: false,
		reply: { text: `⚠️ ${mcpCommand.message}` }
	};
	if (mcpCommand.action === "show") {
		const loaded = await listConfiguredMcpServers();
		if (!loaded.ok) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${loaded.error}` }
		};
		if (mcpCommand.name) {
			const server = loaded.mcpServers[mcpCommand.name];
			if (!server) return {
				shouldContinue: false,
				reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${loaded.path}.` }
			};
			return {
				shouldContinue: false,
				reply: { text: renderJsonBlock$1(`🔌 MCP server "${mcpCommand.name}" (${loaded.path})`, server) }
			};
		}
		if (Object.keys(loaded.mcpServers).length === 0) return {
			shouldContinue: false,
			reply: { text: `🔌 No MCP servers configured in ${loaded.path}.` }
		};
		return {
			shouldContinue: false,
			reply: { text: renderJsonBlock$1(`🔌 MCP servers (${loaded.path})`, loaded.mcpServers) }
		};
	}
	const missingAdminScope = requireGatewayClientScope(params, {
		label: "/mcp write",
		allowedScopes: ["operator.admin"],
		missingText: "❌ /mcp set|unset requires operator.admin for gateway clients."
	});
	if (missingAdminScope) return missingAdminScope;
	if (mcpCommand.action === "set") {
		const result = await setConfiguredMcpServer({
			name: mcpCommand.name,
			server: mcpCommand.value
		});
		if (!result.ok) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${result.error}` }
		};
		return {
			shouldContinue: false,
			reply: { text: `🔌 MCP server "${mcpCommand.name}" saved to ${result.path}.` }
		};
	}
	const result = await unsetConfiguredMcpServer({ name: mcpCommand.name });
	if (!result.ok) return {
		shouldContinue: false,
		reply: { text: `⚠️ ${result.error}` }
	};
	if (!result.removed) return {
		shouldContinue: false,
		reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${result.path}.` }
	};
	return {
		shouldContinue: false,
		reply: { text: `🔌 MCP server "${mcpCommand.name}" removed from ${result.path}.` }
	};
};
//#endregion
//#region src/auto-reply/reply/commands-plugin.ts
/**
* Plugin Command Handler
*
* Handles commands registered by plugins, bypassing the LLM agent.
* This handler is called before built-in command handlers.
*/
/**
* Handle plugin-registered commands.
* Returns a result if a plugin command was matched and executed,
* or null to continue to the next handler.
*/
const handlePluginCommand = async (params, allowTextCommands) => {
	const { command, cfg } = params;
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	if (!allowTextCommands) return null;
	const match = matchPluginCommand(command.commandBodyNormalized, { channel: command.channel });
	if (!match) return null;
	const result = await executePluginCommand({
		command: match.command,
		args: match.args,
		senderId: command.senderId,
		channel: command.channel,
		channelId: command.channelId,
		isAuthorizedSender: command.isAuthorizedSender,
		senderIsOwner: command.senderIsOwner,
		gatewayClientScopes: params.ctx.GatewayClientScopes,
		sessionKey: params.sessionKey,
		sessionId: targetSessionEntry?.sessionId,
		sessionFile: targetSessionEntry?.sessionFile,
		commandBody: command.commandBodyNormalized,
		config: cfg,
		from: command.from,
		to: command.to,
		accountId: params.ctx.AccountId ?? void 0,
		messageThreadId: typeof params.ctx.MessageThreadId === "string" || typeof params.ctx.MessageThreadId === "number" ? params.ctx.MessageThreadId : void 0,
		threadParentId: normalizeOptionalString(params.ctx.ThreadParentId)
	});
	const shouldContinue = result.continueAgent === true;
	const { continueAgent: _continueAgent, ...reply } = result;
	return {
		shouldContinue,
		reply: Object.keys(reply).length > 0 ? reply : void 0
	};
};
//#endregion
//#region src/auto-reply/reply/plugins-commands.ts
function parsePluginsCommand(raw) {
	const match = raw.match(/^\/plugins?(?:\s+(.*))?$/i);
	if (!match) return null;
	const tail = normalizeOptionalString(match?.[1]) ?? "";
	if (!tail) return { action: "list" };
	const [rawAction, ...rest] = tail.split(/\s+/);
	const action = normalizeOptionalLowercaseString(rawAction);
	const name = rest.join(" ").trim();
	if (action === "list") return name ? {
		action: "error",
		message: "Usage: /plugins list|inspect|show|get|enable|disable [plugin]"
	} : { action: "list" };
	if (action === "inspect" || action === "show" || action === "get") return {
		action: "inspect",
		name: name || void 0
	};
	if (action === "install" || action === "add") {
		if (!name) return {
			action: "error",
			message: "Usage: /plugins install <path|archive|npm-spec|git:repo|clawhub:pkg>"
		};
		return {
			action: "install",
			spec: name
		};
	}
	if (action === "enable" || action === "disable") {
		if (!name) return {
			action: "error",
			message: `Usage: /plugins ${action} <plugin-id-or-name>`
		};
		return {
			action,
			name
		};
	}
	return {
		action: "error",
		message: "Usage: /plugins list|inspect|show|get|install|enable|disable [plugin]"
	};
}
//#endregion
//#region src/auto-reply/reply/commands-plugins.ts
function renderJsonBlock(label, value) {
	return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}
function buildPluginInspectJson(params) {
	const inspect = buildPluginInspectReport({
		id: params.id,
		config: params.config,
		report: params.report
	});
	if (!inspect) return null;
	return {
		inspect,
		compatibilityWarnings: inspect.compatibility.map((warning) => ({
			code: warning.code,
			severity: warning.severity,
			message: formatPluginCompatibilityNotice(warning)
		})),
		install: params.installRecords[inspect.plugin.id] ?? null
	};
}
function buildAllPluginInspectJson(params) {
	return buildAllPluginInspectReports({
		config: params.config,
		report: params.report
	}).map((inspect) => ({
		inspect,
		compatibilityWarnings: inspect.compatibility.map((warning) => ({
			code: warning.code,
			severity: warning.severity,
			message: formatPluginCompatibilityNotice(warning)
		})),
		install: params.installRecords[inspect.plugin.id] ?? null
	}));
}
function formatPluginLabel(plugin) {
	if (!plugin.name || plugin.name === plugin.id) return plugin.id;
	return `${plugin.name} (${plugin.id})`;
}
function formatPluginsList(report) {
	if (report.plugins.length === 0) return `🔌 No plugins found for workspace ${report.workspaceDir ?? "(unknown workspace)"}.`;
	return [`🔌 Plugins (${report.plugins.filter((plugin) => plugin.status === "loaded").length}/${report.plugins.length} loaded)`, ...report.plugins.map((plugin) => {
		const format = plugin.bundleFormat ? `${plugin.format ?? "openclaw"}/${plugin.bundleFormat}` : plugin.format ?? "openclaw";
		return `- ${formatPluginLabel(plugin)} [${plugin.status}] ${format}`;
	})].join("\n");
}
function isPluginsWriteAction(action) {
	return action === "install" || action === "enable" || action === "disable";
}
function rejectNixModePluginWrite() {
	try {
		assertConfigWriteAllowedInCurrentMode();
		return null;
	} catch (error) {
		return {
			shouldContinue: false,
			reply: { text: `⚠️ ${formatErrorMessage(error)}` }
		};
	}
}
function findPlugin(report, rawName) {
	const target = normalizeOptionalLowercaseString(rawName);
	if (!target) return;
	return report.plugins.find((plugin) => normalizeOptionalLowercaseString(plugin.id) === target || normalizeOptionalLowercaseString(plugin.name) === target);
}
function looksLikeLocalPluginInstallSpec(raw) {
	return raw.startsWith(".") || raw.startsWith("~") || raw.startsWith("/") || raw.endsWith(".ts") || raw.endsWith(".js") || raw.endsWith(".mjs") || raw.endsWith(".cjs") || raw.endsWith(".tgz") || raw.endsWith(".tar.gz") || raw.endsWith(".tar") || raw.endsWith(".zip");
}
function findTrustedCatalogPackageInstall(packageName) {
	const entry = getOfficialExternalPluginCatalogEntryForPackage(packageName);
	if (!entry) return;
	const pluginId = resolveOfficialExternalPluginId(entry);
	if (!pluginId) return;
	const install = resolveOfficialExternalPluginInstall(entry);
	return {
		pluginId,
		...install?.npmSpec ? { npmSpec: install.npmSpec } : {},
		...install?.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}
	};
}
async function installPluginFromPluginsCommand(params) {
	const fileSpec = resolveFileNpmSpecToLocalPath(params.raw);
	if (fileSpec && !fileSpec.ok) return {
		ok: false,
		error: fileSpec.error
	};
	const resolved = resolveUserPath(fileSpec && fileSpec.ok ? fileSpec.path : params.raw);
	if (fs.existsSync(resolved)) {
		const result = await installPluginFromPath({
			path: resolved,
			logger: createPluginInstallLogger()
		});
		if (!result.ok) return {
			ok: false,
			error: result.error
		};
		const source = resolveArchiveKind(resolved) ? "archive" : "path";
		await persistPluginInstall({
			snapshot: params.snapshot,
			pluginId: result.pluginId,
			install: {
				source,
				sourcePath: resolved,
				installPath: result.targetDir,
				version: result.version
			}
		});
		return {
			ok: true,
			pluginId: result.pluginId
		};
	}
	if (looksLikeLocalPluginInstallSpec(params.raw)) return {
		ok: false,
		error: `Path not found: ${resolved}`
	};
	const gitPrefix = params.raw.trim().toLowerCase().startsWith("git:");
	const gitSpec = parseGitPluginSpec(params.raw);
	if (gitPrefix && !gitSpec) return {
		ok: false,
		error: `unsupported git: plugin spec: ${params.raw}`
	};
	if (gitSpec) {
		const result = await installPluginFromGitSpec({
			spec: params.raw,
			logger: createPluginInstallLogger()
		});
		if (!result.ok) return {
			ok: false,
			error: result.error
		};
		await persistPluginInstall({
			snapshot: params.snapshot,
			pluginId: result.pluginId,
			install: {
				source: "git",
				spec: params.raw,
				installPath: result.targetDir,
				version: result.version,
				resolvedAt: result.git.resolvedAt,
				gitUrl: result.git.url,
				gitRef: result.git.ref,
				gitCommit: result.git.commit
			}
		});
		return {
			ok: true,
			pluginId: result.pluginId
		};
	}
	if (parseClawHubPluginSpec(params.raw)) {
		const result = await installPluginFromClawHub({
			spec: params.raw,
			logger: createPluginInstallLogger()
		});
		if (!result.ok) return {
			ok: false,
			error: result.error
		};
		await persistPluginInstall({
			snapshot: params.snapshot,
			pluginId: result.pluginId,
			install: {
				source: "clawhub",
				spec: params.raw,
				installPath: result.targetDir,
				version: result.version,
				integrity: result.clawhub.integrity,
				resolvedAt: result.clawhub.resolvedAt,
				clawhubUrl: result.clawhub.clawhubUrl,
				clawhubPackage: result.clawhub.clawhubPackage,
				clawhubFamily: result.clawhub.clawhubFamily,
				clawhubChannel: result.clawhub.clawhubChannel
			}
		});
		return {
			ok: true,
			pluginId: result.pluginId
		};
	}
	const officialNpmTrust = resolveOfficialExternalNpmPackageTrust({
		npmSpec: params.raw,
		findOfficialExternalPackage: findTrustedCatalogPackageInstall
	});
	const result = await installPluginFromNpmSpec({
		spec: params.raw,
		...officialNpmTrust ? {
			expectedPluginId: officialNpmTrust.pluginId,
			...officialNpmTrust.expectedIntegrity ? { expectedIntegrity: officialNpmTrust.expectedIntegrity } : {},
			trustedSourceLinkedOfficialInstall: true
		} : {},
		logger: createPluginInstallLogger()
	});
	if (!result.ok) return {
		ok: false,
		error: result.error
	};
	const installRecord = buildNpmInstallRecordFields({
		spec: params.raw,
		installPath: result.targetDir,
		version: result.version,
		resolution: result.npmResolution
	});
	await persistPluginInstall({
		snapshot: params.snapshot,
		pluginId: result.pluginId,
		install: installRecord
	});
	return {
		ok: true,
		pluginId: result.pluginId
	};
}
async function loadPluginCommandState(workspaceDir, options) {
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid) return {
		ok: false,
		path: snapshot.path,
		error: "Config file is invalid; fix it before using /plugins."
	};
	const config = structuredClone(snapshot.resolved);
	return {
		ok: true,
		path: snapshot.path,
		config,
		report: options?.loadModules === true ? buildPluginDiagnosticsReport({
			config,
			workspaceDir
		}) : buildPluginRegistrySnapshotReport({
			config,
			workspaceDir
		})
	};
}
async function loadPluginCommandConfig() {
	const snapshot = await readConfigFileSnapshot();
	if (!snapshot.valid) return {
		ok: false,
		path: snapshot.path,
		error: "Config file is invalid; fix it before using /plugins."
	};
	return {
		ok: true,
		path: snapshot.path,
		snapshot: {
			config: structuredClone(snapshot.sourceConfig),
			baseHash: snapshot.hash
		}
	};
}
const handlePluginsCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const pluginsCommand = parsePluginsCommand(params.command.commandBodyNormalized);
	if (!pluginsCommand) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/plugins");
	if (unauthorized) return unauthorized;
	const disabled = requireCommandFlagEnabled(params.cfg, {
		label: "/plugins",
		configKey: "plugins"
	});
	if (disabled) return disabled;
	if (pluginsCommand.action === "error") return {
		shouldContinue: false,
		reply: { text: `⚠️ ${pluginsCommand.message}` }
	};
	if (isPluginsWriteAction(pluginsCommand.action)) {
		const missingAdminScope = requireGatewayClientScope(params, {
			label: "/plugins write",
			allowedScopes: ["operator.admin"],
			missingText: "❌ /plugins install|enable|disable requires operator.admin for gateway clients."
		});
		if (missingAdminScope) return missingAdminScope;
		const nixModeWrite = rejectNixModePluginWrite();
		if (nixModeWrite) return nixModeWrite;
	}
	if (pluginsCommand.action === "install") {
		const loadedConfig = await loadPluginCommandConfig();
		if (!loadedConfig.ok) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${loadedConfig.error}` }
		};
		const installed = await installPluginFromPluginsCommand({
			raw: pluginsCommand.spec,
			snapshot: loadedConfig.snapshot
		});
		if (!installed.ok) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${installed.error}` }
		};
		return {
			shouldContinue: false,
			reply: { text: `🔌 Installed plugin "${installed.pluginId}". Gateway restart will load the new plugin source.` }
		};
	}
	const loaded = await loadPluginCommandState(params.workspaceDir, { loadModules: pluginsCommand.action === "inspect" });
	if (!loaded.ok) return {
		shouldContinue: false,
		reply: { text: `⚠️ ${loaded.error}` }
	};
	if (pluginsCommand.action === "list") return {
		shouldContinue: false,
		reply: { text: formatPluginsList(loaded.report) }
	};
	if (pluginsCommand.action === "inspect") {
		const installRecords = await loadInstalledPluginIndexInstallRecords();
		if (!pluginsCommand.name) return {
			shouldContinue: false,
			reply: { text: formatPluginsList(loaded.report) }
		};
		if (normalizeOptionalLowercaseString(pluginsCommand.name) === "all") return {
			shouldContinue: false,
			reply: { text: renderJsonBlock("🔌 Plugins", buildAllPluginInspectJson({
				...loaded,
				installRecords
			})) }
		};
		const payload = buildPluginInspectJson({
			id: pluginsCommand.name,
			config: loaded.config,
			installRecords,
			report: loaded.report
		});
		if (!payload) return {
			shouldContinue: false,
			reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` }
		};
		return {
			shouldContinue: false,
			reply: { text: renderJsonBlock(`🔌 Plugin "${payload.inspect.plugin.id}"`, {
				...payload.inspect,
				compatibilityWarnings: payload.compatibilityWarnings,
				install: payload.install
			}) }
		};
	}
	const plugin = findPlugin(loaded.report, pluginsCommand.name);
	if (!plugin) return {
		shouldContinue: false,
		reply: { text: `🔌 No plugin named "${pluginsCommand.name}" found.` }
	};
	let committedConfig;
	try {
		committedConfig = await setPluginEnabledFromCommand({
			pluginId: plugin.id,
			enabled: pluginsCommand.action === "enable",
			action: pluginsCommand.action
		});
	} catch (error) {
		if (error instanceof AutoReplyConfigMutationError) return {
			shouldContinue: false,
			reply: { text: `⚠️ ${error.message}` }
		};
		throw error;
	}
	let registryWarning;
	await refreshPluginRegistryAfterConfigMutation({
		config: committedConfig,
		reason: "policy-changed",
		logger: { warn: (message) => {
			registryWarning = message;
		} }
	});
	return {
		shouldContinue: false,
		reply: { text: `🔌 Plugin "${plugin.id}" ${pluginsCommand.action}d in ${loaded.path}. Gateway reload will apply it to new agent turns.` + (registryWarning ? `\n${registryWarning}` : "") }
	};
};
//#endregion
//#region src/auto-reply/send-policy.ts
function normalizeSendPolicyOverride(raw) {
	const value = normalizeOptionalLowercaseString(raw);
	if (!value) return;
	if (value === "allow" || value === "on") return "allow";
	if (value === "deny" || value === "off") return "deny";
}
function parseSendPolicyCommand(raw) {
	if (!raw) return { hasCommand: false };
	const trimmed = raw.trim();
	if (!trimmed) return { hasCommand: false };
	const match = normalizeCommandBody(stripInboundMetadata(trimmed)).match(/^\/send(?:\s+([a-zA-Z]+))?\s*$/i);
	if (!match) return { hasCommand: false };
	const token = normalizeOptionalLowercaseString(match[1]);
	if (!token) return { hasCommand: true };
	if (token === "inherit" || token === "default" || token === "reset") return {
		hasCommand: true,
		mode: "inherit"
	};
	return {
		hasCommand: true,
		mode: normalizeSendPolicyOverride(token)
	};
}
//#endregion
//#region src/auto-reply/reply/commands-session-abort.ts
function resolveAbortTarget(params) {
	const targetSessionKey = normalizeOptionalString(params.ctx.CommandTargetSessionKey) || params.sessionKey;
	const { entry, key } = resolveSessionEntryForKey(params.sessionStore, targetSessionKey);
	if (entry && key) return {
		entry,
		key,
		sessionId: replyRunRegistry.resolveSessionId(key) ?? entry.sessionId
	};
	if (params.sessionEntry && params.sessionKey && (!targetSessionKey || targetSessionKey === params.sessionKey)) return {
		entry: params.sessionEntry,
		key: params.sessionKey,
		sessionId: replyRunRegistry.resolveSessionId(params.sessionKey) ?? params.sessionEntry.sessionId
	};
	return {
		entry: void 0,
		key: targetSessionKey,
		sessionId: targetSessionKey ? replyRunRegistry.resolveSessionId(targetSessionKey) : void 0
	};
}
function resolveAbortCutoffForTarget(params) {
	if (!shouldPersistAbortCutoff({
		commandSessionKey: params.commandSessionKey,
		targetSessionKey: params.targetSessionKey
	})) return;
	return resolveAbortCutoffFromContext(params.ctx);
}
async function applyAbortTarget(params) {
	const { abortTarget } = params;
	abortSessionRunTarget({
		key: abortTarget.key,
		sessionId: abortTarget.sessionId
	});
	if (!await persistAbortTargetEntry({
		entry: abortTarget.entry,
		key: abortTarget.key,
		sessionStore: params.sessionStore,
		storePath: params.storePath,
		abortCutoff: params.abortCutoff
	}) && params.abortKey) setAbortMemory(params.abortKey, true);
}
function buildAbortTargetApplyParams(params, abortTarget) {
	return {
		abortTarget,
		sessionStore: params.sessionStore,
		storePath: params.storePath,
		abortKey: params.command.abortKey,
		abortCutoff: resolveAbortCutoffForTarget({
			ctx: params.ctx,
			commandSessionKey: params.sessionKey,
			targetSessionKey: abortTarget.key
		})
	};
}
const handleStopCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	if (params.command.commandBodyNormalized !== "/stop") return null;
	const unauthorizedStop = rejectUnauthorizedCommand(params, "/stop");
	if (unauthorizedStop) return unauthorizedStop;
	const abortTarget = resolveAbortTarget({
		ctx: params.ctx,
		sessionKey: params.sessionKey,
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore
	});
	const cleared = clearSessionQueues([abortTarget.key, abortTarget.sessionId]);
	if (cleared.followupCleared > 0 || cleared.laneCleared > 0) logVerbose(`stop: cleared followups=${cleared.followupCleared} lane=${cleared.laneCleared} keys=${cleared.keys.join(",")}`);
	await applyAbortTarget(buildAbortTargetApplyParams(params, abortTarget));
	await triggerInternalHook(createInternalHookEvent("command", "stop", abortTarget.key ?? params.sessionKey ?? "", {
		sessionEntry: abortTarget.entry,
		sessionId: abortTarget.sessionId,
		commandSource: params.command.surface,
		senderId: params.command.senderId
	}));
	const { stopped } = stopSubagentsForRequester({
		cfg: params.cfg,
		requesterSessionKey: abortTarget.key ?? params.sessionKey
	});
	return {
		shouldContinue: false,
		reply: { text: formatAbortReplyText(stopped) }
	};
};
const handleAbortTrigger = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	if (!isAbortTrigger(params.command.rawBodyNormalized)) return null;
	const unauthorizedAbortTrigger = rejectUnauthorizedCommand(params, "abort trigger");
	if (unauthorizedAbortTrigger) return unauthorizedAbortTrigger;
	await applyAbortTarget(buildAbortTargetApplyParams(params, resolveAbortTarget({
		ctx: params.ctx,
		sessionKey: params.sessionKey,
		sessionEntry: params.sessionEntry,
		sessionStore: params.sessionStore
	})));
	return {
		shouldContinue: false,
		reply: { text: "⚙️ Agent was aborted." }
	};
};
//#endregion
//#region src/auto-reply/reply/commands-session.ts
const SESSION_DURATION_OFF_VALUES = new Set([
	"off",
	"disable",
	"disabled",
	"none",
	"0"
]);
const SESSION_ACTION_IDLE = "idle";
const SESSION_ACTION_MAX_AGE = "max-age";
function buildRestartCommandSentinel(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	if (!sessionKey) return null;
	const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
	return {
		kind: "restart",
		status: "ok",
		ts: Date.now(),
		sessionKey,
		deliveryContext,
		threadId,
		message: "/restart",
		continuation: buildRestartSuccessContinuation({ sessionKey }),
		doctorHint: formatDoctorNonInteractiveHint(),
		stats: {
			mode: "gateway.restart",
			reason: "/restart"
		}
	};
}
function resolveSessionCommandUsage() {
	return "Usage: /session idle <duration|off> | /session max-age <duration|off> (example: /session idle 24h)";
}
function parseSessionDurationMs(raw) {
	const normalized = normalizeOptionalLowercaseString(raw);
	if (!normalized) throw new Error("missing duration");
	if (SESSION_DURATION_OFF_VALUES.has(normalized)) return 0;
	if (/^\d+(?:\.\d+)?$/.test(normalized)) {
		const hours = Number(normalized);
		if (!Number.isFinite(hours) || hours < 0) throw new Error("invalid duration");
		return Math.round(hours * 60 * 60 * 1e3);
	}
	return parseDurationMs(normalized, { defaultUnit: "h" });
}
function formatSessionExpiry(expiresAt) {
	return new Date(expiresAt).toISOString();
}
function resolveSessionBindingDurationMs(binding, key, fallbackMs) {
	const raw = binding.metadata?.[key];
	if (typeof raw !== "number" || !Number.isFinite(raw)) return fallbackMs;
	return Math.max(0, Math.floor(raw));
}
function resolveSessionBindingLastActivityAt(binding) {
	const raw = binding.metadata?.lastActivityAt;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return binding.boundAt;
	return Math.max(Math.floor(raw), binding.boundAt);
}
function resolveSessionBindingBoundBy(binding) {
	const raw = binding.metadata?.boundBy;
	return normalizeOptionalString(raw) ?? "";
}
function isSessionBindingRecord(binding) {
	return "bindingId" in binding;
}
function resolveUpdatedLifecycleDurationMs(binding, key) {
	if (!isSessionBindingRecord(binding)) {
		const raw = binding[key];
		if (typeof raw === "number" && Number.isFinite(raw)) return Math.max(0, Math.floor(raw));
	}
	if (!isSessionBindingRecord(binding)) return;
	const raw = binding.metadata?.[key];
	if (typeof raw !== "number" || !Number.isFinite(raw)) return;
	return Math.max(0, Math.floor(raw));
}
function toUpdatedLifecycleBinding(binding) {
	const lastActivityAt = isSessionBindingRecord(binding) ? resolveSessionBindingLastActivityAt(binding) : Math.max(Math.floor(binding.lastActivityAt), binding.boundAt);
	return {
		boundAt: binding.boundAt,
		lastActivityAt,
		idleTimeoutMs: resolveUpdatedLifecycleDurationMs(binding, "idleTimeoutMs"),
		maxAgeMs: resolveUpdatedLifecycleDurationMs(binding, "maxAgeMs")
	};
}
function resolveUpdatedBindingExpiry(params) {
	const expiries = params.bindings.map((binding) => {
		if (params.action === SESSION_ACTION_IDLE) {
			const idleTimeoutMs = typeof binding.idleTimeoutMs === "number" && Number.isFinite(binding.idleTimeoutMs) ? Math.max(0, Math.floor(binding.idleTimeoutMs)) : 0;
			if (idleTimeoutMs <= 0) return;
			return Math.max(binding.lastActivityAt, binding.boundAt) + idleTimeoutMs;
		}
		const maxAgeMs = typeof binding.maxAgeMs === "number" && Number.isFinite(binding.maxAgeMs) ? Math.max(0, Math.floor(binding.maxAgeMs)) : 0;
		if (maxAgeMs <= 0) return;
		return binding.boundAt + maxAgeMs;
	}).filter((expiresAt) => typeof expiresAt === "number");
	if (expiries.length === 0) return;
	return Math.min(...expiries);
}
const handleActivationCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const activationCommand = parseActivationCommand(params.command.commandBodyNormalized);
	if (!activationCommand.hasCommand) return null;
	if (!params.isGroup) return {
		shouldContinue: false,
		reply: { text: "⚙️ Group activation only applies to group chats." }
	};
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /activation from unauthorized sender in group: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	if (!activationCommand.mode) return {
		shouldContinue: false,
		reply: { text: "⚙️ Usage: /activation mention|always" }
	};
	if (params.sessionEntry && params.sessionStore && params.sessionKey) {
		params.sessionEntry.groupActivation = activationCommand.mode;
		params.sessionEntry.groupActivationNeedsSystemIntro = true;
		await persistSessionEntry(params);
	}
	return {
		shouldContinue: false,
		reply: { text: `⚙️ Group activation set to ${activationCommand.mode}.` }
	};
};
const handleSendPolicyCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const sendPolicyCommand = parseSendPolicyCommand(params.command.commandBodyNormalized);
	if (!sendPolicyCommand.hasCommand) return null;
	const unauthorizedResult = rejectUnauthorizedCommand(params, "/send");
	if (unauthorizedResult) return unauthorizedResult;
	const nonOwnerResult = rejectNonOwnerCommand(params, "/send");
	if (nonOwnerResult) return nonOwnerResult;
	if (!sendPolicyCommand.mode) return {
		shouldContinue: false,
		reply: { text: "⚙️ Usage: /send on|off|inherit" }
	};
	if (params.sessionEntry && params.sessionStore && params.sessionKey) {
		if (sendPolicyCommand.mode === "inherit") delete params.sessionEntry.sendPolicy;
		else params.sessionEntry.sendPolicy = sendPolicyCommand.mode;
		await persistSessionEntry(params);
	}
	return {
		shouldContinue: false,
		reply: { text: `⚙️ Send policy set to ${sendPolicyCommand.mode === "inherit" ? "inherit" : sendPolicyCommand.mode === "allow" ? "on" : "off"}.` }
	};
};
const handleUsageCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	if (normalized !== "/usage" && !normalized.startsWith("/usage ")) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /usage from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const rawArgs = normalized === "/usage" ? "" : normalized.slice(6).trim();
	const requested = rawArgs ? normalizeUsageDisplay(rawArgs) : void 0;
	if (normalizeLowercaseStringOrEmpty(rawArgs).startsWith("cost")) {
		const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
		const sessionAgentId = params.sessionKey ? resolveSessionAgentId({
			sessionKey: params.sessionKey,
			config: params.cfg
		}) : params.agentId;
		const sessionSummary = await loadSessionCostSummary({
			sessionId: targetSessionEntry?.sessionId,
			sessionEntry: targetSessionEntry,
			sessionFile: targetSessionEntry?.sessionFile,
			config: params.cfg,
			agentId: sessionAgentId
		});
		const summary = await loadCostUsageSummary({
			days: 30,
			config: params.cfg
		});
		const sessionCost = formatUsd(sessionSummary?.totalCost);
		const sessionTokens = sessionSummary?.totalTokens ? formatTokenCount(sessionSummary.totalTokens) : void 0;
		const sessionSuffix = (sessionSummary?.missingCostEntries ?? 0) > 0 ? " (partial)" : "";
		const sessionLine = sessionCost || sessionTokens ? `Session ${sessionCost ?? "n/a"}${sessionSuffix}${sessionTokens ? ` · ${sessionTokens} tokens` : ""}` : "Session n/a";
		const todayKey = (/* @__PURE__ */ new Date()).toLocaleDateString("en-CA");
		const todayEntry = summary.daily.find((entry) => entry.date === todayKey);
		const todayCost = formatUsd(todayEntry?.totalCost);
		const todaySuffix = (todayEntry?.missingCostEntries ?? 0) > 0 ? " (partial)" : "";
		const todayLine = `Today ${todayCost ?? "n/a"}${todaySuffix}`;
		const last30Cost = formatUsd(summary.totals.totalCost);
		const last30Suffix = summary.totals.missingCostEntries > 0 ? " (partial)" : "";
		return {
			shouldContinue: false,
			reply: { text: `💸 Usage cost\n${sessionLine}\n${todayLine}\n${`Last 30d ${last30Cost ?? "n/a"}${last30Suffix}`}` }
		};
	}
	if (rawArgs && !requested) return {
		shouldContinue: false,
		reply: { text: "⚙️ Usage: /usage off|tokens|full|cost" }
	};
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const currentRaw = targetSessionEntry?.responseUsage;
	const current = resolveResponseUsageMode(currentRaw);
	const next = requested ?? (current === "off" ? "tokens" : current === "tokens" ? "full" : "off");
	if (targetSessionEntry && params.sessionStore && params.sessionKey) {
		if (next === "off") delete targetSessionEntry.responseUsage;
		else targetSessionEntry.responseUsage = next;
		params.sessionStore[params.sessionKey] = targetSessionEntry;
		await persistSessionEntry({
			...params,
			sessionEntry: targetSessionEntry
		});
	}
	return {
		shouldContinue: false,
		reply: { text: `⚙️ Usage footer: ${next}.` }
	};
};
const handleFastCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	if (normalized !== "/fast" && !normalized.startsWith("/fast ")) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /fast from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const rawMode = normalizeLowercaseStringOrEmpty(normalized === "/fast" ? "" : normalized.slice(5).trim());
	if (!rawMode || rawMode === "status") {
		const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
		const sessionAgentId = params.sessionKey ? resolveSessionAgentId({
			sessionKey: params.sessionKey,
			config: params.cfg
		}) : params.agentId;
		const state = resolveFastModeState({
			cfg: params.cfg,
			provider: params.provider,
			model: params.model,
			agentId: sessionAgentId,
			sessionEntry: targetSessionEntry
		});
		const suffix = state.source === "agent" ? " (agent)" : state.source === "config" ? " (config)" : state.source === "default" ? " (default)" : "";
		return {
			shouldContinue: false,
			reply: { text: `⚙️ Current fast mode: ${state.enabled ? "on" : "off"}${suffix}.` }
		};
	}
	const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
	const resetsToDefault = isSessionDefaultDirectiveValue(rawMode);
	const nextMode = resetsToDefault ? void 0 : normalizeFastMode(rawMode);
	if (nextMode === void 0) {
		if (resetsToDefault) {
			if (targetSessionEntry && params.sessionStore && params.sessionKey) {
				delete targetSessionEntry.fastMode;
				await persistSessionEntry({
					...params,
					sessionEntry: targetSessionEntry
				});
			}
			return {
				shouldContinue: false,
				reply: { text: "⚙️ Fast mode reset to default." }
			};
		}
		return {
			shouldContinue: false,
			reply: { text: "⚙️ Usage: /fast status|on|off|default" }
		};
	}
	if (targetSessionEntry && params.sessionStore && params.sessionKey) {
		targetSessionEntry.fastMode = nextMode;
		await persistSessionEntry({
			...params,
			sessionEntry: targetSessionEntry
		});
	}
	return {
		shouldContinue: false,
		reply: { text: `⚙️ Fast mode ${nextMode ? "enabled" : "disabled"}.` }
	};
};
const handleSessionCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	if (!/^\/session(?:\s|$)/.test(normalized)) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /session from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const tokens = normalized.slice(8).trim().split(/\s+/).filter(Boolean);
	const action = normalizeOptionalLowercaseString(tokens[0]);
	if (action !== SESSION_ACTION_IDLE && action !== SESSION_ACTION_MAX_AGE) return {
		shouldContinue: false,
		reply: { text: resolveSessionCommandUsage() }
	};
	const channelId = params.command.channelId ?? normalizeChannelId$1(resolveCommandSurfaceChannel(params)) ?? void 0;
	const commandConversationBindings = channelId ? getChannelPlugin(channelId)?.conversationBindings : void 0;
	const commandSupportsCurrentConversationBinding = Boolean(commandConversationBindings?.supportsCurrentConversationBinding);
	const commandSupportsLifecycleUpdate = action === SESSION_ACTION_IDLE ? typeof commandConversationBindings?.setIdleTimeoutBySessionKey === "function" : typeof commandConversationBindings?.setMaxAgeBySessionKey === "function";
	const bindingContext = resolveConversationBindingContextFromAcpCommand(params);
	if (!bindingContext) {
		if (!channelId || !commandSupportsCurrentConversationBinding || !commandSupportsLifecycleUpdate) return {
			shouldContinue: false,
			reply: { text: "⚠️ /session idle and /session max-age are currently available only on channels that support focused conversation bindings." }
		};
		return {
			shouldContinue: false,
			reply: { text: "⚠️ /session idle and /session max-age must be run inside a focused conversation." }
		};
	}
	const resolvedChannelId = bindingContext.channel || channelId;
	const conversationBindings = resolvedChannelId ? getChannelPlugin(resolvedChannelId)?.conversationBindings : void 0;
	const supportsCurrentConversationBinding = Boolean(conversationBindings?.supportsCurrentConversationBinding);
	const supportsLifecycleUpdate = action === SESSION_ACTION_IDLE ? typeof conversationBindings?.setIdleTimeoutBySessionKey === "function" : typeof conversationBindings?.setMaxAgeBySessionKey === "function";
	if (!resolvedChannelId || !supportsCurrentConversationBinding || !supportsLifecycleUpdate) return {
		shouldContinue: false,
		reply: { text: "⚠️ /session idle and /session max-age are currently available only on channels that support focused conversation bindings." }
	};
	const activeBinding = getSessionBindingService().resolveByConversation(bindingContext);
	if (!activeBinding) return {
		shouldContinue: false,
		reply: { text: "ℹ️ This conversation is not currently focused." }
	};
	const idleTimeoutMs = resolveSessionBindingDurationMs(activeBinding, "idleTimeoutMs", 1440 * 60 * 1e3);
	const idleExpiresAt = idleTimeoutMs > 0 ? resolveSessionBindingLastActivityAt(activeBinding) + idleTimeoutMs : void 0;
	const maxAgeMs = resolveSessionBindingDurationMs(activeBinding, "maxAgeMs", 0);
	const maxAgeExpiresAt = maxAgeMs > 0 ? activeBinding.boundAt + maxAgeMs : void 0;
	const durationArgRaw = tokens.slice(1).join("");
	if (!durationArgRaw) {
		if (action === SESSION_ACTION_IDLE) {
			if (typeof idleExpiresAt === "number" && Number.isFinite(idleExpiresAt) && idleExpiresAt > Date.now()) return {
				shouldContinue: false,
				reply: { text: `ℹ️ Idle timeout active (${formatThreadBindingDurationLabel(idleTimeoutMs)}, next auto-unfocus at ${formatSessionExpiry(idleExpiresAt)}).` }
			};
			return {
				shouldContinue: false,
				reply: { text: "ℹ️ Idle timeout is currently disabled for this focused session." }
			};
		}
		if (typeof maxAgeExpiresAt === "number" && Number.isFinite(maxAgeExpiresAt) && maxAgeExpiresAt > Date.now()) return {
			shouldContinue: false,
			reply: { text: `ℹ️ Max age active (${formatThreadBindingDurationLabel(maxAgeMs)}, hard auto-unfocus at ${formatSessionExpiry(maxAgeExpiresAt)}).` }
		};
		return {
			shouldContinue: false,
			reply: { text: "ℹ️ Max age is currently disabled for this focused session." }
		};
	}
	const senderId = normalizeOptionalString(params.command.senderId) ?? "";
	const boundBy = resolveSessionBindingBoundBy(activeBinding);
	if (boundBy && boundBy !== "system" && senderId && senderId !== boundBy) return {
		shouldContinue: false,
		reply: { text: `⚠️ Only ${boundBy} can update session lifecycle settings for this conversation.` }
	};
	let durationMs;
	try {
		durationMs = parseSessionDurationMs(durationArgRaw);
	} catch {
		return {
			shouldContinue: false,
			reply: { text: resolveSessionCommandUsage() }
		};
	}
	const updatedBindings = action === SESSION_ACTION_IDLE ? setChannelConversationBindingIdleTimeoutBySessionKey({
		channelId: bindingContext.channel,
		targetSessionKey: activeBinding.targetSessionKey,
		accountId: bindingContext.accountId,
		idleTimeoutMs: durationMs
	}) : setChannelConversationBindingMaxAgeBySessionKey({
		channelId: bindingContext.channel,
		targetSessionKey: activeBinding.targetSessionKey,
		accountId: bindingContext.accountId,
		maxAgeMs: durationMs
	});
	if (updatedBindings.length === 0) return {
		shouldContinue: false,
		reply: { text: action === SESSION_ACTION_IDLE ? "⚠️ Failed to update idle timeout for the current binding." : "⚠️ Failed to update max age for the current binding." }
	};
	if (durationMs <= 0) return {
		shouldContinue: false,
		reply: { text: action === SESSION_ACTION_IDLE ? `✅ Idle timeout disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.` : `✅ Max age disabled for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"}.` }
	};
	const nextExpiry = resolveUpdatedBindingExpiry({
		action,
		bindings: updatedBindings.map((binding) => toUpdatedLifecycleBinding(binding))
	});
	const expiryLabel = typeof nextExpiry === "number" && Number.isFinite(nextExpiry) ? formatSessionExpiry(nextExpiry) : "n/a";
	return {
		shouldContinue: false,
		reply: { text: action === SESSION_ACTION_IDLE ? `✅ Idle timeout set to ${formatThreadBindingDurationLabel(durationMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (next auto-unfocus at ${expiryLabel}).` : `✅ Max age set to ${formatThreadBindingDurationLabel(durationMs)} for ${updatedBindings.length} binding${updatedBindings.length === 1 ? "" : "s"} (hard auto-unfocus at ${expiryLabel}).` }
	};
};
const handleRestartCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	if (params.command.commandBodyNormalized !== "/restart") return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /restart from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const nonOwner = rejectNonOwnerCommand(params, "/restart");
	if (nonOwner) return nonOwner;
	if (!isRestartEnabled(params.cfg)) return {
		shouldContinue: false,
		reply: { text: "⚠️ /restart is disabled (commands.restart=false)." }
	};
	const hasSigusr1Listener = process.listenerCount("SIGUSR1") > 0;
	const sentinelPayload = buildRestartCommandSentinel(params);
	if (hasSigusr1Listener) {
		let sentinelPath = null;
		scheduleGatewaySigusr1Restart({
			reason: "/restart",
			emitHooks: sentinelPayload ? {
				beforeEmit: async () => {
					sentinelPath = await writeRestartSentinel(sentinelPayload);
				},
				afterEmitRejected: async () => {
					await removeRestartSentinelFile(sentinelPath);
				}
			} : void 0
		});
		return {
			shouldContinue: false,
			reply: { text: "⚙️ Restarting OpenClaw in-process (SIGUSR1); back in a few seconds." }
		};
	}
	let sentinelPath = null;
	try {
		if (sentinelPayload) sentinelPath = await writeRestartSentinel(sentinelPayload);
	} catch (err) {
		logVerbose(`failed to write /restart sentinel: ${String(err)}`);
		return {
			shouldContinue: false,
			reply: { text: "⚠️ Restart failed: could not persist the post-restart acknowledgement." }
		};
	}
	const restartMethod = triggerOpenClawRestart();
	if (!restartMethod.ok) {
		await removeRestartSentinelFile(sentinelPath);
		const detail = restartMethod.detail ? ` Details: ${restartMethod.detail}` : "";
		return {
			shouldContinue: false,
			reply: { text: `⚠️ Restart failed (${restartMethod.method}).${detail}` }
		};
	}
	return {
		shouldContinue: false,
		reply: { text: `⚙️ Restarting OpenClaw via ${restartMethod.method}; give me a few seconds to come back online.` }
	};
};
//#endregion
//#region src/auto-reply/reply/commands-steer.ts
const STEER_USAGE = "Usage: /steer <message>";
function parseSteerMessage(raw) {
	const match = raw.trim().match(/^\/(?:steer|tell)(?:\s+([\s\S]*))?$/i);
	if (!match) return null;
	return (match[1] ?? "").trim();
}
function resolveSteerTargetSessionKey(params) {
	const commandTarget = normalizeOptionalString(params.ctx.CommandTargetSessionKey);
	const commandSession = normalizeOptionalString(params.sessionKey);
	const raw = isNativeCommandTurn(resolveCommandTurnContext(params.ctx)) ? commandTarget || commandSession : commandSession || commandTarget;
	if (!raw) return;
	const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
	return resolveInternalSessionKey({
		key: raw,
		alias,
		mainKey
	});
}
function resolveStoredSessionEntry(params, targetSessionKey) {
	if (params.sessionStore?.[targetSessionKey]) return params.sessionStore[targetSessionKey];
	if (params.sessionKey === targetSessionKey) return params.sessionEntry;
}
function resolveSteerSessionId(params) {
	const activeSessionId = resolveActiveEmbeddedRunSessionId(params.targetSessionKey);
	if (activeSessionId) return activeSessionId;
	const sessionId = normalizeOptionalString(resolveStoredSessionEntry(params.commandParams, params.targetSessionKey)?.sessionId);
	if (!sessionId || !isEmbeddedPiRunActive(sessionId)) return;
	return sessionId;
}
function applySteerFallbackPrompt(ctx, message) {
	const mutableCtx = ctx;
	mutableCtx.Body = message;
	mutableCtx.RawBody = message;
	mutableCtx.CommandBody = message;
	mutableCtx.BodyForCommands = message;
	mutableCtx.BodyForAgent = message;
	mutableCtx.BodyStripped = message;
}
function formatSteerError(err) {
	return err instanceof Error ? err.message : String(err);
}
function continueWithSteerFallback(params, message, logMessage) {
	logVerbose(logMessage);
	applySteerFallbackPrompt(params.ctx, message);
	if (params.rootCtx && params.rootCtx !== params.ctx) applySteerFallbackPrompt(params.rootCtx, message);
	params.command.rawBodyNormalized = message;
	params.command.commandBodyNormalized = message;
	return { shouldContinue: true };
}
const handleSteerCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const message = parseSteerMessage(params.command.commandBodyNormalized);
	if (message === null) return null;
	const unauthorized = rejectUnauthorizedCommand(params, "/steer");
	if (unauthorized) return unauthorized;
	if (!message) return {
		shouldContinue: false,
		reply: { text: STEER_USAGE }
	};
	const targetSessionKey = resolveSteerTargetSessionKey(params);
	if (!targetSessionKey) return continueWithSteerFallback(params, message, "steer: no current session; continuing with /steer payload as a normal prompt");
	const sessionId = resolveSteerSessionId({
		commandParams: params,
		targetSessionKey
	});
	if (!sessionId) return continueWithSteerFallback(params, message, `steer: no active run for ${targetSessionKey}; continuing with /steer payload as a normal prompt`);
	const queueOutcome = await queueEmbeddedPiMessageWithOutcomeAsync(sessionId, message, {
		steeringMode: "all",
		debounceMs: 0
	}).catch((err) => {
		return continueWithSteerFallback(params, message, `steer: active session ${sessionId} threw while steering: ${formatSteerError(err)}; continuing with /steer payload as a normal prompt`);
	});
	if ("shouldContinue" in queueOutcome) return queueOutcome;
	if (!queueOutcome.queued) return continueWithSteerFallback(params, message, `steer: active session ${sessionId} rejected steering injection: ${formatEmbeddedPiQueueFailureSummary(queueOutcome)}; continuing with /steer payload as a normal prompt`);
	return {
		shouldContinue: false,
		reply: { text: "steered current session." }
	};
};
//#endregion
//#region src/auto-reply/reply/commands-subagents.ts
const actionAgentsLoader = createLazyImportLoader(() => import("./action-agents-CxVZlXsH.js"));
const actionFocusLoader = createLazyImportLoader(() => import("./action-focus-B0N1-OeK.js"));
const actionHelpLoader = createLazyImportLoader(() => import("./action-help-CCI1_QB_.js"));
const actionInfoLoader = createLazyImportLoader(() => import("./action-info-Bcj74i9I.js"));
const actionKillLoader = createLazyImportLoader(() => import("./action-kill-ysWC4vmC.js"));
const actionListLoader = createLazyImportLoader(() => import("./action-list-BZlatD16.js"));
const actionLogLoader = createLazyImportLoader(() => import("./action-log-BNkXDUeg.js"));
const actionSendLoader = createLazyImportLoader(() => import("./action-send-B49hqOet.js"));
const actionSpawnLoader = createLazyImportLoader(() => import("./action-spawn-BreuCfX8.js"));
const actionUnfocusLoader = createLazyImportLoader(() => import("./action-unfocus-Bb7mLbvS.js"));
const controlRuntimeLoader = createLazyImportLoader(() => import("./commands-subagents-control.runtime-CgVlYjkN.js"));
function loadAgentsAction() {
	return actionAgentsLoader.load();
}
function loadFocusAction() {
	return actionFocusLoader.load();
}
function loadHelpAction() {
	return actionHelpLoader.load();
}
function loadInfoAction() {
	return actionInfoLoader.load();
}
function loadKillAction() {
	return actionKillLoader.load();
}
function loadListAction() {
	return actionListLoader.load();
}
function loadLogAction() {
	return actionLogLoader.load();
}
function loadSendAction() {
	return actionSendLoader.load();
}
function loadSpawnAction() {
	return actionSpawnLoader.load();
}
function loadUnfocusAction() {
	return actionUnfocusLoader.load();
}
function loadControlRuntime() {
	return controlRuntimeLoader.load();
}
const handleSubagentsCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	const handledPrefix = resolveHandledPrefix(normalized);
	if (!handledPrefix) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring ${handledPrefix} from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const restTokens = normalized.slice(handledPrefix.length).trim().split(/\s+/).filter(Boolean);
	const action = resolveSubagentsAction({
		handledPrefix,
		restTokens
	});
	if (!action) return (await loadHelpAction()).handleSubagentsHelpAction();
	const requesterKey = action === "spawn" ? resolveRequesterSessionKey(params, { preferCommandTarget: true }) : resolveRequesterSessionKey(params);
	if (!requesterKey) return stopWithText("⚠️ Missing session key.");
	const ctx = {
		params,
		handledPrefix,
		requesterKey,
		runs: (await loadControlRuntime()).listControlledSubagentRuns(requesterKey),
		restTokens
	};
	switch (action) {
		case "help": return (await loadHelpAction()).handleSubagentsHelpAction();
		case "agents": return (await loadAgentsAction()).handleSubagentsAgentsAction(ctx);
		case "focus": return await (await loadFocusAction()).handleSubagentsFocusAction(ctx);
		case "unfocus": return await (await loadUnfocusAction()).handleSubagentsUnfocusAction(ctx);
		case "list": return (await loadListAction()).handleSubagentsListAction(ctx);
		case "kill": return await (await loadKillAction()).handleSubagentsKillAction(ctx);
		case "info": return (await loadInfoAction()).handleSubagentsInfoAction(ctx);
		case "log": return await (await loadLogAction()).handleSubagentsLogAction(ctx);
		case "send": return await (await loadSendAction()).handleSubagentsSendAction(ctx, false);
		case "steer": return await (await loadSendAction()).handleSubagentsSendAction(ctx, true);
		case "spawn": return await (await loadSpawnAction()).handleSubagentsSpawnAction(ctx);
		default: return (await loadHelpAction()).handleSubagentsHelpAction();
	}
};
//#endregion
//#region src/auto-reply/reply/commands-tasks.ts
const MAX_VISIBLE_TASKS = 5;
const TASK_STATUS_ICONS = {
	queued: "🟡",
	running: "🟢",
	succeeded: "✅",
	failed: "🔴",
	timed_out: "⏱️",
	cancelled: "⚪️",
	lost: "⚠️"
};
const TASK_RUNTIME_LABELS = {
	subagent: "Subagent",
	acp: "ACP",
	cli: "CLI",
	cron: "Cron"
};
function formatTaskHeadline(snapshot) {
	if (snapshot.totalCount === 0) return "All clear - nothing linked to this session right now.";
	return `Current session: ${snapshot.activeCount} active · ${snapshot.totalCount} total`;
}
function formatAgentFallbackLine(agentId) {
	const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
	if (snapshot.totalCount === 0) return;
	return `Agent-local: ${snapshot.activeCount} active · ${snapshot.totalCount} total`;
}
function formatTaskTiming(task) {
	if (task.status === "running") {
		const startedAt = task.startedAt ?? task.createdAt;
		return `elapsed ${formatDurationCompact(Date.now() - startedAt, { spaced: true }) ?? "0s"}`;
	}
	if (task.status === "queued") return `queued ${formatTimeAgo(Date.now() - task.createdAt)}`;
	const endedAt = task.endedAt ?? task.lastEventAt ?? task.createdAt;
	return `finished ${formatTimeAgo(Date.now() - endedAt)}`;
}
function formatTaskDetail(task) {
	return formatTaskStatusDetail(task);
}
function formatVisibleTask(task, index) {
	const title = formatTaskStatusTitle(task);
	const status = task.status.replaceAll("_", " ");
	const timing = formatTaskTiming(task);
	const detail = formatTaskDetail(task);
	let meta = `${TASK_RUNTIME_LABELS[task.runtime]} · ${status}`;
	if (timing) meta += ` · ${timing}`;
	const lines = [`${index + 1}. ${TASK_STATUS_ICONS[task.status]} ${title}`, `   ${meta}`];
	if (detail) lines.push(`   ${detail}`);
	return lines.join("\n");
}
function buildTasksText(params) {
	const sessionSnapshot = buildTaskStatusSnapshot(listTasksForSessionKeyForStatus(params.sessionKey));
	const lines = ["📋 Tasks", formatTaskHeadline(sessionSnapshot)];
	if (sessionSnapshot.totalCount > 0) {
		const visible = sessionSnapshot.visible.slice(0, MAX_VISIBLE_TASKS);
		lines.push("");
		for (const [index, task] of visible.entries()) {
			lines.push(formatVisibleTask(task, index));
			if (index < visible.length - 1) lines.push("");
		}
		const hiddenCount = sessionSnapshot.visible.length - visible.length;
		if (hiddenCount > 0) lines.push("", `+${hiddenCount} more recent task${hiddenCount === 1 ? "" : "s"}`);
		return lines.join("\n");
	}
	const agentFallback = formatAgentFallbackLine(params.agentId);
	if (agentFallback) lines.push(agentFallback);
	return lines.join("\n");
}
async function buildTasksReply(params) {
	const agentId = resolveSessionAgentId({
		sessionKey: params.sessionKey,
		config: params.cfg
	});
	return { text: buildTasksText({
		sessionKey: params.sessionKey,
		agentId
	}) };
}
const handleTasksCommand = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const normalized = params.command.commandBodyNormalized;
	if (normalized !== "/tasks" && !normalized.startsWith("/tasks ")) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring /tasks from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	if (normalized !== "/tasks") return {
		shouldContinue: false,
		reply: { text: "Usage: /tasks" }
	};
	return {
		shouldContinue: false,
		reply: await buildTasksReply(params)
	};
};
//#endregion
//#region src/auto-reply/reply/commands-tts.ts
function parseTtsCommand(normalized) {
	if (normalized === "/tts") return {
		action: "status",
		args: ""
	};
	if (!normalized.startsWith("/tts ")) return null;
	const rest = normalized.slice(5).trim();
	if (!rest) return {
		action: "status",
		args: ""
	};
	const [action, ...tail] = rest.split(/\s+/);
	return {
		action: normalizeOptionalLowercaseString(action) ?? "",
		args: normalizeOptionalString(tail.join(" ")) ?? ""
	};
}
function formatAttemptDetails(attempts) {
	if (!attempts || attempts.length === 0) return;
	return attempts.map((attempt) => {
		const reason = attempt.reasonCode === "success" ? "ok" : attempt.reasonCode;
		const latency = Number.isFinite(attempt.latencyMs) ? ` ${attempt.latencyMs}ms` : "";
		const persona = attempt.persona && attempt.personaBinding && attempt.personaBinding !== "none" ? ` persona=${attempt.persona}:${attempt.personaBinding}` : "";
		return `${attempt.provider}:${attempt.outcome}(${reason})${persona}${latency}`;
	}).join(", ");
}
function ttsUsage() {
	return { text: "🔊 **TTS (Text-to-Speech) Help**\n\n**Commands:**\n• /tts on — Enable automatic TTS for replies\n• /tts off — Disable TTS\n• /tts status — Show current settings\n• /tts provider [name] — View/change provider\n• /tts persona [id|off] — View/change persona\n• /tts limit [number] — View/change text limit\n• /tts summary [on|off] — View/change auto-summary\n• /tts audio <text> — Generate audio from text\n• /tts latest — Read the latest assistant reply once\n• /tts chat on|off|default — Override auto-TTS for this chat\n\n**Providers:**\nUse /tts provider to list the registered speech providers and their status.\n\n**Text Limit (default: 1500, max: 4096):**\nWhen text exceeds the limit:\n• Summary ON: AI summarizes, then generates audio\n• Summary OFF: Truncates text, then generates audio\n\n**Examples:**\n/tts provider <id>\n/tts persona <id>\n/tts limit 2000\n/tts latest\n/tts audio Hello, this is a test!" };
}
function hashTtsReadLatestText(text) {
	return crypto.createHash("sha256").update(text).digest("hex");
}
async function buildTtsAudioReply(params) {
	const start = Date.now();
	const result = await textToSpeech({
		text: params.text,
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		prefsPath: params.prefsPath,
		agentId: params.agentId
	});
	if (result.success && result.audioPath) {
		setLastTtsAttempt({
			timestamp: Date.now(),
			success: true,
			textLength: params.text.length,
			summarized: false,
			provider: result.provider,
			persona: result.persona,
			fallbackFrom: result.fallbackFrom,
			attemptedProviders: result.attemptedProviders,
			attempts: result.attempts,
			latencyMs: result.latencyMs
		});
		return {
			provider: result.provider,
			reply: {
				mediaUrl: result.audioPath,
				audioAsVoice: result.audioAsVoice === true || result.voiceCompatible === true,
				trustedLocalMedia: true,
				spokenText: params.text
			}
		};
	}
	setLastTtsAttempt({
		timestamp: Date.now(),
		success: false,
		textLength: params.text.length,
		summarized: false,
		persona: result.persona,
		attemptedProviders: result.attemptedProviders,
		attempts: result.attempts,
		error: result.error,
		latencyMs: Date.now() - start
	});
	return { error: result.error ?? "unknown error" };
}
const handleTtsCommands = async (params, allowTextCommands) => {
	if (!allowTextCommands) return null;
	const parsed = parseTtsCommand(params.command.commandBodyNormalized);
	if (!parsed) return null;
	if (!params.command.isAuthorizedSender) {
		logVerbose(`Ignoring TTS command from unauthorized sender: ${params.command.senderId || "<unknown>"}`);
		return { shouldContinue: false };
	}
	const accountId = params.ctx?.AccountId;
	const config = resolveTtsConfig(params.cfg, {
		agentId: params.agentId,
		channelId: params.command.channel,
		accountId
	});
	const prefsPath = resolveTtsPrefsPath(config);
	const action = parsed.action;
	const args = parsed.args;
	if (action === "help") return {
		shouldContinue: false,
		reply: ttsUsage()
	};
	if (action === "on") {
		setTtsEnabled(prefsPath, true);
		return {
			shouldContinue: false,
			reply: { text: "🔊 TTS enabled." }
		};
	}
	if (action === "off") {
		setTtsEnabled(prefsPath, false);
		return {
			shouldContinue: false,
			reply: { text: "🔇 TTS disabled." }
		};
	}
	if (action === "chat") {
		const requested = normalizeOptionalLowercaseString(args) ?? "";
		if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) return {
			shouldContinue: false,
			reply: { text: "🔇 No active chat session is available for a chat-scoped TTS override." }
		};
		if (!requested || requested === "status") return {
			shouldContinue: false,
			reply: { text: `🔊 Chat TTS override: ${params.sessionEntry.ttsAuto ?? "default"}.` }
		};
		if (requested === "on") {
			params.sessionEntry.ttsAuto = "always";
			await persistSessionEntry(params);
			return {
				shouldContinue: false,
				reply: { text: "🔊 TTS enabled for this chat." }
			};
		}
		if (requested === "off") {
			params.sessionEntry.ttsAuto = "off";
			await persistSessionEntry(params);
			return {
				shouldContinue: false,
				reply: { text: "🔇 TTS disabled for this chat." }
			};
		}
		if (requested === "default" || requested === "inherit" || requested === "clear") {
			delete params.sessionEntry.ttsAuto;
			await persistSessionEntry(params);
			return {
				shouldContinue: false,
				reply: { text: "🔊 TTS chat override cleared." }
			};
		}
		return {
			shouldContinue: false,
			reply: ttsUsage()
		};
	}
	if (action === "latest" || action === "read" && normalizeOptionalLowercaseString(args) === "latest") {
		if (!params.sessionEntry || !params.sessionStore || !params.sessionKey) return {
			shouldContinue: false,
			reply: { text: "🎤 No active chat session is available for `/tts latest`." }
		};
		const latestText = (await readLatestAssistantTextFromSessionTranscript(params.sessionEntry.sessionFile))?.text.trim();
		if (!latestText || isSilentReplyPayloadText(latestText)) return {
			shouldContinue: false,
			reply: { text: "🎤 No readable assistant reply was found in this chat yet." }
		};
		const hash = hashTtsReadLatestText(latestText);
		if (params.sessionEntry.lastTtsReadLatestHash === hash) return {
			shouldContinue: false,
			reply: { text: "🔊 Latest assistant reply was already sent as audio." }
		};
		const audio = await buildTtsAudioReply({
			text: latestText,
			cfg: params.cfg,
			channel: params.command.channel,
			accountId,
			prefsPath,
			agentId: params.agentId
		});
		if ("error" in audio) return {
			shouldContinue: false,
			reply: { text: `❌ Error generating audio: ${audio.error}` }
		};
		params.sessionEntry.lastTtsReadLatestHash = hash;
		params.sessionEntry.lastTtsReadLatestAt = Date.now();
		await persistSessionEntry(params);
		return {
			shouldContinue: false,
			reply: audio.reply
		};
	}
	if (action === "audio") {
		if (!args.trim()) return {
			shouldContinue: false,
			reply: { text: "🎤 Generate audio from text.\n\nUsage: /tts audio <text>\nExample: /tts audio Hello, this is a test!" }
		};
		const audio = await buildTtsAudioReply({
			text: args,
			cfg: params.cfg,
			channel: params.command.channel,
			accountId,
			prefsPath,
			agentId: params.agentId
		});
		if (!("error" in audio)) return {
			shouldContinue: false,
			reply: audio.reply
		};
		return {
			shouldContinue: false,
			reply: { text: `❌ Error generating audio: ${audio.error}` }
		};
	}
	if (action === "provider") {
		const currentProvider = getTtsProvider(config, prefsPath);
		if (!args.trim()) {
			const providers = listSpeechProviders(params.cfg);
			return {
				shouldContinue: false,
				reply: { text: `🎙️ TTS provider\nPrimary: ${currentProvider}\n` + providers.map((provider) => `${provider.label}: ${provider.isConfigured({
					cfg: params.cfg,
					providerConfig: getResolvedSpeechProviderConfig(config, provider.id, params.cfg),
					timeoutMs: config.timeoutMs
				}) ? "✅" : "❌"}`).join("\n") + `\nUsage: /tts provider <id>` }
			};
		}
		const requested = normalizeOptionalLowercaseString(args) ?? "";
		const resolvedProvider = getSpeechProvider(requested, params.cfg);
		if (!resolvedProvider) return {
			shouldContinue: false,
			reply: ttsUsage()
		};
		const nextProvider = canonicalizeSpeechProviderId(requested, params.cfg) ?? resolvedProvider.id;
		setTtsProvider(prefsPath, nextProvider);
		return {
			shouldContinue: false,
			reply: { text: `✅ TTS provider set to ${nextProvider}.` }
		};
	}
	if (action === "persona") {
		const personas = listTtsPersonas(config);
		const activePersona = getTtsPersona(config, prefsPath);
		if (!args.trim()) return {
			shouldContinue: false,
			reply: { text: [
				"🎭 TTS persona",
				`Active: ${activePersona?.id ?? "none"}`,
				personas.length > 0 ? personas.map((persona) => {
					const label = persona.label ? ` (${persona.label})` : "";
					const provider = persona.provider ? ` provider=${persona.provider}` : "";
					return `${persona.id}${label}${provider}`;
				}).join("\n") : "No personas configured.",
				"Usage: /tts persona <id> | off"
			].join("\n") }
		};
		const requested = normalizeOptionalLowercaseString(args) ?? "";
		if (requested === "off" || requested === "none" || requested === "default") {
			setTtsPersona(prefsPath, null);
			return {
				shouldContinue: false,
				reply: { text: "✅ TTS persona disabled." }
			};
		}
		const persona = personas.find((entry) => entry.id === requested);
		if (!persona) return {
			shouldContinue: false,
			reply: { text: `❌ Unknown TTS persona: ${requested || args}.\nUse /tts persona to list configured personas.` }
		};
		setTtsPersona(prefsPath, persona.id);
		return {
			shouldContinue: false,
			reply: { text: `✅ TTS persona set to ${persona.id}.` }
		};
	}
	if (action === "limit") {
		if (!args.trim()) return {
			shouldContinue: false,
			reply: { text: `📏 TTS limit: ${getTtsMaxLength(prefsPath)} characters.\n\nText longer than this triggers summary (if enabled).\nRange: 100-4096 chars (Telegram max).\n\nTo change: /tts limit <number>\nExample: /tts limit 2000` }
		};
		const next = Number.parseInt(args.trim(), 10);
		if (!Number.isFinite(next) || next < 100 || next > 4096) return {
			shouldContinue: false,
			reply: { text: "❌ Limit must be between 100 and 4096 characters." }
		};
		setTtsMaxLength(prefsPath, next);
		return {
			shouldContinue: false,
			reply: { text: `✅ TTS limit set to ${next} characters.` }
		};
	}
	if (action === "summary") {
		if (!args.trim()) {
			const enabled = isSummarizationEnabled(prefsPath);
			const maxLen = getTtsMaxLength(prefsPath);
			return {
				shouldContinue: false,
				reply: { text: `📝 TTS auto-summary: ${enabled ? "on" : "off"}.\n\nWhen text exceeds ${maxLen} chars:\n• ON: summarizes text, then generates audio\n• OFF: truncates text, then generates audio\n\nTo change: /tts summary on | off` }
			};
		}
		const requested = normalizeOptionalLowercaseString(args) ?? "";
		if (requested !== "on" && requested !== "off") return {
			shouldContinue: false,
			reply: ttsUsage()
		};
		setSummarizationEnabled(prefsPath, requested === "on");
		return {
			shouldContinue: false,
			reply: { text: requested === "on" ? "✅ TTS auto-summary enabled." : "❌ TTS auto-summary disabled." }
		};
	}
	if (action === "status") {
		const enabled = isTtsEnabled(config, prefsPath);
		const provider = getTtsProvider(config, prefsPath);
		const persona = getTtsPersona(config, prefsPath);
		const hasKey = isTtsProviderConfigured(config, provider, params.cfg);
		const maxLength = getTtsMaxLength(prefsPath);
		const summarize = isSummarizationEnabled(prefsPath);
		const last = getLastTtsAttempt();
		const lines = [
			"📊 TTS status",
			`State: ${enabled ? "✅ enabled" : "❌ disabled"}`,
			`Chat override: ${params.sessionEntry?.ttsAuto ?? "default"}`,
			`Provider: ${provider} (${hasKey ? "✅ configured" : "❌ not configured"})`,
			`Persona: ${persona?.id ?? "none"}`,
			`Text limit: ${maxLength} chars`,
			`Auto-summary: ${summarize ? "on" : "off"}`
		];
		if (last) {
			const timeAgo = Math.round((Date.now() - last.timestamp) / 1e3);
			lines.push("");
			lines.push(`Last attempt (${timeAgo}s ago): ${last.success ? "✅" : "❌"}`);
			lines.push(`Text: ${last.textLength} chars${last.summarized ? " (summarized)" : ""}`);
			if (last.success) {
				lines.push(`Provider: ${last.provider ?? "unknown"}`);
				if (last.persona) lines.push(`Persona: ${last.persona}`);
				if (last.fallbackFrom && last.provider && last.fallbackFrom !== last.provider) lines.push(`Fallback: ${last.fallbackFrom} -> ${last.provider}`);
				if (last.attemptedProviders && last.attemptedProviders.length > 1) lines.push(`Attempts: ${last.attemptedProviders.join(" -> ")}`);
				const details = formatAttemptDetails(last.attempts);
				if (details) lines.push(`Attempt details: ${details}`);
				lines.push(`Latency: ${last.latencyMs ?? 0}ms`);
			} else if (last.error) {
				lines.push(`Error: ${last.error}`);
				if (last.attemptedProviders && last.attemptedProviders.length > 0) lines.push(`Attempts: ${last.attemptedProviders.join(" -> ")}`);
				const details = formatAttemptDetails(last.attempts);
				if (details) lines.push(`Attempt details: ${details}`);
			}
		}
		return {
			shouldContinue: false,
			reply: { text: lines.join("\n") }
		};
	}
	return {
		shouldContinue: false,
		reply: ttsUsage()
	};
};
//#endregion
//#region src/auto-reply/reply/commands-handlers.runtime.ts
function loadCommandHandlers() {
	return [
		handlePluginCommand,
		handleDockCommand,
		handleBtwCommand,
		handleBashCommand,
		handleActivationCommand,
		handleSendPolicyCommand,
		handleFastCommand,
		handleUsageCommand,
		handleSessionCommand,
		handleRestartCommand,
		handleTtsCommands,
		handleHelpCommand,
		handleCommandsListCommand,
		handleToolsCommand,
		handleStatusCommand,
		handleDiagnosticsCommand,
		handleTasksCommand,
		handleSteerCommand,
		handleAllowlistCommand,
		handleApproveCommand,
		handleContextCommand,
		handleExportSessionCommand,
		handleExportTrajectoryCommand,
		handleWhoamiCommand,
		handleCrestodianCommand,
		handleSubagentsCommand,
		handleAcpCommand,
		handleMcpCommand,
		handlePluginsCommand,
		handleConfigCommand,
		handleDebugCommand,
		handleModelsCommand,
		handleStopCommand,
		handleCompactCommand,
		handleAbortTrigger
	];
}
//#endregion
export { loadCommandHandlers };
