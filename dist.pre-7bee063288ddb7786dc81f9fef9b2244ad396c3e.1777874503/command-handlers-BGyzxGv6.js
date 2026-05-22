import { i as resolveCodexAppServerRuntimeOptions } from "./config-llzRy3Cd.js";
import { n as listCodexAppServerModels, t as listAllCodexAppServerModels } from "./models-L_-Mzhj-.js";
import { t as isJsonObject } from "./protocol-DaGkSRVf.js";
import { n as describeControlFailure, t as CODEX_CONTROL_METHODS } from "./capabilities-sDKDBj2U.js";
import { i as writeCodexAppServerBinding, n as readCodexAppServerBinding, t as clearCodexAppServerBinding } from "./session-binding-BHls0mWG.js";
import { a as parseCodexFastModeArg, c as setCodexConversationFastMode, d as steerCodexConversationTurn, f as stopCodexConversationTurn, i as formatPermissionsMode, l as setCodexConversationModel, m as resolveCodexDefaultWorkspaceDir, o as parseCodexPermissionsModeArg, p as readCodexConversationBindingData, r as startCodexConversationThread, s as readCodexConversationActiveTurn, u as setCodexConversationPermissions } from "./conversation-binding-DMLK5UNM.js";
import { i as requestCodexAppServerJson, n as installCodexComputerUse, r as readCodexComputerUseStatus } from "./computer-use-NfLJM7A_.js";
import crypto from "node:crypto";
//#region extensions/codex/src/command-formatters.ts
function formatCodexStatus(probes) {
	const lines = [`Codex app-server: ${probes.models.ok || probes.account.ok || probes.limits.ok || probes.mcps.ok || probes.skills.ok ? "connected" : "unavailable"}`];
	if (probes.models.ok) lines.push(`Models: ${probes.models.value.models.map((model) => model.id).slice(0, 8).join(", ") || "none"}`);
	else lines.push(`Models: ${probes.models.error}`);
	lines.push(`Account: ${probes.account.ok ? summarizeAccount(probes.account.value) : probes.account.error}`);
	lines.push(`Rate limits: ${probes.limits.ok ? summarizeArrayLike(probes.limits.value) : probes.limits.error}`);
	lines.push(`MCP servers: ${probes.mcps.ok ? summarizeArrayLike(probes.mcps.value) : probes.mcps.error}`);
	lines.push(`Skills: ${probes.skills.ok ? summarizeArrayLike(probes.skills.value) : probes.skills.error}`);
	return lines.join("\n");
}
function formatModels(result) {
	if (result.models.length === 0) return "No Codex app-server models returned.";
	const lines = ["Codex models:", ...result.models.map((model) => `- ${model.id}${model.isDefault ? " (default)" : ""}`)];
	if (result.truncated) lines.push("- More models available; output truncated.");
	return lines.join("\n");
}
function formatThreads(response) {
	const threads = extractArray(response);
	if (threads.length === 0) return "No Codex threads returned.";
	return ["Codex threads:", ...threads.slice(0, 10).map((thread) => {
		const record = isJsonObject(thread) ? thread : {};
		const id = readString(record, "threadId") ?? readString(record, "id") ?? "<unknown>";
		const title = readString(record, "title") ?? readString(record, "name") ?? readString(record, "summary");
		const details = [
			readString(record, "model"),
			readString(record, "cwd"),
			readString(record, "updatedAt") ?? readString(record, "lastUpdatedAt")
		].filter(Boolean);
		return `- ${id}${title ? ` - ${title}` : ""}${details.length > 0 ? ` (${details.join(", ")})` : ""}\n  Resume: /codex resume ${id}`;
	})].join("\n");
}
function formatAccount(account, limits) {
	return [`Account: ${account.ok ? summarizeAccount(account.value) : account.error}`, `Rate limits: ${limits.ok ? summarizeArrayLike(limits.value) : limits.error}`].join("\n");
}
function formatComputerUseStatus(status) {
	const lines = [`Computer Use: ${status.ready ? "ready" : status.enabled ? "not ready" : "disabled"}`];
	lines.push(`Plugin: ${status.pluginName} (${computerUsePluginState(status)})`);
	lines.push(`MCP server: ${status.mcpServerName}${status.mcpServerAvailable ? ` (${status.tools.length} tools)` : " (unavailable)"}`);
	if (status.marketplaceName) lines.push(`Marketplace: ${status.marketplaceName}`);
	if (status.tools.length > 0) lines.push(`Tools: ${status.tools.slice(0, 8).join(", ")}`);
	lines.push(status.message);
	return lines.join("\n");
}
function computerUsePluginState(status) {
	if (!status.installed) return "not installed";
	return status.pluginEnabled ? "installed" : "installed, disabled";
}
function formatList(response, label) {
	const entries = extractArray(response);
	if (entries.length === 0) return `${label}: none returned.`;
	return [`${label}:`, ...entries.slice(0, 25).map((entry) => {
		const record = isJsonObject(entry) ? entry : {};
		return `- ${readString(record, "name") ?? readString(record, "id") ?? JSON.stringify(entry)}`;
	})].join("\n");
}
function buildHelp() {
	return [
		"Codex commands:",
		"- /codex status",
		"- /codex models",
		"- /codex threads [filter]",
		"- /codex resume <thread-id>",
		"- /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]",
		"- /codex binding",
		"- /codex stop",
		"- /codex steer <message>",
		"- /codex model [model]",
		"- /codex fast [on|off|status]",
		"- /codex permissions [default|yolo|status]",
		"- /codex detach",
		"- /codex compact",
		"- /codex review",
		"- /codex diagnostics [note]",
		"- /codex computer-use [status|install]",
		"- /codex account",
		"- /codex mcp",
		"- /codex skills"
	].join("\n");
}
function summarizeAccount(value) {
	if (!isJsonObject(value)) return "unavailable";
	const account = isJsonObject(value.account) ? value.account : value;
	if (readString(account, "type") === "amazonBedrock") return "Amazon Bedrock";
	return readString(account, "email") ?? readString(account, "accountEmail") ?? readString(account, "planType") ?? readString(account, "id") ?? "available";
}
function summarizeArrayLike(value) {
	const entries = extractArray(value);
	if (entries.length === 0) return "none returned";
	return `${entries.length}`;
}
function extractArray(value) {
	if (Array.isArray(value)) return value;
	if (!isJsonObject(value)) return [];
	for (const key of [
		"data",
		"items",
		"threads",
		"models",
		"skills",
		"servers",
		"rateLimits"
	]) {
		const child = value[key];
		if (Array.isArray(child)) return child;
	}
	return [];
}
function readString(record, key) {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
//#endregion
//#region extensions/codex/src/command-rpc.ts
function requestOptions(pluginConfig, limit) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
	return {
		limit,
		timeoutMs: runtime.requestTimeoutMs,
		startOptions: runtime.start
	};
}
async function codexControlRequest(pluginConfig, method, requestParams) {
	const runtime = resolveCodexAppServerRuntimeOptions({ pluginConfig });
	return await requestCodexAppServerJson({
		method,
		requestParams,
		timeoutMs: runtime.requestTimeoutMs,
		startOptions: runtime.start
	});
}
async function safeCodexControlRequest(pluginConfig, method, requestParams) {
	return await safeValue(async () => await codexControlRequest(pluginConfig, method, requestParams));
}
async function safeCodexModelList(pluginConfig, limit) {
	return await safeValue(async () => await listCodexAppServerModels(requestOptions(pluginConfig, limit)));
}
async function readCodexStatusProbes(pluginConfig) {
	const [models, account, limits, mcps, skills] = await Promise.all([
		safeCodexModelList(pluginConfig, 20),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.account, { refreshToken: false }),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.rateLimits, void 0),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listMcpServers, { limit: 100 }),
		safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listSkills, {})
	]);
	return {
		models,
		account,
		limits,
		mcps,
		skills
	};
}
async function safeValue(read) {
	try {
		return {
			ok: true,
			value: await read()
		};
	} catch (error) {
		return {
			ok: false,
			error: describeControlFailure(error)
		};
	}
}
//#endregion
//#region extensions/codex/src/command-handlers.ts
const defaultCodexCommandDeps = {
	codexControlRequest,
	listCodexAppServerModels: listAllCodexAppServerModels,
	readCodexStatusProbes,
	readCodexAppServerBinding,
	requestOptions,
	safeCodexControlRequest,
	writeCodexAppServerBinding,
	clearCodexAppServerBinding,
	readCodexComputerUseStatus,
	installCodexComputerUse,
	resolveCodexDefaultWorkspaceDir,
	startCodexConversationThread,
	readCodexConversationActiveTurn,
	setCodexConversationFastMode,
	setCodexConversationModel,
	setCodexConversationPermissions,
	steerCodexConversationTurn,
	stopCodexConversationTurn
};
const CODEX_DIAGNOSTICS_SOURCE = "openclaw-diagnostics";
const CODEX_DIAGNOSTICS_REASON_MAX_CHARS = 2048;
const CODEX_DIAGNOSTICS_COOLDOWN_MS = 6e4;
const CODEX_DIAGNOSTICS_ERROR_MAX_CHARS = 500;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS = 100;
const CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS = 5 * 6e4;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE = 100;
const CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES = 100;
const CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS = 128;
const CODEX_RESUME_SAFE_THREAD_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const lastCodexDiagnosticsUploadByThread = /* @__PURE__ */ new Map();
const lastCodexDiagnosticsUploadByScope = /* @__PURE__ */ new Map();
const pendingCodexDiagnosticsConfirmations = /* @__PURE__ */ new Map();
const pendingCodexDiagnosticsConfirmationTokensByScope = /* @__PURE__ */ new Map();
async function handleCodexSubcommand(ctx, options) {
	const deps = {
		...defaultCodexCommandDeps,
		...options.deps
	};
	const [subcommand = "status", ...rest] = splitArgs(ctx.args);
	const normalized = subcommand.toLowerCase();
	if (normalized === "help") return { text: buildHelp() };
	if (normalized === "status") return { text: formatCodexStatus(await deps.readCodexStatusProbes(options.pluginConfig)) };
	if (normalized === "models") return { text: formatModels(await deps.listCodexAppServerModels(deps.requestOptions(options.pluginConfig, 100))) };
	if (normalized === "threads") return { text: await buildThreads(deps, options.pluginConfig, rest.join(" ")) };
	if (normalized === "resume") return { text: await resumeThread(deps, ctx, options.pluginConfig, rest[0]) };
	if (normalized === "bind") return await bindConversation(deps, ctx, options.pluginConfig, rest);
	if (normalized === "detach" || normalized === "unbind") return { text: await detachConversation(deps, ctx) };
	if (normalized === "binding") return { text: await describeConversationBinding(deps, ctx) };
	if (normalized === "stop") return { text: await stopConversationTurn(deps, ctx, options.pluginConfig) };
	if (normalized === "steer") return { text: await steerConversationTurn(deps, ctx, options.pluginConfig, rest.join(" ")) };
	if (normalized === "model") return { text: await setConversationModel(deps, ctx, options.pluginConfig, rest.join(" ")) };
	if (normalized === "fast") return { text: await setConversationFastMode(deps, ctx, options.pluginConfig, rest[0]) };
	if (normalized === "permissions") return { text: await setConversationPermissions(deps, ctx, options.pluginConfig, rest[0]) };
	if (normalized === "compact") return { text: await startThreadAction(deps, ctx, options.pluginConfig, CODEX_CONTROL_METHODS.compact, "compaction") };
	if (normalized === "review") return { text: await startThreadAction(deps, ctx, options.pluginConfig, CODEX_CONTROL_METHODS.review, "review") };
	if (normalized === "diagnostics") return await handleCodexDiagnosticsFeedback(deps, ctx, options.pluginConfig, rest.join(" "), "/codex diagnostics");
	if (normalized === "computer-use" || normalized === "computeruse") return { text: await handleComputerUseCommand(deps, options.pluginConfig, rest) };
	if (normalized === "mcp") return { text: formatList(await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listMcpServers, { limit: 100 }), "MCP servers") };
	if (normalized === "skills") return { text: formatList(await deps.codexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.listSkills, {}), "Codex skills") };
	if (normalized === "account") {
		const [account, limits] = await Promise.all([deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.account, { refreshToken: false }), deps.safeCodexControlRequest(options.pluginConfig, CODEX_CONTROL_METHODS.rateLimits, void 0)]);
		return { text: formatAccount(account, limits) };
	}
	return { text: `Unknown Codex command: ${subcommand}\n\n${buildHelp()}` };
}
async function handleComputerUseCommand(deps, pluginConfig, args) {
	const parsed = parseComputerUseArgs(args);
	if (parsed.help) return ["Usage: /codex computer-use [status|install] [--source <marketplace-source>] [--marketplace-path <path>] [--marketplace <name>]", "Checks or installs the configured Codex Computer Use plugin through app-server."].join("\n");
	const params = {
		pluginConfig,
		forceEnable: parsed.action === "install" || parsed.hasOverrides,
		...Object.keys(parsed.overrides).length > 0 ? { overrides: parsed.overrides } : {}
	};
	if (parsed.action === "install") return formatComputerUseStatus(await deps.installCodexComputerUse(params));
	return formatComputerUseStatus(await deps.readCodexComputerUseStatus(params));
}
async function bindConversation(deps, ctx, pluginConfig, args) {
	if (!ctx.sessionFile) return { text: "Cannot bind Codex because this command did not include an OpenClaw session file." };
	const parsed = parseBindArgs(args);
	if (parsed.help) return { text: "Usage: /codex bind [thread-id] [--cwd <path>] [--model <model>] [--provider <provider>]" };
	const workspaceDir = parsed.cwd ?? deps.resolveCodexDefaultWorkspaceDir(pluginConfig);
	const data = await deps.startCodexConversationThread({
		pluginConfig,
		sessionFile: ctx.sessionFile,
		workspaceDir,
		threadId: parsed.threadId,
		model: parsed.model,
		modelProvider: parsed.provider
	});
	const threadId = (await deps.readCodexAppServerBinding(ctx.sessionFile))?.threadId ?? parsed.threadId ?? "new thread";
	const summary = `Codex app-server thread ${threadId} in ${workspaceDir}`;
	let request;
	try {
		request = await ctx.requestConversationBinding({
			summary,
			detachHint: "/codex detach",
			data
		});
	} catch (error) {
		await deps.clearCodexAppServerBinding(ctx.sessionFile);
		throw error;
	}
	if (request.status === "bound") return { text: `Bound this conversation to Codex thread ${threadId} in ${workspaceDir}.` };
	if (request.status === "pending") return request.reply;
	await deps.clearCodexAppServerBinding(ctx.sessionFile);
	return { text: request.message };
}
async function detachConversation(deps, ctx) {
	const data = readCodexConversationBindingData(await ctx.getCurrentConversationBinding());
	const detached = await ctx.detachConversationBinding();
	if (data) await deps.clearCodexAppServerBinding(data.sessionFile);
	else if (ctx.sessionFile) await deps.clearCodexAppServerBinding(ctx.sessionFile);
	return detached.removed ? "Detached this conversation from Codex." : "No Codex conversation binding was attached.";
}
async function describeConversationBinding(deps, ctx) {
	const current = await ctx.getCurrentConversationBinding();
	const data = readCodexConversationBindingData(current);
	if (!current || !data) return "No Codex conversation binding is attached.";
	const threadBinding = await deps.readCodexAppServerBinding(data.sessionFile);
	const active = deps.readCodexConversationActiveTurn(data.sessionFile);
	return [
		"Codex conversation binding:",
		`- Thread: ${threadBinding?.threadId ?? "unknown"}`,
		`- Workspace: ${data.workspaceDir}`,
		`- Model: ${threadBinding?.model ?? "default"}`,
		`- Fast: ${threadBinding?.serviceTier === "fast" ? "on" : "off"}`,
		`- Permissions: ${threadBinding ? formatPermissionsMode(threadBinding) : "default"}`,
		`- Active run: ${active ? active.turnId : "none"}`,
		`- Session: ${data.sessionFile}`
	].join("\n");
}
async function buildThreads(deps, pluginConfig, filter) {
	return formatThreads(await deps.codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.listThreads, {
		limit: 10,
		...filter.trim() ? { searchTerm: filter.trim() } : {}
	}));
}
async function resumeThread(deps, ctx, pluginConfig, threadId) {
	const normalizedThreadId = threadId?.trim();
	if (!normalizedThreadId) return "Usage: /codex resume <thread-id>";
	if (!ctx.sessionFile) return "Cannot attach a Codex thread because this command did not include an OpenClaw session file.";
	const response = await deps.codexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.resumeThread, {
		threadId: normalizedThreadId,
		persistExtendedHistory: true
	});
	const thread = isJsonObject(response) && isJsonObject(response.thread) ? response.thread : {};
	const effectiveThreadId = readString(thread, "id") ?? normalizedThreadId;
	await deps.writeCodexAppServerBinding(ctx.sessionFile, {
		threadId: effectiveThreadId,
		cwd: readString(thread, "cwd") ?? "",
		model: isJsonObject(response) ? readString(response, "model") : void 0,
		modelProvider: isJsonObject(response) ? readString(response, "modelProvider") : void 0
	});
	return `Attached this OpenClaw session to Codex thread ${effectiveThreadId}.`;
}
async function stopConversationTurn(deps, ctx, pluginConfig) {
	const sessionFile = await resolveControlSessionFile(ctx);
	if (!sessionFile) return "Cannot stop Codex because this command did not include an OpenClaw session file.";
	return (await deps.stopCodexConversationTurn({
		sessionFile,
		pluginConfig
	})).message;
}
async function steerConversationTurn(deps, ctx, pluginConfig, message) {
	const sessionFile = await resolveControlSessionFile(ctx);
	if (!sessionFile) return "Cannot steer Codex because this command did not include an OpenClaw session file.";
	return (await deps.steerCodexConversationTurn({
		sessionFile,
		pluginConfig,
		message
	})).message;
}
async function setConversationModel(deps, ctx, pluginConfig, model) {
	const sessionFile = await resolveControlSessionFile(ctx);
	if (!sessionFile) return "Cannot set Codex model because this command did not include an OpenClaw session file.";
	const normalized = model.trim();
	if (!normalized) {
		const binding = await deps.readCodexAppServerBinding(sessionFile);
		return binding?.model ? `Codex model: ${binding.model}` : "Usage: /codex model <model>";
	}
	return await deps.setCodexConversationModel({
		sessionFile,
		pluginConfig,
		model: normalized
	});
}
async function setConversationFastMode(deps, ctx, pluginConfig, value) {
	const sessionFile = await resolveControlSessionFile(ctx);
	if (!sessionFile) return "Cannot set Codex fast mode because this command did not include an OpenClaw session file.";
	const parsed = parseCodexFastModeArg(value);
	if (value && parsed == null && value.trim().toLowerCase() !== "status") return "Usage: /codex fast [on|off|status]";
	return await deps.setCodexConversationFastMode({
		sessionFile,
		pluginConfig,
		enabled: parsed
	});
}
async function setConversationPermissions(deps, ctx, pluginConfig, value) {
	const sessionFile = await resolveControlSessionFile(ctx);
	if (!sessionFile) return "Cannot set Codex permissions because this command did not include an OpenClaw session file.";
	const parsed = parseCodexPermissionsModeArg(value);
	if (value && !parsed && value.trim().toLowerCase() !== "status") return "Usage: /codex permissions [default|yolo|status]";
	return await deps.setCodexConversationPermissions({
		sessionFile,
		pluginConfig,
		mode: parsed
	});
}
async function resolveControlSessionFile(ctx) {
	return readCodexConversationBindingData(await ctx.getCurrentConversationBinding())?.sessionFile ?? ctx.sessionFile;
}
async function handleCodexDiagnosticsFeedback(deps, ctx, pluginConfig, args, commandPrefix) {
	if (ctx.senderIsOwner !== true) return { text: "Only an owner can send Codex diagnostics." };
	const parsed = parseDiagnosticsArgs(args);
	if (parsed.action === "confirm") return { text: await confirmCodexDiagnosticsFeedback(deps, ctx, pluginConfig, parsed.token) };
	if (parsed.action === "cancel") return { text: cancelCodexDiagnosticsFeedback(ctx, parsed.token) };
	if (ctx.diagnosticsUploadApproved === true) return { text: await sendCodexDiagnosticsFeedbackForContext(deps, ctx, pluginConfig, parsed.note) };
	if (ctx.diagnosticsPreviewOnly === true) return { text: await previewCodexDiagnosticsFeedbackApproval(deps, ctx, parsed.note) };
	return await requestCodexDiagnosticsFeedbackApproval(deps, ctx, pluginConfig, parsed.note, commandPrefix);
}
async function requestCodexDiagnosticsFeedbackApproval(deps, ctx, pluginConfig, note, commandPrefix) {
	if (!await hasAnyCodexDiagnosticsSessionFile(ctx)) return { text: "Cannot send Codex diagnostics because this command did not include an OpenClaw session file." };
	const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
	if (targets.length === 0) return { text: ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n") };
	const now = Date.now();
	const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now);
	if (cooldownMessage) return { text: cooldownMessage };
	if (!ctx.senderId) return { text: "Cannot send Codex diagnostics because this command did not include a sender identity." };
	const reason = normalizeDiagnosticsReason(note);
	const token = createCodexDiagnosticsConfirmation({
		targets,
		note: reason,
		senderId: ctx.senderId,
		channel: ctx.channel,
		scopeKey: readCodexDiagnosticsCooldownScope(ctx),
		privateRouted: ctx.diagnosticsPrivateRouted === true,
		...readCodexDiagnosticsConfirmationScope(ctx),
		now
	});
	const confirmCommand = `${commandPrefix} confirm ${token}`;
	const cancelCommand = `${commandPrefix} cancel ${token}`;
	const displayReason = reason ? escapeCodexChatText(formatCodexTextForDisplay(reason)) : void 0;
	return {
		text: [
			targets.length === 1 ? "Codex runtime thread detected." : "Codex runtime threads detected.",
			`Codex diagnostics can send ${targets.length === 1 ? "this thread's feedback bundle" : "these threads' feedback bundles"} to OpenAI servers.`,
			"Codex sessions:",
			...formatCodexDiagnosticsTargetLines(targets),
			...displayReason ? [`Note: ${displayReason}`] : [],
			"Included: Codex logs and spawned Codex subthreads when available.",
			`To send: ${confirmCommand}`,
			`To cancel: ${cancelCommand}`,
			"This request expires in 5 minutes."
		].join("\n"),
		interactive: { blocks: [{
			type: "buttons",
			buttons: [{
				label: "Send diagnostics",
				value: confirmCommand,
				style: "danger"
			}, {
				label: "Cancel",
				value: cancelCommand,
				style: "secondary"
			}]
		}] }
	};
}
async function previewCodexDiagnosticsFeedbackApproval(deps, ctx, note) {
	if (!await hasAnyCodexDiagnosticsSessionFile(ctx)) return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
	const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
	if (targets.length === 0) return ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n");
	const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, Date.now(), { includeThreadId: false });
	if (cooldownMessage) return cooldownMessage;
	const reason = normalizeDiagnosticsReason(note);
	const displayReason = reason ? escapeCodexChatText(formatCodexTextForDisplay(reason)) : void 0;
	return [
		targets.length === 1 ? "Codex runtime thread detected." : "Codex runtime threads detected.",
		`Approving diagnostics will also send ${targets.length === 1 ? "this thread's feedback bundle" : "these threads' feedback bundles"} to OpenAI servers.`,
		"The completed diagnostics reply will list the OpenClaw session ids and Codex thread ids that were sent.",
		...displayReason ? [`Note: ${displayReason}`] : [],
		"Included: Codex logs and spawned Codex subthreads when available."
	].join("\n");
}
async function confirmCodexDiagnosticsFeedback(deps, ctx, pluginConfig, token) {
	const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
	if (!pending) return "No pending Codex diagnostics confirmation was found. Run /diagnostics again to create a fresh request.";
	if (!pending.senderId || !ctx.senderId) return "Cannot confirm Codex diagnostics because this command did not include the original sender identity.";
	if (pending.senderId !== ctx.senderId) return "Only the user who requested these Codex diagnostics can confirm the upload.";
	if (pending.channel !== ctx.channel) return "This Codex diagnostics confirmation belongs to a different channel.";
	const scopeMismatch = readCodexDiagnosticsScopeMismatch(pending, ctx);
	if (scopeMismatch) return scopeMismatch.confirmMessage;
	deletePendingCodexDiagnosticsConfirmation(token);
	if (!pending.privateRouted && !await hasAnyCodexDiagnosticsSessionFile(ctx)) return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
	const currentTargets = pending.privateRouted ? await resolvePendingCodexDiagnosticsTargets(deps, pending.targets) : await resolveCodexDiagnosticsTargets(deps, ctx);
	if (!codexDiagnosticsTargetsMatch(pending.targets, currentTargets)) return "The Codex diagnostics sessions changed before confirmation. Run /diagnostics again for the current threads.";
	return await sendCodexDiagnosticsFeedbackForTargets(deps, ctx, pluginConfig, pending.note ?? "", pending.targets);
}
function cancelCodexDiagnosticsFeedback(ctx, token) {
	const pending = readPendingCodexDiagnosticsConfirmation(token, Date.now());
	if (!pending) return "No pending Codex diagnostics confirmation was found.";
	if (!pending.senderId || !ctx.senderId) return "Cannot cancel Codex diagnostics because this command did not include the original sender identity.";
	if (pending.senderId !== ctx.senderId) return "Only the user who requested these Codex diagnostics can cancel the upload.";
	if (pending.channel !== ctx.channel) return "This Codex diagnostics confirmation belongs to a different channel.";
	const scopeMismatch = readCodexDiagnosticsScopeMismatch(pending, ctx);
	if (scopeMismatch) return scopeMismatch.cancelMessage;
	deletePendingCodexDiagnosticsConfirmation(token);
	return [
		"Codex diagnostics upload canceled.",
		"Codex sessions:",
		...formatCodexDiagnosticsTargetLines(pending.targets)
	].join("\n");
}
async function sendCodexDiagnosticsFeedbackForContext(deps, ctx, pluginConfig, note) {
	if (!await hasAnyCodexDiagnosticsSessionFile(ctx)) return "Cannot send Codex diagnostics because this command did not include an OpenClaw session file.";
	const targets = await resolveCodexDiagnosticsTargets(deps, ctx);
	if (targets.length === 0) return ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n");
	return await sendCodexDiagnosticsFeedbackForTargets(deps, ctx, pluginConfig, note, targets);
}
async function sendCodexDiagnosticsFeedbackForTargets(deps, ctx, pluginConfig, note, targets) {
	if (targets.length === 0) return ["No Codex thread is attached to this OpenClaw session yet.", "Use /codex threads to find a thread, then /codex resume <thread-id> before sending diagnostics."].join("\n");
	const now = Date.now();
	const cooldownMessage = readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now);
	if (cooldownMessage) return cooldownMessage;
	const reason = normalizeDiagnosticsReason(note);
	const sent = [];
	const failed = [];
	for (const target of targets) {
		const response = await deps.safeCodexControlRequest(pluginConfig, CODEX_CONTROL_METHODS.feedback, {
			classification: "bug",
			threadId: target.threadId,
			includeLogs: true,
			tags: buildDiagnosticsTags(ctx),
			...reason ? { reason } : {}
		});
		if (!response.ok) {
			failed.push({
				target,
				error: response.error
			});
			continue;
		}
		const responseThreadId = isJsonObject(response.value) ? readString(response.value, "threadId") : void 0;
		sent.push({
			...target,
			threadId: responseThreadId ?? target.threadId
		});
		recordCodexDiagnosticsUpload(target.threadId, ctx, now);
	}
	return formatCodexDiagnosticsUploadResult(sent, failed);
}
async function hasAnyCodexDiagnosticsSessionFile(ctx) {
	if (await resolveControlSessionFile(ctx)) return true;
	return (ctx.diagnosticsSessions ?? []).some((session) => Boolean(session.sessionFile));
}
async function resolveCodexDiagnosticsTargets(deps, ctx) {
	const activeSessionFile = await resolveControlSessionFile(ctx);
	const candidates = [];
	if (activeSessionFile) candidates.push({
		threadId: "",
		sessionFile: activeSessionFile,
		sessionKey: ctx.sessionKey,
		sessionId: ctx.sessionId,
		channel: ctx.channel,
		channelId: ctx.channelId,
		accountId: ctx.accountId,
		messageThreadId: ctx.messageThreadId,
		threadParentId: ctx.threadParentId
	});
	for (const session of ctx.diagnosticsSessions ?? []) {
		if (!session.sessionFile) continue;
		candidates.push({
			threadId: "",
			sessionFile: session.sessionFile,
			sessionKey: session.sessionKey,
			sessionId: session.sessionId,
			channel: session.channel,
			channelId: session.channelId,
			accountId: session.accountId,
			messageThreadId: session.messageThreadId,
			threadParentId: session.threadParentId
		});
	}
	const seenSessionFiles = /* @__PURE__ */ new Set();
	const seenThreadIds = /* @__PURE__ */ new Set();
	const targets = [];
	for (const candidate of candidates) {
		if (seenSessionFiles.has(candidate.sessionFile)) continue;
		seenSessionFiles.add(candidate.sessionFile);
		const binding = await deps.readCodexAppServerBinding(candidate.sessionFile);
		if (!binding?.threadId || seenThreadIds.has(binding.threadId)) continue;
		seenThreadIds.add(binding.threadId);
		targets.push({
			...candidate,
			threadId: binding.threadId
		});
	}
	return targets;
}
async function resolvePendingCodexDiagnosticsTargets(deps, targets) {
	const resolved = [];
	for (const target of targets) {
		const binding = await deps.readCodexAppServerBinding(target.sessionFile);
		if (!binding?.threadId) continue;
		resolved.push({
			...target,
			threadId: binding.threadId
		});
	}
	return resolved;
}
function codexDiagnosticsTargetsMatch(expected, actual) {
	const expectedThreadIds = expected.map((target) => target.threadId).toSorted();
	const actualThreadIds = actual.map((target) => target.threadId).toSorted();
	return expectedThreadIds.length === actualThreadIds.length && expectedThreadIds.every((threadId, index) => threadId === actualThreadIds[index]);
}
function formatCodexDiagnosticsUploadResult(sent, failed) {
	const lines = [];
	if (sent.length > 0) {
		lines.push("Codex diagnostics sent to OpenAI servers:");
		lines.push(...formatCodexDiagnosticsTargetLines(sent));
		lines.push("Included Codex logs and spawned Codex subthreads when available.");
	}
	if (failed.length > 0) {
		if (lines.length > 0) lines.push("");
		lines.push("Could not send Codex diagnostics:");
		lines.push(...failed.map(({ target, error }) => `${formatCodexDiagnosticsTargetLine(target)}: ${formatCodexErrorForDisplay(error)}`));
		lines.push("Inspect locally:");
		lines.push(...failed.map(({ target }) => `- ${formatCodexResumeCommandForDisplay(target.threadId)}`));
	}
	return lines.join("\n");
}
function formatCodexDiagnosticsTargetLines(targets) {
	return targets.flatMap((target, index) => {
		const lines = formatCodexDiagnosticsTargetBlock(target, index);
		return index < targets.length - 1 ? [...lines, ""] : lines;
	});
}
function formatCodexDiagnosticsTargetBlock(target, index) {
	const lines = [`Session ${index + 1}`];
	if (target.channel) lines.push(`Channel: ${formatCodexValueForDisplay(target.channel)}`);
	if (target.sessionKey) lines.push(`OpenClaw session key: ${formatCodexCopyableValueForDisplay(target.sessionKey)}`);
	if (target.sessionId) lines.push(`OpenClaw session id: ${formatCodexCopyableValueForDisplay(target.sessionId)}`);
	lines.push(`Codex thread id: ${formatCodexCopyableValueForDisplay(target.threadId)}`);
	lines.push(`Inspect locally: ${formatCodexResumeCommandForDisplay(target.threadId)}`);
	return lines;
}
function formatCodexDiagnosticsTargetLine(target) {
	const parts = [];
	if (target.channel) parts.push(`channel ${formatCodexValueForDisplay(target.channel)}`);
	const sessionLabel = target.sessionId || target.sessionKey;
	if (sessionLabel) parts.push(`OpenClaw session ${formatCodexValueForDisplay(sessionLabel)}`);
	parts.push(`Codex thread ${formatCodexThreadIdForDisplay(target.threadId)}`);
	return `- ${parts.join(", ")}`;
}
function normalizeDiagnosticsReason(note) {
	const normalized = normalizeOptionalString(note);
	return normalized ? normalized.slice(0, CODEX_DIAGNOSTICS_REASON_MAX_CHARS) : void 0;
}
function parseDiagnosticsArgs(args) {
	const [action, token] = splitArgs(args);
	const normalizedAction = action?.toLowerCase();
	if ((normalizedAction === "confirm" || normalizedAction === "--confirm") && token) return {
		action: "confirm",
		token
	};
	if ((normalizedAction === "cancel" || normalizedAction === "--cancel") && token) return {
		action: "cancel",
		token
	};
	return {
		action: "request",
		note: args
	};
}
function createCodexDiagnosticsConfirmation(params) {
	prunePendingCodexDiagnosticsConfirmations(params.now);
	if (!pendingCodexDiagnosticsConfirmationTokensByScope.has(params.scopeKey) && pendingCodexDiagnosticsConfirmationTokensByScope.size >= CODEX_DIAGNOSTICS_CONFIRMATION_MAX_SCOPES) {
		const oldestScopeKey = pendingCodexDiagnosticsConfirmationTokensByScope.keys().next().value;
		if (typeof oldestScopeKey === "string") deletePendingCodexDiagnosticsConfirmationScope(oldestScopeKey);
	}
	const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(params.scopeKey) ?? [];
	while (scopeTokens.length >= CODEX_DIAGNOSTICS_CONFIRMATION_MAX_REQUESTS_PER_SCOPE) {
		const oldestToken = scopeTokens.shift();
		if (!oldestToken) break;
		pendingCodexDiagnosticsConfirmations.delete(oldestToken);
	}
	const token = crypto.randomBytes(6).toString("hex");
	scopeTokens.push(token);
	pendingCodexDiagnosticsConfirmationTokensByScope.set(params.scopeKey, scopeTokens);
	pendingCodexDiagnosticsConfirmations.set(token, {
		token,
		targets: params.targets,
		note: params.note,
		senderId: params.senderId,
		channel: params.channel,
		accountId: params.accountId,
		channelId: params.channelId,
		messageThreadId: params.messageThreadId,
		threadParentId: params.threadParentId,
		sessionKey: params.sessionKey,
		scopeKey: params.scopeKey,
		...params.privateRouted === void 0 ? {} : { privateRouted: params.privateRouted },
		createdAt: params.now
	});
	return token;
}
function readCodexDiagnosticsConfirmationScope(ctx) {
	return {
		accountId: normalizeCodexDiagnosticsScopeField(ctx.accountId),
		channelId: normalizeCodexDiagnosticsScopeField(ctx.channelId),
		messageThreadId: typeof ctx.messageThreadId === "string" || typeof ctx.messageThreadId === "number" ? normalizeCodexDiagnosticsScopeField(String(ctx.messageThreadId)) : void 0,
		threadParentId: normalizeCodexDiagnosticsScopeField(ctx.threadParentId),
		sessionKey: normalizeCodexDiagnosticsScopeField(ctx.sessionKey)
	};
}
function readCodexDiagnosticsScopeMismatch(pending, ctx) {
	const current = readCodexDiagnosticsConfirmationScope(ctx);
	if (pending.accountId !== current.accountId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different account.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different account."
	};
	if (pending.privateRouted) return;
	if (pending.channelId !== current.channelId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different channel instance.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different channel instance."
	};
	if (pending.messageThreadId !== current.messageThreadId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different thread.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different thread."
	};
	if (pending.threadParentId !== current.threadParentId) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different parent thread.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different parent thread."
	};
	if (pending.sessionKey !== current.sessionKey) return {
		confirmMessage: "This Codex diagnostics confirmation belongs to a different session.",
		cancelMessage: "This Codex diagnostics confirmation belongs to a different session."
	};
}
function readPendingCodexDiagnosticsConfirmation(token, now) {
	prunePendingCodexDiagnosticsConfirmations(now);
	return pendingCodexDiagnosticsConfirmations.get(token);
}
function prunePendingCodexDiagnosticsConfirmations(now) {
	for (const [token, pending] of pendingCodexDiagnosticsConfirmations) if (now - pending.createdAt >= CODEX_DIAGNOSTICS_CONFIRMATION_TTL_MS) deletePendingCodexDiagnosticsConfirmation(token);
}
function deletePendingCodexDiagnosticsConfirmation(token) {
	const pending = pendingCodexDiagnosticsConfirmations.get(token);
	pendingCodexDiagnosticsConfirmations.delete(token);
	if (!pending) return;
	const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(pending.scopeKey);
	if (!scopeTokens) return;
	const tokenIndex = scopeTokens.indexOf(token);
	if (tokenIndex >= 0) scopeTokens.splice(tokenIndex, 1);
	if (scopeTokens.length === 0) pendingCodexDiagnosticsConfirmationTokensByScope.delete(pending.scopeKey);
}
function deletePendingCodexDiagnosticsConfirmationScope(scopeKey) {
	const scopeTokens = pendingCodexDiagnosticsConfirmationTokensByScope.get(scopeKey) ?? [];
	for (const token of scopeTokens) pendingCodexDiagnosticsConfirmations.delete(token);
	pendingCodexDiagnosticsConfirmationTokensByScope.delete(scopeKey);
}
function buildDiagnosticsTags(ctx) {
	const tags = { source: CODEX_DIAGNOSTICS_SOURCE };
	addTag(tags, "channel", ctx.channel);
	return tags;
}
function addTag(tags, key, value) {
	if (typeof value === "string" && value.trim()) tags[key] = value.trim();
}
function formatCodexThreadIdForDisplay(threadId) {
	return escapeCodexChatText(formatCodexTextForDisplay(threadId));
}
function formatCodexValueForDisplay(value) {
	return escapeCodexChatText(formatCodexTextForDisplay(value));
}
function formatCodexCopyableValueForDisplay(value) {
	const safe = formatCodexTextForDisplay(value);
	if (CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safe)) return `\`${safe}\``;
	return escapeCodexChatText(safe);
}
function formatCodexTextForDisplay(value) {
	let safe = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		safe += codePoint != null && isUnsafeDisplayCodePoint(codePoint) ? "?" : character;
	}
	safe = safe.trim();
	return safe || "<unknown>";
}
function escapeCodexChatText(value) {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("@", "＠").replaceAll("`", "｀").replaceAll("[", "［").replaceAll("]", "］").replaceAll("(", "（").replaceAll(")", "）").replaceAll("*", "∗").replaceAll("_", "＿").replaceAll("~", "～").replaceAll("|", "｜");
}
function readCodexDiagnosticsCooldownMs(threadId, now) {
	const lastSentAt = lastCodexDiagnosticsUploadByThread.get(threadId);
	if (!lastSentAt) return 0;
	const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
	if (remainingMs === 0) lastCodexDiagnosticsUploadByThread.delete(threadId);
	return remainingMs;
}
function readCodexDiagnosticsTargetsCooldownMessage(targets, ctx, now, options = {}) {
	for (const target of targets) {
		const cooldownMs = readCodexDiagnosticsCooldownMs(target.threadId, now);
		if (cooldownMs > 0) {
			if (options.includeThreadId === false) return `Codex diagnostics were already sent for one of these Codex threads recently. Try again in ${Math.ceil(cooldownMs / 1e3)}s.`;
			return `Codex diagnostics were already sent for thread ${formatCodexThreadIdForDisplay(target.threadId)} recently. Try again in ${Math.ceil(cooldownMs / 1e3)}s.`;
		}
	}
	const scopeCooldownMs = readCodexDiagnosticsScopeCooldownMs(readCodexDiagnosticsCooldownScope(ctx), now);
	if (scopeCooldownMs > 0) return `Codex diagnostics were already sent for this account or channel recently. Try again in ${Math.ceil(scopeCooldownMs / 1e3)}s.`;
}
function readCodexDiagnosticsScopeCooldownMs(scope, now) {
	const lastSentAt = lastCodexDiagnosticsUploadByScope.get(scope);
	if (!lastSentAt) return 0;
	const remainingMs = Math.max(0, CODEX_DIAGNOSTICS_COOLDOWN_MS - (now - lastSentAt));
	if (remainingMs === 0) lastCodexDiagnosticsUploadByScope.delete(scope);
	return remainingMs;
}
function recordCodexDiagnosticsUpload(threadId, ctx, now) {
	pruneCodexDiagnosticsCooldowns(now);
	recordBoundedCodexDiagnosticsCooldown(lastCodexDiagnosticsUploadByScope, readCodexDiagnosticsCooldownScope(ctx), CODEX_DIAGNOSTICS_COOLDOWN_MAX_SCOPES, now);
	recordBoundedCodexDiagnosticsCooldown(lastCodexDiagnosticsUploadByThread, threadId, CODEX_DIAGNOSTICS_COOLDOWN_MAX_THREADS, now);
}
function recordBoundedCodexDiagnosticsCooldown(map, key, maxSize, now) {
	if (!map.has(key)) while (map.size >= maxSize) {
		const oldestKey = map.keys().next().value;
		if (typeof oldestKey !== "string") break;
		map.delete(oldestKey);
	}
	map.set(key, now);
}
function readCodexDiagnosticsCooldownScope(ctx) {
	const scope = readCodexDiagnosticsConfirmationScope(ctx);
	const payload = JSON.stringify({
		accountId: scope.accountId ?? null,
		channelId: scope.channelId ?? null,
		sessionKey: scope.sessionKey ?? null,
		messageThreadId: scope.messageThreadId ?? null,
		threadParentId: scope.threadParentId ?? null,
		senderId: normalizeCodexDiagnosticsScopeField(ctx.senderId) ?? null,
		channel: normalizeCodexDiagnosticsScopeField(ctx.channel) ?? ""
	});
	return crypto.createHash("sha256").update(payload).digest("hex");
}
function pruneCodexDiagnosticsCooldowns(now) {
	pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByThread, now);
	pruneCodexDiagnosticsCooldownMap(lastCodexDiagnosticsUploadByScope, now);
}
function pruneCodexDiagnosticsCooldownMap(map, now) {
	for (const [key, lastSentAt] of map) if (now - lastSentAt >= CODEX_DIAGNOSTICS_COOLDOWN_MS) map.delete(key);
}
function formatCodexErrorForDisplay(error) {
	return escapeCodexChatText(formatCodexTextForDisplay(error).slice(0, CODEX_DIAGNOSTICS_ERROR_MAX_CHARS)) || "unknown error";
}
function formatCodexResumeCommandForDisplay(threadId) {
	const safeThreadId = formatCodexTextForDisplay(threadId);
	if (!CODEX_RESUME_SAFE_THREAD_ID_PATTERN.test(safeThreadId)) return "run codex resume and paste the thread id shown above";
	return `\`codex resume ${safeThreadId}\``;
}
function isUnsafeDisplayCodePoint(codePoint) {
	return codePoint <= 31 || codePoint >= 127 && codePoint <= 159 || codePoint === 173 || codePoint === 1564 || codePoint === 6158 || codePoint >= 8203 && codePoint <= 8207 || codePoint >= 8234 && codePoint <= 8238 || codePoint >= 8288 && codePoint <= 8303 || codePoint === 65279 || codePoint >= 65529 && codePoint <= 65531 || codePoint >= 917504 && codePoint <= 917631;
}
function normalizeCodexDiagnosticsScopeField(value) {
	const normalized = normalizeOptionalString(value);
	if (!normalized) return;
	if (normalized.length <= CODEX_DIAGNOSTICS_SCOPE_FIELD_MAX_CHARS) return normalized;
	return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}
