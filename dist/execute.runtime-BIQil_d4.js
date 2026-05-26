import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as isTruthyEnvValue } from "./env-Dhqok4CP.js";
import { o as sanitizeHostExecEnv } from "./host-env-security-66KkrZF_.js";
import { n as resolvePreferredOpenClawTmpDir } from "./tmp-openclaw-dir-C60hWKdY.js";
import { a as shouldLogVerbose } from "./globals-YU5FjfZK.js";
import { t as applyPluginTextReplacements } from "./plugin-text-transforms-jHXsIkoa.js";
import { i as emitAgentEvent } from "./agent-events-BuYtWSh4.js";
import { o as requestHeartbeat } from "./heartbeat-wake-BEc0M8hq.js";
import { a as enqueueSystemEvent } from "./system-events-11EG3LzK.js";
import { n as appendBootstrapPromptWarning } from "./bootstrap-budget-WP_UMPQC.js";
import "./pi-embedded-helpers-bmljPI1n.js";
import { t as classifyFailoverReason } from "./errors-DYND-qcd.js";
import { c as resolveFailoverStatus, t as FailoverError } from "./failover-error-CZCIurQK.js";
import { i as scopedHeartbeatWakeOptionsForPolicy, n as resolveEventSessionRoutingPolicy, t as resolveEventSessionKeyForPolicy } from "./event-session-routing-SZ_PlpYU.js";
import { n as applySkillEnvOverridesFromSnapshot } from "./env-overrides-DIYux-i5.js";
import "./skills-JUNRkaHl.js";
import { t as getProcessSupervisor } from "./supervisor-C_r9sMLs.js";
import { a as createCliJsonlStreamingParser, i as shouldUseClaudeLiveSession, o as extractCliErrorMessage, r as runClaudeLiveSessionTurn, s as parseCliOutput } from "./claude-live-session-UZc6TCbZ.js";
import { r as cliBackendLog } from "./log-BqkNcamx.js";
import { a as prepareCliPromptImagePayload, c as resolveSessionIdToSend, d as buildCliSupervisorScopeKey, f as resolveCliNoOutputTimeoutMs, l as resolveSystemPromptUsage, n as buildCliArgs, o as resolveCliRunQueueKey, r as enqueueCliRun, s as resolvePromptInput, u as writeCliSystemPromptFile } from "./helpers-BpzSVpXp.js";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
//#region src/agents/cli-runner/claude-skills-plugin.ts
const CLAUDE_CLI_BACKEND_ID = "claude-cli";
const OPENCLAW_CLAUDE_PLUGIN_NAME = "openclaw-skills";
function sanitizeSkillDirName(name, used) {
	const base = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "skill";
	const safeBase = base.startsWith(".") ? `skill-${base.replace(/^\.+/, "") || "skill"}` : base;
	let candidate = safeBase;
	for (let index = 2; used.has(candidate); index += 1) candidate = `${safeBase}-${index}`;
	used.add(candidate);
	return candidate;
}
async function collectClaudePluginSkills(snapshot) {
	const skills = snapshot?.resolvedSkills ?? [];
	if (skills.length === 0) return [];
	const usedTargetNames = /* @__PURE__ */ new Set();
	const materialized = [];
	for (const skill of skills) {
		const name = skill.name?.trim();
		const skillFilePath = skill.filePath?.trim();
		if (!name || !skillFilePath) continue;
		try {
			await fs.access(skillFilePath);
		} catch {
			cliBackendLog.warn(`claude skill plugin skipped missing skill file: ${skillFilePath}`);
			continue;
		}
		materialized.push({
			name,
			sourceDir: path.dirname(skillFilePath),
			targetDirName: sanitizeSkillDirName(name, usedTargetNames)
		});
	}
	return materialized;
}
async function linkOrCopySkillDir(params) {
	try {
		await fs.symlink(params.sourceDir, params.targetDir, process.platform === "win32" ? "junction" : "dir");
	} catch {
		await fs.cp(params.sourceDir, params.targetDir, {
			recursive: true,
			force: true,
			verbatimSymlinks: true
		});
	}
}
async function prepareClaudeCliSkillsPlugin(params) {
	if (normalizeLowercaseStringOrEmpty(params.backendId) !== CLAUDE_CLI_BACKEND_ID) return {
		args: [],
		cleanup: async () => {}
	};
	const skills = await collectClaudePluginSkills(params.skillsSnapshot);
	if (skills.length === 0) return {
		args: [],
		cleanup: async () => {}
	};
	const tempDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), "openclaw-claude-skills-"));
	const pluginDir = path.join(tempDir, OPENCLAW_CLAUDE_PLUGIN_NAME);
	const manifestDir = path.join(pluginDir, ".claude-plugin");
	const skillsDir = path.join(pluginDir, "skills");
	await fs.mkdir(manifestDir, {
		recursive: true,
		mode: 448
	});
	await fs.mkdir(skillsDir, {
		recursive: true,
		mode: 448
	});
	const manifest = {
		name: OPENCLAW_CLAUDE_PLUGIN_NAME,
		version: "0.0.0",
		description: "Session-scoped OpenClaw skills selected for this agent run.",
		skills: "./skills"
	};
	await fs.writeFile(path.join(manifestDir, "plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
		encoding: "utf-8",
		mode: 384
	});
	let linkedSkillCount = 0;
	for (const skill of skills) try {
		await linkOrCopySkillDir({
			sourceDir: skill.sourceDir,
			targetDir: path.join(skillsDir, skill.targetDirName)
		});
		linkedSkillCount += 1;
	} catch (error) {
		cliBackendLog.warn(`claude skill plugin skipped ${skill.name}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (linkedSkillCount === 0) {
		await fs.rm(tempDir, {
			recursive: true,
			force: true
		});
		return {
			args: [],
			cleanup: async () => {}
		};
	}
	return {
		args: ["--plugin-dir", pluginDir],
		pluginDir,
		cleanup: async () => {
			await fs.rm(tempDir, {
				recursive: true,
				force: true
			});
		}
	};
}
//#endregion
//#region src/agents/cli-runner/execute.ts
const executeDeps = {
	getProcessSupervisor,
	enqueueSystemEvent,
	requestHeartbeat
};
const CLI_RUNNER_OUTPUT_TAIL_BYTES = 64 * 1024;
const CLI_RUNNER_OUTPUT_PARSE_BYTES = 1024 * 1024;
function appendCliOutputTail(tail, chunk) {
	if (!chunk) return tail;
	const chunkBuffer = Buffer.from(chunk);
	if (chunkBuffer.byteLength >= CLI_RUNNER_OUTPUT_TAIL_BYTES) return Buffer.from(chunkBuffer.subarray(chunkBuffer.byteLength - CLI_RUNNER_OUTPUT_TAIL_BYTES));
	const next = Buffer.concat([tail, chunkBuffer], tail.byteLength + chunkBuffer.byteLength);
	if (next.byteLength <= CLI_RUNNER_OUTPUT_TAIL_BYTES) return next;
	return Buffer.from(next.subarray(next.byteLength - CLI_RUNNER_OUTPUT_TAIL_BYTES));
}
function appendCliOutputParseBuffer(buffer, chunk) {
	if (!chunk) return {
		buffer,
		exceeded: false
	};
	const chunkBuffer = Buffer.from(chunk);
	if (buffer.byteLength + chunkBuffer.byteLength > CLI_RUNNER_OUTPUT_PARSE_BYTES) {
		const remainingBytes = CLI_RUNNER_OUTPUT_PARSE_BYTES - buffer.byteLength;
		if (remainingBytes <= 0) return {
			buffer,
			exceeded: true
		};
		return {
			buffer: Buffer.concat([buffer, chunkBuffer.subarray(0, remainingBytes)], CLI_RUNNER_OUTPUT_PARSE_BYTES),
			exceeded: true
		};
	}
	return {
		buffer: Buffer.concat([buffer, chunkBuffer], buffer.byteLength + chunkBuffer.byteLength),
		exceeded: false
	};
}
function createCliAbortError() {
	const error = /* @__PURE__ */ new Error("CLI run aborted");
	error.name = "AbortError";
	return error;
}
function buildCliLogArgs(params) {
	const logArgs = [];
	for (let i = 0; i < params.args.length; i += 1) {
		const arg = params.args[i] ?? "";
		if (arg === params.systemPromptArg) {
			const systemPromptValue = params.args[i + 1] ?? "";
			logArgs.push(arg, `<systemPrompt:${systemPromptValue.length} chars>`);
			i += 1;
			continue;
		}
		if (arg === params.sessionArg) {
			logArgs.push(arg, params.args[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (arg === params.modelArg) {
			logArgs.push(arg, params.args[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (arg === params.imageArg) {
			logArgs.push(arg, "<image>");
			i += 1;
			continue;
		}
		logArgs.push(arg);
	}
	if (params.argsPrompt) {
		const promptIndex = logArgs.indexOf(params.argsPrompt);
		if (promptIndex >= 0) logArgs[promptIndex] = `<prompt:${params.argsPrompt.length} chars>`;
	}
	return logArgs;
}
const CLI_ENV_AUTH_LOG_KEYS = [
	"AI_GATEWAY_API_KEY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_API_KEY_OLD",
	"ANTHROPIC_API_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_CUSTOM_HEADERS",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_UNIX_SOCKET",
	"AZURE_OPENAI_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
	"OPENAI_API_KEY",
	"OPENAI_STEIPETE_API_KEY",
	"OPENROUTER_API_KEY"
];
const CLI_BACKEND_PRESERVE_ENV = "OPENCLAW_LIVE_CLI_BACKEND_PRESERVE_ENV";
function parseCliBackendPreserveEnv(raw) {
	const trimmed = raw?.trim();
	if (!trimmed) return /* @__PURE__ */ new Set();
	if (trimmed.startsWith("[")) try {
		const parsed = JSON.parse(trimmed);
		return new Set(Array.isArray(parsed) ? parsed.filter((entry) => typeof entry === "string") : []);
	} catch {
		return /* @__PURE__ */ new Set();
	}
	return new Set(trimmed.split(/[,\s]+/).map((entry) => entry.trim()).filter((entry) => entry.length > 0));
}
function listPresentCliAuthEnvKeys(env) {
	return CLI_ENV_AUTH_LOG_KEYS.filter((key) => {
		const value = env[key];
		return typeof value === "string" && value.length > 0;
	});
}
function formatCliEnvKeyList(keys) {
	return keys.length > 0 ? keys.join(",") : "none";
}
function buildCliEnvMcpLog(childEnv) {
	return [
		`token=${childEnv.OPENCLAW_MCP_TOKEN ? "set" : "missing"}`,
		`sessionKey=${childEnv.OPENCLAW_MCP_SESSION_KEY ? "set" : "<empty>"}`,
		`agentId=${childEnv.OPENCLAW_MCP_AGENT_ID || "<empty>"}`,
		`accountId=${childEnv.OPENCLAW_MCP_ACCOUNT_ID || "<empty>"}`,
		`messageChannel=${childEnv.OPENCLAW_MCP_MESSAGE_CHANNEL || "<empty>"}`
	].join(" ");
}
function fingerprintCliSessionId(sessionId) {
	const trimmed = sessionId?.trim();
	if (!trimmed) return "none";
	return crypto.createHash("sha256").update(trimmed).digest("hex").slice(0, 12);
}
function buildCliExecLogLine(params) {
	const reuseState = params.reusableSessionId ? "reusable" : params.invalidatedReason ? `invalidated:${params.invalidatedReason}` : "none";
	return [
		`cli exec: provider=${params.provider}`,
		`model=${params.model}`,
		`promptChars=${params.promptChars}`,
		`trigger=${params.trigger ?? "unknown"}`,
		`useResume=${params.useResume ? "true" : "false"}`,
		`session=${params.cliSessionId ? "present" : "none"}`,
		`resumeSession=${params.useResume ? fingerprintCliSessionId(params.resolvedSessionId) : "none"}`,
		`reuse=${reuseState}`,
		`historyPrompt=${params.hasHistoryPrompt ? "present" : "none"}`
	].join(" ");
}
function buildCliEnvAuthLog(childEnv) {
	const hostKeys = listPresentCliAuthEnvKeys(process.env);
	const childKeys = listPresentCliAuthEnvKeys(childEnv);
	const childKeySet = new Set(childKeys);
	const clearedKeys = hostKeys.filter((key) => !childKeySet.has(key));
	return [
		`host=${formatCliEnvKeyList(hostKeys)}`,
		`child=${formatCliEnvKeyList(childKeys)}`,
		`cleared=${formatCliEnvKeyList(clearedKeys)}`
	].join(" ");
}
async function executePreparedCliRun(context, cliSessionIdToUse) {
	const params = context.params;
	if (params.abortSignal?.aborted) throw createCliAbortError();
	const backend = context.preparedBackend.backend;
	const { sessionId: resolvedSessionId, isNew } = resolveSessionIdToSend({
		backend,
		cliSessionId: cliSessionIdToUse
	});
	const useResume = Boolean(cliSessionIdToUse && resolvedSessionId && backend.resumeArgs && backend.resumeArgs.length > 0);
	const systemPromptArg = resolveSystemPromptUsage({
		backend,
		isNewSession: isNew,
		systemPrompt: context.systemPrompt
	});
	const systemPromptFile = !useResume && systemPromptArg ? await writeCliSystemPromptFile({
		backend,
		systemPrompt: systemPromptArg
	}) : void 0;
	const basePrompt = cliSessionIdToUse ? params.prompt : context.openClawHistoryPrompt ?? params.prompt;
	let prompt = applyPluginTextReplacements(appendBootstrapPromptWarning(basePrompt, context.bootstrapPromptWarningLines, { preserveExactPrompt: context.heartbeatPrompt }), context.backendResolved.textTransforms?.input);
	const { prompt: promptWithImages, imagePaths, cleanupImages } = await prepareCliPromptImagePayload({
		backend,
		prompt,
		workspaceDir: context.workspaceDir,
		images: params.images
	});
	prompt = promptWithImages;
	const { argsPrompt, stdin } = resolvePromptInput({
		backend,
		prompt
	});
	const stdinPayload = stdin ?? "";
	const baseArgs = useResume ? backend.resumeArgs ?? backend.args ?? [] : backend.args ?? [];
	const resolvedArgs = useResume ? baseArgs.map((entry) => entry.replaceAll("{sessionId}", resolvedSessionId ?? "")) : baseArgs;
	const claudeSkillsPlugin = await prepareClaudeCliSkillsPlugin({
		backendId: context.backendResolved.id,
		skillsSnapshot: params.skillsSnapshot
	});
	let claudeSkillsPluginCleanupOwned = false;
	const baseArgsWithSkills = claudeSkillsPlugin.args.length > 0 ? [...resolvedArgs, ...claudeSkillsPlugin.args] : resolvedArgs;
	const executionBaseArgs = context.backendResolved.resolveExecutionArgs?.({
		config: params.config,
		workspaceDir: context.workspaceDir,
		provider: params.provider,
		modelId: context.modelId,
		authProfileId: context.effectiveAuthProfileId,
		thinkingLevel: params.thinkLevel,
		useResume,
		baseArgs: baseArgsWithSkills
	}) ?? baseArgsWithSkills;
	const args = buildCliArgs({
		backend,
		baseArgs: Array.from(executionBaseArgs),
		modelId: context.normalizedModel,
		sessionId: resolvedSessionId,
		systemPrompt: systemPromptArg,
		systemPromptFilePath: systemPromptFile?.filePath,
		imagePaths,
		promptArg: argsPrompt,
		useResume
	});
	const queueKey = resolveCliRunQueueKey({
		backendId: context.backendResolved.id,
		serialize: backend.serialize,
		runId: params.runId,
		workspaceDir: context.workspaceDir,
		cliSessionId: useResume ? resolvedSessionId : void 0
	});
	try {
		return await enqueueCliRun(queueKey, async () => {
			const restoreSkillEnv = params.skillsSnapshot ? applySkillEnvOverridesFromSnapshot({
				snapshot: params.skillsSnapshot,
				config: params.config
			}) : void 0;
			try {
				cliBackendLog.info(buildCliExecLogLine({
					provider: params.provider,
					model: context.normalizedModel,
					promptChars: basePrompt.length,
					trigger: params.trigger,
					useResume,
					cliSessionId: cliSessionIdToUse,
					resolvedSessionId,
					reusableSessionId: context.reusableCliSession.sessionId,
					invalidatedReason: context.reusableCliSession.invalidatedReason,
					hasHistoryPrompt: Boolean(context.openClawHistoryPrompt)
				}));
				const logOutputText = isTruthyEnvValue(process.env["OPENCLAW_CLI_BACKEND_LOG_OUTPUT"]) || isTruthyEnvValue(process.env["OPENCLAW_CLAUDE_CLI_LOG_OUTPUT"]);
				const env = (() => {
					const next = sanitizeHostExecEnv({
						baseEnv: process.env,
						blockPathOverrides: true
					});
					const preservedEnv = parseCliBackendPreserveEnv(process.env[CLI_BACKEND_PRESERVE_ENV]);
					for (const key of backend.clearEnv ?? []) {
						if (preservedEnv.has(key)) continue;
						delete next[key];
					}
					if (backend.env && Object.keys(backend.env).length > 0) Object.assign(next, sanitizeHostExecEnv({
						baseEnv: {},
						overrides: backend.env,
						blockPathOverrides: true
					}));
					Object.assign(next, context.preparedBackend.env);
					delete next["CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"];
					return next;
				})();
				if (logOutputText) {
					const logArgs = buildCliLogArgs({
						args,
						systemPromptArg: backend.systemPromptArg,
						sessionArg: backend.sessionArg,
						modelArg: backend.modelArg,
						imageArg: backend.imageArg,
						argsPrompt
					});
					cliBackendLog.info(`cli argv: ${backend.command} ${logArgs.join(" ")}`);
					cliBackendLog.info(`cli env auth: ${buildCliEnvAuthLog(env)}`);
					if (env.OPENCLAW_MCP_TOKEN || env.OPENCLAW_MCP_SESSION_KEY || env.OPENCLAW_MCP_AGENT_ID) cliBackendLog.info(`cli env mcp: ${buildCliEnvMcpLog(env)}`);
				}
				const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({
					backend,
					timeoutMs: params.timeoutMs,
					useResume,
					trigger: params.trigger
				});
				const outputMode = useResume ? backend.resumeOutput ?? backend.output : backend.output;
				const hasJsonlOutput = outputMode === "jsonl";
				if (shouldUseClaudeLiveSession(context)) {
					if (!hasJsonlOutput) throw new Error("Claude live session requires JSONL streaming parser");
					params.onExecutionPhase?.({
						phase: "process_spawned",
						provider: params.provider,
						model: context.modelId,
						backend: context.backendResolved.id
					});
					claudeSkillsPluginCleanupOwned = true;
					const ownedPreparedBackendCleanup = context.preparedBackend.cleanup;
					context.preparedBackend.cleanup = void 0;
					const liveResult = await runClaudeLiveSessionTurn({
						context,
						args,
						env,
						prompt,
						useResume,
						noOutputTimeoutMs,
						getProcessSupervisor: executeDeps.getProcessSupervisor,
						onAssistantDelta: ({ text, delta }) => {
							emitAgentEvent({
								runId: params.runId,
								stream: "assistant",
								data: {
									text: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),
									delta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output)
								}
							});
						},
						cleanup: async () => {
							try {
								await claudeSkillsPlugin.cleanup();
							} finally {
								await ownedPreparedBackendCleanup?.();
							}
						}
					});
					const rawText = liveResult.output.text;
					return {
						...liveResult.output,
						rawText,
						finalPromptText: prompt,
						text: applyPluginTextReplacements(rawText, context.backendResolved.textTransforms?.output)
					};
				}
				const streamingParser = hasJsonlOutput ? createCliJsonlStreamingParser({
					backend,
					providerId: context.backendResolved.id,
					onAssistantDelta: ({ text, delta }) => {
						emitAgentEvent({
							runId: params.runId,
							stream: "assistant",
							data: {
								text: applyPluginTextReplacements(text, context.backendResolved.textTransforms?.output),
								delta: applyPluginTextReplacements(delta, context.backendResolved.textTransforms?.output)
							}
						});
					}
				}) : null;
				const supervisor = executeDeps.getProcessSupervisor();
				const scopeKey = buildCliSupervisorScopeKey({
					backend,
					backendId: context.backendResolved.id,
					cliSessionId: useResume ? resolvedSessionId : void 0
				});
				let stdoutTail = Buffer.alloc(0);
				let stdoutParseBuffer = Buffer.alloc(0);
				let stdoutParseExceeded = false;
				let stderrTail = Buffer.alloc(0);
				let stderrParseBuffer = Buffer.alloc(0);
				let stderrParseExceeded = false;
				params.onExecutionPhase?.({
					phase: "process_spawned",
					provider: params.provider,
					model: context.modelId,
					backend: context.backendResolved.id
				});
				const managedRun = await supervisor.spawn({
					sessionId: params.sessionId,
					backendId: context.backendResolved.id,
					scopeKey,
					replaceExistingScope: Boolean(useResume && scopeKey),
					mode: "child",
					argv: [backend.command, ...args],
					timeoutMs: params.timeoutMs,
					noOutputTimeoutMs,
					cwd: context.workspaceDir,
					env,
					input: stdinPayload,
					captureOutput: false,
					onStdout: (chunk) => {
						stdoutTail = appendCliOutputTail(stdoutTail, chunk);
						if (!stdoutParseExceeded) {
							const nextStdoutParse = appendCliOutputParseBuffer(stdoutParseBuffer, chunk);
							stdoutParseBuffer = nextStdoutParse.buffer;
							stdoutParseExceeded = nextStdoutParse.exceeded;
						}
						streamingParser?.push(chunk);
					},
					onStderr: (chunk) => {
						stderrTail = appendCliOutputTail(stderrTail, chunk);
						if (!stderrParseExceeded) {
							const nextStderrParse = appendCliOutputParseBuffer(stderrParseBuffer, chunk);
							stderrParseBuffer = nextStderrParse.buffer;
							stderrParseExceeded = nextStderrParse.exceeded;
						}
					}
				});
				let replyBackendCompleted = false;
				const replyBackendHandle = params.replyOperation ? {
					kind: "cli",
					cancel: () => {
						managedRun.cancel("manual-cancel");
					},
					isStreaming: () => !replyBackendCompleted
				} : void 0;
				if (replyBackendHandle) params.replyOperation?.attachBackend(replyBackendHandle);
				const abortManagedRun = () => {
					managedRun.cancel("manual-cancel");
				};
				params.abortSignal?.addEventListener("abort", abortManagedRun, { once: true });
				if (params.abortSignal?.aborted) abortManagedRun();
				let result;
				try {
					result = await managedRun.wait();
				} finally {
					replyBackendCompleted = true;
					if (replyBackendHandle) params.replyOperation?.detachBackend(replyBackendHandle);
					params.abortSignal?.removeEventListener("abort", abortManagedRun);
				}
				streamingParser?.finish();
				if (params.abortSignal?.aborted && result.reason === "manual-cancel") throw createCliAbortError();
				const stdout = stdoutParseBuffer.toString("utf8").trim();
				const stdoutDiagnostic = stdoutTail.toString("utf8").trim();
				const stderr = stderrParseBuffer.toString("utf8").trim();
				const stderrDiagnostic = stderrTail.toString("utf8").trim();
				if (logOutputText) {
					if (stdoutDiagnostic) cliBackendLog.info(`cli stdout:\n${stdoutDiagnostic}`);
					if (stderrDiagnostic) cliBackendLog.info(`cli stderr:\n${stderrDiagnostic}`);
				}
				if (shouldLogVerbose()) {
					if (stdoutDiagnostic) cliBackendLog.debug(`cli stdout:\n${stdoutDiagnostic}`);
					if (stderrDiagnostic) cliBackendLog.debug(`cli stderr:\n${stderrDiagnostic}`);
				}
				if (result.exitCode !== 0 || result.reason !== "exit") {
					if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
						const timeoutReason = `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1e3)}s and was terminated.`;
						cliBackendLog.warn(`cli watchdog timeout: provider=${params.provider} model=${context.modelId} session=${resolvedSessionId ?? params.sessionId} noOutputTimeoutMs=${noOutputTimeoutMs} pid=${managedRun.pid ?? "unknown"}`);
						if (params.sessionKey) {
							const stallNotice = [
								`CLI agent (${params.provider}) produced no output for ${Math.round(noOutputTimeoutMs / 1e3)}s and was terminated.`,
								"It may have been waiting for interactive input or an approval prompt.",
								"For Claude Code, prefer --permission-mode bypassPermissions --print."
							].join(" ");
							const eventRouting = resolveEventSessionRoutingPolicy({
								cfg: params.config,
								sessionKey: params.sessionKey,
								channel: params.messageProvider,
								accountId: params.agentAccountId
							});
							executeDeps.enqueueSystemEvent(stallNotice, { sessionKey: resolveEventSessionKeyForPolicy(params.sessionKey, eventRouting) });
							executeDeps.requestHeartbeat(scopedHeartbeatWakeOptionsForPolicy(params.sessionKey, {
								source: "cli-watchdog",
								intent: "event",
								reason: "cli:watchdog:stall"
							}, eventRouting));
						}
						throw new FailoverError(timeoutReason, {
							reason: "timeout",
							provider: params.provider,
							model: context.modelId,
							sessionId: params.sessionId,
							lane: params.lane,
							status: resolveFailoverStatus("timeout")
						});
					}
					if (result.reason === "overall-timeout") throw new FailoverError(`CLI exceeded timeout (${Math.round(params.timeoutMs / 1e3)}s) and was terminated.`, {
						reason: "timeout",
						provider: params.provider,
						model: context.modelId,
						sessionId: params.sessionId,
						lane: params.lane,
						status: resolveFailoverStatus("timeout")
					});
					const errorCandidates = [
						stderr,
						stdout,
						stderrDiagnostic,
						stdoutDiagnostic
					].filter((candidate) => candidate.length > 0);
					const structuredError = errorCandidates.map((candidate) => extractCliErrorMessage(candidate)).find(Boolean) ?? null;
					let classifiedErrorText = structuredError;
					let reason = structuredError ? classifyFailoverReason(structuredError, { provider: params.provider }) : null;
					if (!reason) for (const candidate of errorCandidates) {
						reason = classifyFailoverReason(candidate, { provider: params.provider });
						if (reason) {
							classifiedErrorText = candidate;
							break;
						}
					}
					const err = structuredError || classifiedErrorText || errorCandidates[0] || "CLI failed.";
					reason = reason ?? "unknown";
					const status = resolveFailoverStatus(reason);
					throw new FailoverError(err, {
						reason,
						provider: params.provider,
						model: context.modelId,
						sessionId: params.sessionId,
						lane: params.lane,
						status
					});
				}
				const streamedJsonlOutput = outputMode === "jsonl" ? streamingParser?.getOutput() ?? null : null;
				if (stdoutParseExceeded && !streamedJsonlOutput) throw new FailoverError(`CLI stdout exceeded ${CLI_RUNNER_OUTPUT_PARSE_BYTES} bytes; refusing to parse truncated output.`, {
					reason: "format",
					provider: params.provider,
					model: context.modelId,
					sessionId: params.sessionId,
					lane: params.lane,
					status: resolveFailoverStatus("format")
				});
				const parsed = streamedJsonlOutput ?? parseCliOutput({
					raw: stdout,
					backend,
					providerId: context.backendResolved.id,
					outputMode,
					fallbackSessionId: resolvedSessionId
				});
				const rawText = parsed.text;
				return {
					...parsed,
					rawText,
					finalPromptText: prompt,
					text: applyPluginTextReplacements(rawText, context.backendResolved.textTransforms?.output)
				};
			} finally {
				restoreSkillEnv?.();
			}
		});
	} finally {
		if (!claudeSkillsPluginCleanupOwned) await claudeSkillsPlugin.cleanup();
		if (systemPromptFile) await systemPromptFile.cleanup();
		if (cleanupImages) await cleanupImages();
	}
}
//#endregion
export { executePreparedCliRun };
