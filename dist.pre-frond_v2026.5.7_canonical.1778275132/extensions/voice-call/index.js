import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "../../string-coerce-Bje8XVt9.js";
import { i as formatErrorMessage } from "../../errors-QN8rySzW.js";
import { _ as sleep } from "../../utils-D5swhEXt.js";
import { Jr as ErrorCodes, Yr as errorShape } from "../../protocol-DZStUQT_.js";
import "../../text-runtime-DCigKjjg.js";
import { t as definePluginEntry } from "../../plugin-entry-sCE0O04z.js";
import "../../error-runtime-BAONd32e.js";
import "../../gateway-runtime-CUJLUPgG.js";
import { n as callGatewayFromCli } from "../../gateway-rpc-B8OS1eQM.js";
import "./api-CNUoTOgt.js";
import { i as resolveVoiceCallConfig, s as validateProviderConfig } from "./config-CNJqH4nQ.js";
import { a as setupTailscaleExposureRoute, i as getTailscaleSelfInfo, n as resolveWebhookExposureStatus, r as cleanupTailscaleExposureRoute, s as resolveUserPath, t as createVoiceCallRuntime } from "./runtime-entry-BWpp5hjb.js";
import { i as parseVoiceCallPluginConfig, r as normalizeVoiceCallLegacyConfigInput, t as formatVoiceCallLegacyConfigWarnings } from "./config-compat-BXGj3vtF.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { format } from "node:util";
import { Type } from "typebox";
//#region extensions/voice-call/src/cli.ts
const VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS = 5e3;
const VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS = 3e4;
const VOICE_CALL_GATEWAY_TRANSCRIPT_BUFFER_MS = 1e4;
const VOICE_CALL_GATEWAY_POLL_INTERVAL_MS = 1e3;
const voiceCallCliDeps = { callGatewayFromCli };
function writeStdoutLine(...values) {
	process.stdout.write(`${format(...values)}\n`);
}
function writeStdoutJson(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function isGatewayUnavailableForLocalFallback(err) {
	const message = formatErrorMessage(err);
	return message.includes("ECONNREFUSED") || message.includes("ECONNRESET") || message.includes("EHOSTUNREACH") || message.includes("ENOTFOUND") || message.includes("gateway closed (1006") || message.includes("gateway not connected");
}
async function callVoiceCallGateway(method, params, opts) {
	try {
		const timeoutMs = typeof opts?.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) ? Math.max(1, Math.ceil(opts.timeoutMs)) : VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS;
		return {
			ok: true,
			payload: await voiceCallCliDeps.callGatewayFromCli(method, {
				json: true,
				timeout: String(timeoutMs)
			}, params, { progress: false })
		};
	} catch (err) {
		if (isGatewayUnavailableForLocalFallback(err)) return {
			ok: false,
			error: err
		};
		throw err;
	}
}
function resolveGatewayOperationTimeoutMs(config) {
	return Math.max(VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS, config.ringTimeoutMs + 5e3);
}
function resolveGatewayContinueTimeoutMs(config) {
	return config.transcriptTimeoutMs + VOICE_CALL_GATEWAY_OPERATION_TIMEOUT_MS + VOICE_CALL_GATEWAY_TRANSCRIPT_BUFFER_MS;
}
function isUnknownGatewayMethod(err, method) {
	return formatErrorMessage(err).includes(`unknown method: ${method}`);
}
function readGatewayOperationId(payload) {
	if (isRecord(payload) && typeof payload.operationId === "string" && payload.operationId) return payload.operationId;
	throw new Error("voicecall gateway response missing operationId");
}
function readGatewayPollTimeoutMs(payload, fallbackTimeoutMs) {
	if (isRecord(payload) && typeof payload.pollTimeoutMs === "number") return Math.max(1, Math.ceil(payload.pollTimeoutMs));
	return fallbackTimeoutMs;
}
function readCompletedContinueResult(payload) {
	if (!isRecord(payload)) throw new Error("voicecall gateway response missing operation status");
	if (payload.status === "pending") return { status: "pending" };
	if (payload.status === "failed") return {
		status: "failed",
		error: typeof payload.error === "string" ? payload.error : "continue failed"
	};
	if (payload.status === "completed") return {
		status: "completed",
		result: payload.result
	};
	throw new Error("voicecall gateway response has unknown operation status");
}
async function pollVoiceCallContinueGateway(params) {
	const deadlineMs = Date.now() + params.timeoutMs;
	while (Date.now() <= deadlineMs) {
		const gateway = await callVoiceCallGateway("voicecall.continue.result", { operationId: params.operationId }, { timeoutMs: VOICE_CALL_GATEWAY_DEFAULT_TIMEOUT_MS });
		if (!gateway.ok) throw new Error(`gateway unavailable while waiting for voicecall continue result: ${formatErrorMessage(gateway.error)}`);
		const result = readCompletedContinueResult(gateway.payload);
		if (result.status === "completed") return result.result;
		if (result.status === "failed") throw new Error(result.error);
		await sleep(Math.min(VOICE_CALL_GATEWAY_POLL_INTERVAL_MS, Math.max(1, deadlineMs - Date.now())));
	}
	throw new Error("voicecall continue timed out waiting for gateway operation");
}
function resolveMode(input) {
	const raw = normalizeOptionalLowercaseString(input) ?? "";
	if (raw === "serve" || raw === "off") return raw;
	return "funnel";
}
function resolveDefaultStorePath(config) {
	const resolvedPreferred = resolveUserPath(path.join(os.homedir(), ".openclaw", "voice-calls"));
	const existing = [resolvedPreferred].find((dir) => {
		try {
			return fs.existsSync(path.join(dir, "calls.jsonl")) || fs.existsSync(dir);
		} catch {
			return false;
		}
	}) ?? resolvedPreferred;
	const base = config.store?.trim() ? resolveUserPath(config.store) : existing;
	return path.join(base, "calls.jsonl");
}
function percentile(values, p) {
	if (values.length === 0) return 0;
	const sorted = [...values].toSorted((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))] ?? 0;
}
function summarizeSeries(values) {
	if (values.length === 0) return {
		count: 0,
		minMs: 0,
		maxMs: 0,
		avgMs: 0,
		p50Ms: 0,
		p95Ms: 0
	};
	const minMs = values.reduce((min, value) => value < min ? value : min, Number.POSITIVE_INFINITY);
	const maxMs = values.reduce((max, value) => value > max ? value : max, Number.NEGATIVE_INFINITY);
	const avgMs = values.reduce((sum, value) => sum + value, 0) / values.length;
	return {
		count: values.length,
		minMs,
		maxMs,
		avgMs,
		p50Ms: percentile(values, 50),
		p95Ms: percentile(values, 95)
	};
}
function resolveCallMode(mode) {
	return mode === "notify" || mode === "conversation" ? mode : void 0;
}
function buildSetupStatus(config) {
	const validation = validateProviderConfig(config);
	const webhookExposure = resolveWebhookExposureStatus(config);
	const checks = [
		{
			id: "plugin-enabled",
			ok: config.enabled,
			message: config.enabled ? "Voice Call plugin is enabled" : "Enable plugins.entries.voice-call.enabled"
		},
		{
			id: "provider",
			ok: Boolean(config.provider),
			message: config.provider ? `Provider configured: ${config.provider}` : "Set plugins.entries.voice-call.config.provider"
		},
		{
			id: "provider-config",
			ok: validation.valid,
			message: validation.valid ? "Provider credentials/config look complete" : validation.errors.join("; ")
		},
		{
			id: "webhook-exposure",
			ok: webhookExposure.ok,
			message: webhookExposure.message
		},
		{
			id: "mode",
			ok: !(config.streaming.enabled && config.realtime.enabled),
			message: config.streaming.enabled && config.realtime.enabled ? "streaming.enabled and realtime.enabled cannot both be true" : config.realtime.enabled ? `Realtime voice enabled (${config.realtime.provider ?? "first registered provider"})` : config.streaming.enabled ? `Streaming transcription enabled (${config.streaming.provider ?? "first registered provider"})` : "Notify/conversation calls use normal TTS/STT flow"
		}
	];
	return {
		ok: checks.every((check) => check.ok),
		checks
	};
}
function writeSetupStatus(status) {
	writeStdoutLine("Voice Call setup: %s", status.ok ? "OK" : "needs attention");
	for (const check of status.checks) writeStdoutLine("%s %s: %s", check.ok ? "OK" : "FAIL", check.id, check.message);
}
async function initiateCallAndPrintId(params) {
	const result = await params.runtime.manager.initiateCall(params.to, void 0, {
		message: params.message,
		mode: resolveCallMode(params.mode)
	});
	if (!result.success) throw new Error(result.error || "initiate failed");
	writeStdoutJson({ callId: result.callId });
}
function writeGatewayCallId(payload) {
	if (isRecord(payload) && typeof payload.callId === "string") {
		writeStdoutJson({ callId: payload.callId });
		return;
	}
	if (isRecord(payload) && typeof payload.error === "string") throw new Error(payload.error);
	throw new Error("voicecall gateway response missing callId");
}
async function initiateCallViaGatewayOrRuntime(params) {
	const mode = resolveCallMode(params.mode);
	const gateway = await callVoiceCallGateway(params.method, {
		...params.to ? { to: params.to } : {},
		...params.message ? { message: params.message } : {},
		...mode ? { mode } : {}
	}, { timeoutMs: resolveGatewayOperationTimeoutMs(params.config) });
	if (gateway.ok) {
		writeGatewayCallId(gateway.payload);
		return;
	}
	const rt = await params.ensureRuntime();
	const to = params.to ?? rt.config.toNumber;
	if (!to) throw new Error("Missing --to and no toNumber configured");
	await initiateCallAndPrintId({
		runtime: rt,
		to,
		message: params.message,
		mode: params.mode
	});
}
function registerVoiceCallCli(params) {
	const { program, config, ensureRuntime, logger } = params;
	const root = program.command("voicecall").description("Voice call utilities").addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/cli/voicecall\n`);
	root.command("setup").description("Show Voice Call provider and webhook setup status").option("--json", "Print machine-readable JSON").action((options) => {
		const status = buildSetupStatus(config);
		if (options.json) {
			writeStdoutJson(status);
			return;
		}
		writeSetupStatus(status);
	});
	root.command("smoke").description("Check Voice Call readiness and optionally place a short outbound test call").option("-t, --to <phone>", "Phone number to call for a live smoke").option("--message <text>", "Message to speak during the smoke call", "OpenClaw voice call smoke test.").option("--mode <mode>", "Call mode: notify or conversation", "notify").option("--yes", "Actually place the live outbound call").option("--json", "Print machine-readable JSON").action(async (options) => {
		const setup = buildSetupStatus(config);
		if (!setup.ok) {
			if (options.json) writeStdoutJson({
				ok: false,
				setup
			});
			else writeSetupStatus(setup);
			process.exitCode = 1;
			return;
		}
		if (!options.to) {
			if (options.json) writeStdoutJson({
				ok: true,
				setup,
				liveCall: false
			});
			else {
				writeSetupStatus(setup);
				writeStdoutLine("live-call: skipped (pass --to and --yes to place one)");
			}
			return;
		}
		if (!options.yes) {
			if (options.json) writeStdoutJson({
				ok: true,
				setup,
				liveCall: false,
				wouldCall: options.to
			});
			else {
				writeSetupStatus(setup);
				writeStdoutLine("live-call: dry run for %s (add --yes to place it)", options.to);
			}
			return;
		}
		const mode = resolveCallMode(options.mode) ?? "notify";
		const gateway = await callVoiceCallGateway("voicecall.start", {
			to: options.to,
			...options.message ? { message: options.message } : {},
			mode
		}, { timeoutMs: resolveGatewayOperationTimeoutMs(config) });
		let callId;
		if (gateway.ok) callId = isRecord(gateway.payload) ? gateway.payload.callId : void 0;
		else {
			const result = await (await ensureRuntime()).manager.initiateCall(options.to, void 0, {
				message: options.message,
				mode
			});
			if (!result.success) throw new Error(result.error || "smoke call failed");
			callId = result.callId;
		}
		if (typeof callId !== "string" || !callId) throw new Error("smoke call failed");
		if (options.json) {
			writeStdoutJson({
				ok: true,
				setup,
				liveCall: true,
				callId
			});
			return;
		}
		writeSetupStatus(setup);
		writeStdoutLine("live-call: started %s", callId);
	});
	root.command("call").description("Initiate an outbound voice call").requiredOption("-m, --message <text>", "Message to speak when call connects").option("-t, --to <phone>", "Phone number to call (E.164 format, uses config toNumber if not set)").option("--mode <mode>", "Call mode: notify (hangup after message) or conversation (stay open)", "conversation").action(async (options) => {
		await initiateCallViaGatewayOrRuntime({
			ensureRuntime,
			config,
			method: "voicecall.initiate",
			to: options.to,
			message: options.message,
			mode: options.mode
		});
	});
	root.command("start").description("Alias for voicecall call").requiredOption("--to <phone>", "Phone number to call").option("--message <text>", "Message to speak when call connects").option("--mode <mode>", "Call mode: notify (hangup after message) or conversation (stay open)", "conversation").action(async (options) => {
		await initiateCallViaGatewayOrRuntime({
			ensureRuntime,
			config,
			method: "voicecall.start",
			to: options.to,
			message: options.message,
			mode: options.mode
		});
	});
	root.command("continue").description("Speak a message and wait for a response").requiredOption("--call-id <id>", "Call ID").requiredOption("--message <text>", "Message to speak").action(async (options) => {
		let gateway;
		try {
			gateway = await callVoiceCallGateway("voicecall.continue.start", {
				callId: options.callId,
				message: options.message
			}, { timeoutMs: resolveGatewayOperationTimeoutMs(config) });
		} catch (err) {
			if (!isUnknownGatewayMethod(err, "voicecall.continue.start")) throw err;
			gateway = await callVoiceCallGateway("voicecall.continue", {
				callId: options.callId,
				message: options.message
			}, { timeoutMs: resolveGatewayContinueTimeoutMs(config) });
		}
		if (gateway.ok) {
			if (isRecord(gateway.payload) && typeof gateway.payload.operationId === "string") {
				writeStdoutJson(await pollVoiceCallContinueGateway({
					operationId: readGatewayOperationId(gateway.payload),
					timeoutMs: readGatewayPollTimeoutMs(gateway.payload, resolveGatewayContinueTimeoutMs(config))
				}));
				return;
			}
			writeStdoutJson(gateway.payload);
			return;
		}
		const result = await (await ensureRuntime()).manager.continueCall(options.callId, options.message);
		if (!result.success) throw new Error(result.error || "continue failed");
		writeStdoutJson(result);
	});
	root.command("speak").description("Speak a message without waiting for response").requiredOption("--call-id <id>", "Call ID").requiredOption("--message <text>", "Message to speak").action(async (options) => {
		const gateway = await callVoiceCallGateway("voicecall.speak", {
			callId: options.callId,
			message: options.message
		});
		if (gateway.ok) {
			writeStdoutJson(gateway.payload);
			return;
		}
		const result = await (await ensureRuntime()).manager.speak(options.callId, options.message);
		if (!result.success) throw new Error(result.error || "speak failed");
		writeStdoutJson(result);
	});
	root.command("dtmf").description("Send DTMF digits to an active call").requiredOption("--call-id <id>", "Call ID").requiredOption("--digits <digits>", "DTMF digits").action(async (options) => {
		const gateway = await callVoiceCallGateway("voicecall.dtmf", {
			callId: options.callId,
			digits: options.digits
		});
		if (gateway.ok) {
			writeStdoutJson(gateway.payload);
			return;
		}
		const result = await (await ensureRuntime()).manager.sendDtmf(options.callId, options.digits);
		if (!result.success) throw new Error(result.error || "dtmf failed");
		writeStdoutJson(result);
	});
	root.command("end").description("Hang up an active call").requiredOption("--call-id <id>", "Call ID").action(async (options) => {
		const gateway = await callVoiceCallGateway("voicecall.end", { callId: options.callId });
		if (gateway.ok) {
			writeStdoutJson(gateway.payload);
			return;
		}
		const result = await (await ensureRuntime()).manager.endCall(options.callId);
		if (!result.success) throw new Error(result.error || "end failed");
		writeStdoutJson(result);
	});
	root.command("status").description("Show call status").option("--call-id <id>", "Call ID").option("--json", "Print machine-readable JSON").action(async (options) => {
		const gateway = await callVoiceCallGateway("voicecall.status", options.callId ? { callId: options.callId } : void 0);
		if (gateway.ok) {
			if (options.callId && isRecord(gateway.payload)) {
				if (gateway.payload.found === true && "call" in gateway.payload) {
					writeStdoutJson(gateway.payload.call);
					return;
				}
				if (gateway.payload.found === false) {
					writeStdoutJson({ found: false });
					return;
				}
			}
			writeStdoutJson(gateway.payload);
			return;
		}
		const rt = await ensureRuntime();
		if (options.callId) {
			writeStdoutJson(rt.manager.getCall(options.callId) ?? { found: false });
			return;
		}
		writeStdoutJson({
			found: true,
			calls: rt.manager.getActiveCalls()
		});
	});
	root.command("tail").description("Tail voice-call JSONL logs (prints new lines; useful during provider tests)").option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config)).option("--since <n>", "Print last N lines first", "25").option("--poll <ms>", "Poll interval in ms", "250").action(async (options) => {
		const file = options.file;
		const since = Math.max(0, Number(options.since ?? 0));
		const pollMs = Math.max(50, Number(options.poll ?? 250));
		if (!fs.existsSync(file)) {
			logger.error(`No log file at ${file}`);
			process.exit(1);
		}
		const initial = fs.readFileSync(file, "utf8");
		const lines = initial.split("\n").filter(Boolean);
		for (const line of lines.slice(Math.max(0, lines.length - since))) writeStdoutLine(line);
		let offset = Buffer.byteLength(initial, "utf8");
		for (;;) {
			try {
				const stat = fs.statSync(file);
				if (stat.size < offset) offset = 0;
				if (stat.size > offset) {
					const fd = fs.openSync(file, "r");
					try {
						const buf = Buffer.alloc(stat.size - offset);
						fs.readSync(fd, buf, 0, buf.length, offset);
						offset = stat.size;
						const text = buf.toString("utf8");
						for (const line of text.split("\n").filter(Boolean)) writeStdoutLine(line);
					} finally {
						fs.closeSync(fd);
					}
				}
			} catch {}
			await sleep(pollMs);
		}
	});
	root.command("latency").description("Summarize turn latency metrics from voice-call JSONL logs").option("--file <path>", "Path to calls.jsonl", resolveDefaultStorePath(config)).option("--last <n>", "Analyze last N records", "200").action(async (options) => {
		const file = options.file;
		const last = Math.max(1, Number(options.last ?? 200));
		if (!fs.existsSync(file)) throw new Error("No log file at " + file);
		const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-last);
		const turnLatencyMs = [];
		const listenWaitMs = [];
		for (const line of lines) try {
			const parsed = JSON.parse(line);
			const latency = parsed.metadata?.lastTurnLatencyMs;
			const listenWait = parsed.metadata?.lastTurnListenWaitMs;
			if (typeof latency === "number" && Number.isFinite(latency)) turnLatencyMs.push(latency);
			if (typeof listenWait === "number" && Number.isFinite(listenWait)) listenWaitMs.push(listenWait);
		} catch {}
		writeStdoutJson({
			recordsScanned: lines.length,
			turnLatency: summarizeSeries(turnLatencyMs),
			listenWait: summarizeSeries(listenWaitMs)
		});
	});
	root.command("expose").description("Enable/disable Tailscale serve/funnel for the webhook").option("--mode <mode>", "off | serve (tailnet) | funnel (public)", "funnel").option("--path <path>", "Tailscale path to expose (recommend matching serve.path)").option("--port <port>", "Local webhook port").option("--serve-path <path>", "Local webhook path").action(async (options) => {
		const mode = resolveMode(options.mode ?? "funnel");
		const servePort = Number(options.port ?? config.serve.port ?? 3334);
		const servePath = options.servePath ?? config.serve.path ?? "/voice/webhook";
		const tsPath = options.path ?? config.tailscale?.path ?? servePath;
		const localUrl = `http://127.0.0.1:${servePort}`;
		if (mode === "off") {
			await cleanupTailscaleExposureRoute({
				mode: "serve",
				path: tsPath
			});
			await cleanupTailscaleExposureRoute({
				mode: "funnel",
				path: tsPath
			});
			writeStdoutJson({
				ok: true,
				mode: "off",
				path: tsPath
			});
			return;
		}
		const publicUrl = await setupTailscaleExposureRoute({
			mode,
			path: tsPath,
			localUrl
		});
		const tsInfo = publicUrl ? null : await getTailscaleSelfInfo();
		const enableUrl = tsInfo?.nodeId ? `https://login.tailscale.com/f/${mode}?node=${tsInfo.nodeId}` : null;
		writeStdoutJson({
			ok: Boolean(publicUrl),
			mode,
			path: tsPath,
			localUrl,
			publicUrl,
			hint: publicUrl ? void 0 : {
				note: "Tailscale serve/funnel may be disabled on this tailnet (or require admin enable).",
				enableUrl
			}
		});
	});
}
//#endregion
//#region extensions/voice-call/src/gateway-continue-operation.ts
const VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS = 3e4;
const VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS = 300 * 1e3;
function createVoiceCallContinueOperationStore(params) {
	const operations = /* @__PURE__ */ new Map();
	const resolvePollTimeoutMs = (rt) => {
		const ttsTimeoutMs = rt.config.tts?.timeoutMs ?? params.config.tts?.timeoutMs ?? params.coreConfig.messages?.tts?.timeoutMs ?? 8e3;
		return (rt.config.transcriptTimeoutMs ?? params.config.transcriptTimeoutMs) + ttsTimeoutMs + VOICE_CALL_CONTINUE_OPERATION_BUFFER_MS;
	};
	const scheduleCleanup = (operationId) => {
		setTimeout(() => {
			operations.delete(operationId);
		}, VOICE_CALL_CONTINUE_OPERATION_CLEANUP_MS).unref?.();
	};
	const start = (request) => {
		const operationId = randomUUID();
		const startedAtMs = Date.now();
		const pollTimeoutMs = resolvePollTimeoutMs(request.rt);
		operations.set(operationId, {
			operationId,
			status: "pending",
			callId: request.callId,
			startedAtMs,
			pollTimeoutMs
		});
		request.rt.manager.continueCall(request.callId, request.message).then((result) => {
			const current = operations.get(operationId);
			if (!current || current.status !== "pending") return;
			if (!result.success) {
				operations.set(operationId, {
					operationId,
					status: "failed",
					callId: request.callId,
					startedAtMs,
					completedAtMs: Date.now(),
					pollTimeoutMs,
					error: result.error || "continue failed"
				});
				return;
			}
			operations.set(operationId, {
				operationId,
				status: "completed",
				callId: request.callId,
				startedAtMs,
				completedAtMs: Date.now(),
				pollTimeoutMs,
				result: {
					success: true,
					transcript: result.transcript
				}
			});
		}).catch((err) => {
			const current = operations.get(operationId);
			if (!current || current.status !== "pending") return;
			operations.set(operationId, {
				operationId,
				status: "failed",
				callId: request.callId,
				startedAtMs,
				completedAtMs: Date.now(),
				pollTimeoutMs,
				error: formatErrorMessage(err)
			});
		}).finally(() => {
			scheduleCleanup(operationId);
		});
		return {
			operationId,
			status: "pending",
			pollTimeoutMs
		};
	};
	const read = (operationId) => {
		const operation = operations.get(operationId);
		if (!operation) return {
			ok: false,
			error: "operation not found"
		};
		if (operation.status === "pending") return {
			ok: true,
			payload: {
				operationId,
				status: "pending",
				pollTimeoutMs: operation.pollTimeoutMs
			}
		};
		if (operation.status === "failed") {
			operations.delete(operationId);
			return {
				ok: true,
				payload: {
					operationId,
					status: "failed",
					error: operation.error
				}
			};
		}
		operations.delete(operationId);
		return {
			ok: true,
			payload: {
				operationId,
				status: "completed",
				result: operation.result
			}
		};
	};
	return {
		start,
		read
	};
}
//#endregion
//#region extensions/voice-call/index.ts
const VOICE_CALL_WRITE_METHOD_SCOPE = { scope: "operator.write" };
const VOICE_CALL_READ_METHOD_SCOPE = { scope: "operator.read" };
const voiceCallConfigSchema = {
	parse(value) {
		const normalized = normalizeVoiceCallLegacyConfigInput(value);
		const enabled = typeof normalized.enabled === "boolean" ? normalized.enabled : true;
		return parseVoiceCallPluginConfig({
			...normalized,
			enabled,
			provider: normalized.provider ?? (enabled ? "mock" : void 0)
		});
	},
	uiHints: {
		provider: {
			label: "Provider",
			help: "Use twilio, telnyx, or mock for dev/no-network."
		},
		fromNumber: {
			label: "From Number",
			placeholder: "+15550001234"
		},
		toNumber: {
			label: "Default To Number",
			placeholder: "+15550001234"
		},
		inboundPolicy: { label: "Inbound Policy" },
		allowFrom: { label: "Inbound Allowlist" },
		inboundGreeting: {
			label: "Inbound Greeting",
			advanced: true
		},
		numbers: {
			label: "Per-number Routing",
			help: "Inbound overrides keyed by dialed E.164 number.",
			advanced: true
		},
		"telnyx.apiKey": {
			label: "Telnyx API Key",
			sensitive: true
		},
		"telnyx.connectionId": { label: "Telnyx Connection ID" },
		"telnyx.publicKey": {
			label: "Telnyx Public Key",
			sensitive: true
		},
		"twilio.accountSid": { label: "Twilio Account SID" },
		"twilio.authToken": {
			label: "Twilio Auth Token",
			sensitive: true
		},
		"outbound.defaultMode": { label: "Default Call Mode" },
		"outbound.notifyHangupDelaySec": {
			label: "Notify Hangup Delay (sec)",
			advanced: true
		},
		"serve.port": { label: "Webhook Port" },
		"serve.bind": { label: "Webhook Bind" },
		"serve.path": { label: "Webhook Path" },
		"tailscale.mode": {
			label: "Tailscale Mode",
			advanced: true
		},
		"tailscale.path": {
			label: "Tailscale Path",
			advanced: true
		},
		"tunnel.provider": {
			label: "Tunnel Provider",
			advanced: true
		},
		"tunnel.ngrokAuthToken": {
			label: "ngrok Auth Token",
			sensitive: true,
			advanced: true
		},
		"tunnel.ngrokDomain": {
			label: "ngrok Domain",
			advanced: true
		},
		"tunnel.allowNgrokFreeTierLoopbackBypass": {
			label: "Allow ngrok Free Tier (Loopback Bypass)",
			advanced: true
		},
		"streaming.enabled": {
			label: "Enable Streaming",
			advanced: true
		},
		"streaming.provider": {
			label: "Streaming Provider",
			help: "Uses the first registered realtime transcription provider when unset.",
			advanced: true
		},
		"streaming.providers": {
			label: "Streaming Provider Config",
			advanced: true
		},
		"streaming.streamPath": {
			label: "Media Stream Path",
			advanced: true
		},
		"realtime.enabled": {
			label: "Enable Realtime Voice",
			advanced: true
		},
		"realtime.provider": {
			label: "Realtime Voice Provider",
			help: "Uses the first registered realtime voice provider when unset.",
			advanced: true
		},
		"realtime.streamPath": {
			label: "Realtime Stream Path",
			advanced: true
		},
		"realtime.instructions": {
			label: "Realtime Instructions",
			advanced: true
		},
		"realtime.toolPolicy": {
			label: "Realtime Tool Policy",
			help: "Controls the shared openclaw_agent_consult tool.",
			advanced: true
		},
		"realtime.fastContext.enabled": {
			label: "Enable Fast Realtime Context",
			help: "Searches memory/session context before the full consult agent.",
			advanced: true
		},
		"realtime.fastContext.timeoutMs": {
			label: "Fast Context Timeout",
			advanced: true
		},
		"realtime.fastContext.maxResults": {
			label: "Fast Context Result Limit",
			advanced: true
		},
		"realtime.fastContext.sources": {
			label: "Fast Context Sources",
			advanced: true
		},
		"realtime.fastContext.fallbackToConsult": {
			label: "Fallback To Full Consult",
			advanced: true
		},
		"realtime.providers": {
			label: "Realtime Provider Config",
			advanced: true
		},
		"tts.provider": {
			label: "TTS Provider Override",
			help: "Deep-merges with messages.tts (Microsoft is ignored for calls).",
			advanced: true
		},
		"tts.providers": {
			label: "TTS Provider Config",
			advanced: true
		},
		publicUrl: {
			label: "Public Webhook URL",
			advanced: true
		},
		skipSignatureVerification: {
			label: "Skip Signature Verification",
			advanced: true
		},
		store: {
			label: "Call Log Store Path",
			advanced: true
		},
		agentId: {
			label: "Response Agent ID",
			help: "Agent workspace used for voice response generation. Defaults to \"main\".",
			advanced: true
		},
		responseModel: {
			label: "Response Model",
			help: "Optional override. Falls back to the runtime default model when unset.",
			advanced: true
		},
		responseSystemPrompt: {
			label: "Response System Prompt",
			advanced: true
		},
		responseTimeoutMs: {
			label: "Response Timeout (ms)",
			advanced: true
		}
	}
};
const VoiceCallToolSchema = Type.Union([
	Type.Object({
		action: Type.Literal("initiate_call"),
		to: Type.Optional(Type.String({ description: "Call target" })),
		message: Type.String({ description: "Intro message" }),
		mode: Type.Optional(Type.Union([Type.Literal("notify"), Type.Literal("conversation")])),
		dtmfSequence: Type.Optional(Type.String({ description: "DTMF digits to play before connect" }))
	}),
	Type.Object({
		action: Type.Literal("continue_call"),
		callId: Type.String({ description: "Call ID" }),
		message: Type.String({ description: "Follow-up message" })
	}),
	Type.Object({
		action: Type.Literal("speak_to_user"),
		callId: Type.String({ description: "Call ID" }),
		message: Type.String({ description: "Message to speak" })
	}),
	Type.Object({
		action: Type.Literal("send_dtmf"),
		callId: Type.String({ description: "Call ID" }),
		digits: Type.String({ description: "DTMF digits to send" })
	}),
	Type.Object({
		action: Type.Literal("end_call"),
		callId: Type.String({ description: "Call ID" })
	}),
	Type.Object({
		action: Type.Literal("get_status"),
		callId: Type.String({ description: "Call ID" })
	}),
	Type.Object({
		mode: Type.Optional(Type.Union([Type.Literal("call"), Type.Literal("status")])),
		to: Type.Optional(Type.String({ description: "Call target" })),
		sid: Type.Optional(Type.String({ description: "Call SID" })),
		message: Type.Optional(Type.String({ description: "Optional intro message" })),
		dtmfSequence: Type.Optional(Type.String({ description: "DTMF digits to play before connect" }))
	})
]);
function asParamRecord(params) {
	return params && typeof params === "object" && !Array.isArray(params) ? params : {};
}
function isCliOnlyProcess() {
	return process.env.OPENCLAW_CLI === "1" && !process.argv.slice(2).includes("gateway");
}
const VOICE_CALL_RUNTIME_KEY = Symbol.for("openclaw.voice-call.runtime");
const VOICE_CALL_RUNTIME_PROMISE_KEY = Symbol.for("openclaw.voice-call.runtimePromise");
const VOICE_CALL_RUNTIME_STOP_PROMISE_KEY = Symbol.for("openclaw.voice-call.runtimeStopPromise");
function getVoiceCallRuntimeGlobalState() {
	const state = globalThis;
	state[VOICE_CALL_RUNTIME_KEY] ??= null;
	state[VOICE_CALL_RUNTIME_PROMISE_KEY] ??= null;
	state[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] ??= null;
	return state;
}
var voice_call_default = definePluginEntry({
	id: "voice-call",
	name: "Voice Call",
	description: "Voice-call plugin with Telnyx/Twilio/Plivo providers",
	configSchema: voiceCallConfigSchema,
	register(api) {
		const config = resolveVoiceCallConfig(voiceCallConfigSchema.parse(api.pluginConfig));
		const validation = validateProviderConfig(config);
		if (api.pluginConfig && typeof api.pluginConfig === "object") for (const warning of formatVoiceCallLegacyConfigWarnings({
			value: api.pluginConfig,
			configPathPrefix: "plugins.entries.voice-call.config",
			doctorFixCommand: "openclaw doctor --fix"
		})) api.logger.warn(warning);
		const runtimeState = getVoiceCallRuntimeGlobalState();
		const continueOperationStore = createVoiceCallContinueOperationStore({
			config,
			coreConfig: api.config
		});
		const ensureRuntime = async () => {
			if (!config.enabled) throw new Error("Voice call disabled in plugin config");
			if (!validation.valid) throw new Error(validation.errors.join("; "));
			while (true) {
				if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY]) {
					await runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY];
					continue;
				}
				const runtime = runtimeState[VOICE_CALL_RUNTIME_KEY];
				if (runtime) return runtime;
				let runtimePromise = runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY];
				if (!runtimePromise) {
					runtimePromise = createVoiceCallRuntime({
						config,
						coreConfig: api.config,
						fullConfig: api.config,
						agentRuntime: api.runtime.agent,
						ttsRuntime: api.runtime.tts,
						logger: api.logger
					});
					runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] = runtimePromise;
				}
				try {
					const createdRuntime = await runtimePromise;
					if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY]) continue;
					if (runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] !== runtimePromise) continue;
					runtimeState[VOICE_CALL_RUNTIME_KEY] = createdRuntime;
					return createdRuntime;
				} catch (err) {
					if (runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] === runtimePromise) {
						runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] = null;
						runtimeState[VOICE_CALL_RUNTIME_KEY] = null;
					}
					throw err;
				}
			}
		};
		const respondError = (respond, message, code = ErrorCodes.UNAVAILABLE) => {
			respond(false, void 0, errorShape(code, message));
		};
		const sendError = (respond, err) => {
			respondError(respond, formatErrorMessage(err));
		};
		const describeHistoricalCall = async (rt, callId) => {
			const call = (await rt.manager.getCallHistory(100)).toReversed().find((candidate) => candidate.callId === callId || candidate.providerCallId === callId);
			if (!call) return;
			return `call is not active (${[
				`last state=${call.state}`,
				call.endReason ? `endReason=${call.endReason}` : void 0,
				call.endedAt ? `endedAt=${new Date(call.endedAt).toISOString()}` : void 0
			].filter(Boolean).join(", ")})`;
		};
		const resolveCallMessageRequest = async (params) => {
			const callId = normalizeOptionalString(params?.callId) ?? "";
			const message = normalizeOptionalString(params?.message) ?? "";
			if (!callId || !message) return { error: "callId and message required" };
			const rt = await ensureRuntime();
			const activeCall = rt.manager.getCall(callId) ?? rt.manager.getCallByProviderCallId(callId);
			if (activeCall) return {
				rt,
				callId: activeCall.callId,
				message
			};
			return { error: await describeHistoricalCall(rt, callId) ?? "Call not found" };
		};
		const initiateCallAndRespond = async (params) => {
			const result = await params.rt.manager.initiateCall(params.to, void 0, {
				message: params.message,
				mode: params.mode,
				dtmfSequence: params.dtmfSequence
			});
			if (!result.success) {
				respondError(params.respond, result.error || "initiate failed");
				return;
			}
			params.respond(true, {
				callId: result.callId,
				initiated: true
			});
		};
		const respondToCallMessageAction = async (params) => {
			const request = await resolveCallMessageRequest(params.requestParams);
			if ("error" in request) {
				respondError(params.respond, request.error ?? "callId and message required", ErrorCodes.INVALID_REQUEST);
				return;
			}
			const result = await params.action(request);
			if (!result.success) {
				respondError(params.respond, result.error || params.failure);
				return;
			}
			params.respond(true, params.includeTranscript ? {
				success: true,
				transcript: result.transcript
			} : { success: true });
		};
		api.registerGatewayMethod("voicecall.initiate", async ({ params, respond }) => {
			try {
				const message = normalizeOptionalString(params?.message) ?? "";
				if (!message) {
					respondError(respond, "message required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				const rt = await ensureRuntime();
				const to = normalizeOptionalString(params?.to) ?? rt.config.toNumber;
				if (!to) {
					respondError(respond, "to required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				await initiateCallAndRespond({
					rt,
					respond,
					to,
					message,
					mode: params?.mode === "notify" || params?.mode === "conversation" ? params.mode : void 0
				});
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_WRITE_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.continue", async ({ params, respond }) => {
			try {
				await respondToCallMessageAction({
					requestParams: params,
					respond,
					action: (request) => request.rt.manager.continueCall(request.callId, request.message),
					failure: "continue failed",
					includeTranscript: true
				});
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_WRITE_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.continue.start", async ({ params, respond }) => {
			try {
				const request = await resolveCallMessageRequest(params);
				if ("error" in request) {
					respondError(respond, request.error ?? "callId and message required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				respond(true, continueOperationStore.start(request));
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_WRITE_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.continue.result", async ({ params, respond }) => {
			try {
				const operationId = normalizeOptionalString(params?.operationId) ?? "";
				if (!operationId) {
					respondError(respond, "operationId required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				const operation = continueOperationStore.read(operationId);
				if (!operation.ok) {
					respondError(respond, operation.error, ErrorCodes.INVALID_REQUEST);
					return;
				}
				respond(true, operation.payload);
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_READ_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.speak", async ({ params, respond }) => {
			try {
				const request = await resolveCallMessageRequest(params);
				if ("error" in request) {
					respondError(respond, request.error ?? "callId and message required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				if (request.rt.config.realtime.enabled) {
					const realtimeResult = request.rt.webhookServer.speakRealtime(request.callId, request.message);
					if (realtimeResult.success) {
						respond(true, { success: true });
						return;
					}
					if (params?.allowTwimlFallback === false) {
						respond(true, {
							success: false,
							error: realtimeResult.error ?? "Realtime bridge is not active"
						});
						return;
					}
				}
				const result = await request.rt.manager.speak(request.callId, request.message);
				if (!result.success) {
					respondError(respond, result.error || "speak failed");
					return;
				}
				respond(true, { success: true });
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_WRITE_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.dtmf", async ({ params, respond }) => {
			try {
				const callId = normalizeOptionalString(params?.callId) ?? "";
				const digits = normalizeOptionalString(params?.digits) ?? "";
				if (!callId || !digits) {
					respondError(respond, "callId and digits required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				const result = await (await ensureRuntime()).manager.sendDtmf(callId, digits);
				if (!result.success) {
					respondError(respond, result.error || "dtmf failed");
					return;
				}
				respond(true, { success: true });
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_WRITE_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.end", async ({ params, respond }) => {
			try {
				const callId = normalizeOptionalString(params?.callId) ?? "";
				if (!callId) {
					respondError(respond, "callId required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				const result = await (await ensureRuntime()).manager.endCall(callId);
				if (!result.success) {
					respondError(respond, result.error || "end failed");
					return;
				}
				respond(true, { success: true });
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_WRITE_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.status", async ({ params, respond }) => {
			try {
				const raw = normalizeOptionalString(params?.callId) ?? normalizeOptionalString(params?.sid) ?? "";
				const rt = await ensureRuntime();
				if (!raw) {
					respond(true, {
						found: true,
						calls: rt.manager.getActiveCalls()
					});
					return;
				}
				const call = rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
				if (!call) {
					respond(true, { found: false });
					return;
				}
				respond(true, {
					found: true,
					call
				});
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_READ_METHOD_SCOPE);
		api.registerGatewayMethod("voicecall.start", async ({ params, respond }) => {
			try {
				const to = normalizeOptionalString(params?.to) ?? "";
				const message = normalizeOptionalString(params?.message) ?? "";
				const dtmfSequence = normalizeOptionalString(params?.dtmfSequence);
				if (!to) {
					respondError(respond, "to required", ErrorCodes.INVALID_REQUEST);
					return;
				}
				const mode = params?.mode === "notify" || params?.mode === "conversation" ? params.mode : void 0;
				await initiateCallAndRespond({
					rt: await ensureRuntime(),
					respond,
					to,
					message: message || void 0,
					mode,
					dtmfSequence
				});
			} catch (err) {
				sendError(respond, err);
			}
		}, VOICE_CALL_WRITE_METHOD_SCOPE);
		api.registerTool({
			name: "voice_call",
			label: "Voice Call",
			description: "Make phone calls and have voice conversations via the voice-call plugin.",
			parameters: VoiceCallToolSchema,
			async execute(_toolCallId, params) {
				const rawParams = asParamRecord(params);
				const json = (payload) => ({
					content: [{
						type: "text",
						text: JSON.stringify(payload, null, 2)
					}],
					details: payload
				});
				try {
					const rt = await ensureRuntime();
					if (typeof rawParams.action === "string") switch (rawParams.action) {
						case "initiate_call": {
							const message = normalizeOptionalString(rawParams.message) ?? "";
							if (!message) throw new Error("message required");
							const to = normalizeOptionalString(rawParams.to) ?? rt.config.toNumber;
							if (!to) throw new Error("to required");
							const result = await rt.manager.initiateCall(to, void 0, {
								message,
								dtmfSequence: normalizeOptionalString(rawParams.dtmfSequence),
								mode: rawParams.mode === "notify" || rawParams.mode === "conversation" ? rawParams.mode : void 0
							});
							if (!result.success) throw new Error(result.error || "initiate failed");
							return json({
								callId: result.callId,
								initiated: true
							});
						}
						case "continue_call": {
							const callId = normalizeOptionalString(rawParams.callId) ?? "";
							const message = normalizeOptionalString(rawParams.message) ?? "";
							if (!callId || !message) throw new Error("callId and message required");
							const result = await rt.manager.continueCall(callId, message);
							if (!result.success) throw new Error(result.error || "continue failed");
							return json({
								success: true,
								transcript: result.transcript
							});
						}
						case "speak_to_user": {
							const callId = normalizeOptionalString(rawParams.callId) ?? "";
							const message = normalizeOptionalString(rawParams.message) ?? "";
							if (!callId || !message) throw new Error("callId and message required");
							const result = await rt.manager.speak(callId, message);
							if (!result.success) throw new Error(result.error || "speak failed");
							return json({ success: true });
						}
						case "send_dtmf": {
							const callId = normalizeOptionalString(rawParams.callId) ?? "";
							const digits = normalizeOptionalString(rawParams.digits) ?? "";
							if (!callId || !digits) throw new Error("callId and digits required");
							const result = await rt.manager.sendDtmf(callId, digits);
							if (!result.success) throw new Error(result.error || "dtmf failed");
							return json({ success: true });
						}
						case "end_call": {
							const callId = normalizeOptionalString(rawParams.callId) ?? "";
							if (!callId) throw new Error("callId required");
							const result = await rt.manager.endCall(callId);
							if (!result.success) throw new Error(result.error || "end failed");
							return json({ success: true });
						}
						case "get_status": {
							const callId = normalizeOptionalString(rawParams.callId) ?? "";
							if (!callId) throw new Error("callId required");
							const call = rt.manager.getCall(callId) || rt.manager.getCallByProviderCallId(callId);
							return json(call ? {
								found: true,
								call
							} : { found: false });
						}
					}
					if ((rawParams.mode ?? "call") === "status") {
						const sid = normalizeOptionalString(rawParams.sid) ?? "";
						if (!sid) throw new Error("sid required for status");
						const call = rt.manager.getCall(sid) || rt.manager.getCallByProviderCallId(sid);
						return json(call ? {
							found: true,
							call
						} : { found: false });
					}
					const to = normalizeOptionalString(rawParams.to) ?? rt.config.toNumber;
					if (!to) throw new Error("to required for call");
					const result = await rt.manager.initiateCall(to, void 0, {
						dtmfSequence: normalizeOptionalString(rawParams.dtmfSequence),
						message: normalizeOptionalString(rawParams.message)
					});
					if (!result.success) throw new Error(result.error || "initiate failed");
					return json({
						callId: result.callId,
						initiated: true
					});
				} catch (err) {
					return json({ error: formatErrorMessage(err) });
				}
			}
		});
		api.registerCli(({ program }) => registerVoiceCallCli({
			program,
			config,
			ensureRuntime,
			logger: api.logger
		}), { commands: ["voicecall"] });
		api.registerService({
			id: "voicecall",
			start: () => {
				if (isCliOnlyProcess()) return;
				if (!config.enabled) return;
				if (!validation.valid) {
					api.logger.warn(`[voice-call] Runtime not started; setup incomplete: ${validation.errors.join("; ")}`);
					return;
				}
				ensureRuntime().catch((err) => {
					api.logger.error(`[voice-call] Failed to start runtime: ${formatErrorMessage(err)}`);
				});
			},
			stop: async () => {
				if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY]) {
					await runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY];
					return;
				}
				const runtime = runtimeState[VOICE_CALL_RUNTIME_KEY];
				const runtimePromise = runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY];
				if (!runtime && !runtimePromise) return;
				runtimeState[VOICE_CALL_RUNTIME_KEY] = null;
				runtimeState[VOICE_CALL_RUNTIME_PROMISE_KEY] = null;
				const stopPromise = (async () => {
					await (runtime ?? await runtimePromise).stop();
				})();
				runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] = stopPromise;
				try {
					await stopPromise;
				} finally {
					if (runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] === stopPromise) runtimeState[VOICE_CALL_RUNTIME_STOP_PROMISE_KEY] = null;
				}
			}
		});
	}
});
//#endregion
export { voice_call_default as default };