async function startThreadAction(deps, ctx, pluginConfig, method, label) {
	const sessionFile = await resolveControlSessionFile(ctx);
	if (!sessionFile) return `Cannot start Codex ${label} because this command did not include an OpenClaw session file.`;
	const binding = await deps.readCodexAppServerBinding(sessionFile);
	if (!binding?.threadId) return `No Codex thread is attached to this OpenClaw session yet.`;
	if (method === CODEX_CONTROL_METHODS.review) await deps.codexControlRequest(pluginConfig, method, {
		threadId: binding.threadId,
		target: { type: "uncommittedChanges" }
	});
	else await deps.codexControlRequest(pluginConfig, method, { threadId: binding.threadId });
	return `Started Codex ${label} for thread ${binding.threadId}.`;
}
function splitArgs(value) {
	return (value ?? "").trim().split(/\s+/).filter(Boolean);
}
function parseBindArgs(args) {
	const parsed = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "--cwd") {
			parsed.cwd = args[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--model") {
			parsed.model = args[index + 1];
			index += 1;
			continue;
		}
		if (arg === "--provider" || arg === "--model-provider") {
			parsed.provider = args[index + 1];
			index += 1;
			continue;
		}
		if (!arg.startsWith("-") && !parsed.threadId) {
			parsed.threadId = arg;
			continue;
		}
		parsed.help = true;
	}
	parsed.threadId = normalizeOptionalString(parsed.threadId);
	parsed.cwd = normalizeOptionalString(parsed.cwd);
	parsed.model = normalizeOptionalString(parsed.model);
	parsed.provider = normalizeOptionalString(parsed.provider);
	return parsed;
}
function parseComputerUseArgs(args) {
	const parsed = {
		action: "status",
		overrides: {},
		hasOverrides: false
	};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
			continue;
		}
		if (arg === "status" || arg === "install") {
			parsed.action = arg;
			continue;
		}
		if (arg === "--source" || arg === "--marketplace-source") {
			const value = readRequiredOptionValue(args, index);
			if (!value) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.marketplaceSource = value;
			index += 1;
			continue;
		}
		if (arg === "--marketplace-path" || arg === "--path") {
			const value = readRequiredOptionValue(args, index);
			if (!value) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.marketplacePath = value;
			index += 1;
			continue;
		}
		if (arg === "--marketplace") {
			const value = readRequiredOptionValue(args, index);
			if (!value) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.marketplaceName = value;
			index += 1;
			continue;
		}
		if (arg === "--plugin") {
			const value = readRequiredOptionValue(args, index);
			if (!value) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.pluginName = value;
			index += 1;
			continue;
		}
		if (arg === "--server" || arg === "--mcp-server") {
			const value = readRequiredOptionValue(args, index);
			if (!value) {
				parsed.help = true;
				continue;
			}
			parsed.overrides.mcpServerName = value;
			index += 1;
			continue;
		}
		parsed.help = true;
	}
	parsed.overrides = normalizeComputerUseStringOverrides(parsed.overrides);
	parsed.hasOverrides = Object.values(parsed.overrides).some(Boolean);
	return parsed;
}
function readRequiredOptionValue(args, index) {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) return;
	return value;
}
function normalizeComputerUseStringOverrides(overrides) {
	const normalized = {};
	const marketplaceSource = normalizeOptionalString(overrides.marketplaceSource);
	if (marketplaceSource) normalized.marketplaceSource = marketplaceSource;
	const marketplacePath = normalizeOptionalString(overrides.marketplacePath);
	if (marketplacePath) normalized.marketplacePath = marketplacePath;
	const marketplaceName = normalizeOptionalString(overrides.marketplaceName);
	if (marketplaceName) normalized.marketplaceName = marketplaceName;
	const pluginName = normalizeOptionalString(overrides.pluginName);
	if (pluginName) normalized.pluginName = pluginName;
	const mcpServerName = normalizeOptionalString(overrides.mcpServerName);
	if (mcpServerName) normalized.mcpServerName = mcpServerName;
	return normalized;
}
function normalizeOptionalString(value) {
	return value?.trim() || void 0;
}
//#endregion
export { handleCodexSubcommand };
