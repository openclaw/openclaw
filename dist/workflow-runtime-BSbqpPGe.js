import { c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { c as isRecord, p as resolveUserPath } from "./utils-sBTEdeml.js";
import { d as normalizeSecretInputString, h as resolveSecretInputString } from "./types.secrets-DwPik3M8.js";
import { o as isPrivateOrLoopbackHost } from "./net-DCUMtgJy.js";
import { r as extensionForMime } from "./mime-DppuT-pZ.js";
import { a as normalizeBaseUrl } from "./provider-request-config-DxK6PUHR.js";
import { m as mergeSsrFPolicies } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { r as assertOkOrThrowHttpError } from "./provider-http-errors-C90BH-le.js";
import { p as resolveProviderHttpRequestConfig } from "./shared-D8kCtbT2.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { r as isProviderApiKeyConfigured } from "./provider-auth-BtRKd5us.js";
import { n as buildHostnameAllowlistPolicyFromSuffixAllowlist, u as ssrfPolicyFromDangerouslyAllowPrivateNetwork } from "./ssrf-policy-CIwd6x-p.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./media-mime-j2Nhr7Df.js";
import { i as canResolveEnvSecretRefInReadOnlyPath } from "./extension-shared-DSIp8QS_.js";
import { o as resolveApiKeyForProvider } from "./provider-auth-runtime-COV17c31.js";
import "./provider-http-CYBE-CBM.js";
import "./secret-input-runtime-BxNajKSO.js";
import "./text-utility-runtime-CaGXarh9.js";
import fs from "node:fs/promises";
//#region extensions/comfy/workflow-runtime.ts
const DEFAULT_COMFY_LOCAL_BASE_URL = "http://127.0.0.1:8188";
const DEFAULT_COMFY_CLOUD_BASE_URL = "https://cloud.comfy.org";
const DEFAULT_PROMPT_INPUT_NAME = "text";
const DEFAULT_INPUT_IMAGE_INPUT_NAME = "image";
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 5 * 6e4;
const DEFAULT_COMFY_MODEL = "workflow";
let comfyFetchGuard = fetchWithSsrFGuard;
function setComfyFetchGuardForTesting(impl) {
	comfyFetchGuard = impl ?? fetchWithSsrFGuard;
}
function readConfigBoolean(config, key) {
	const value = config[key];
	return typeof value === "boolean" ? value : void 0;
}
function readConfigInteger(config, key) {
	const value = config[key];
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : void 0;
}
function getComfyConfig(cfg) {
	const pluginConfig = cfg?.plugins?.entries?.comfy?.config;
	if (isRecord(pluginConfig)) return pluginConfig;
	const legacyConfig = cfg?.models?.providers?.comfy;
	return isRecord(legacyConfig) ? legacyConfig : {};
}
function stripNestedCapabilityConfig(config) {
	const next = { ...config };
	delete next.image;
	delete next.video;
	delete next.music;
	return next;
}
function getComfyCapabilityConfig(config, capability) {
	const shared = stripNestedCapabilityConfig(config);
	const nested = config[capability];
	if (!isRecord(nested)) return shared;
	return {
		...shared,
		...nested
	};
}
function resolveComfyMode(config) {
	return normalizeOptionalString(config.mode) === "cloud" ? "cloud" : "local";
}
function resolveComfyApiKey(config, cfg) {
	const resolved = resolveSecretInputString({
		value: config.apiKey,
		path: "plugins.entries.comfy.config.apiKey",
		defaults: cfg?.secrets?.defaults,
		mode: "inspect"
	});
	if (resolved.status === "available") {
		const apiKey = normalizeSecretInputString(resolved.value);
		return apiKey ? {
			status: "available",
			apiKey,
			source: "plugins.entries.comfy.config.apiKey"
		} : { status: "missing" };
	}
	if (resolved.status === "configured_unavailable") {
		if (resolved.ref.source !== "env") return { status: "configured_unavailable" };
		const envVarName = resolved.ref.id.trim();
		if (!canResolveEnvSecretRefInReadOnlyPath({
			cfg,
			provider: resolved.ref.provider,
			id: envVarName
		})) return { status: "configured_unavailable" };
		const apiKey = normalizeSecretInputString(process.env[envVarName]);
		return apiKey ? {
			status: "available",
			apiKey,
			source: `plugins.entries.comfy.config.apiKey (${envVarName})`
		} : { status: "configured_unavailable" };
	}
	return { status: "missing" };
}
function getRequiredConfigString(config, key) {
	const value = normalizeOptionalString(config[key]);
	if (!value) throw new Error(`plugins.entries.comfy.config.${key} is required`);
	return value;
}
function resolveComfyWorkflowSource(config) {
	const workflow = config.workflow;
	if (isRecord(workflow)) return { workflow: structuredClone(workflow) };
	return { workflowPath: normalizeOptionalString(config.workflowPath) };
}
async function loadComfyWorkflow(config) {
	const source = resolveComfyWorkflowSource(config);
	if (source.workflow) return source.workflow;
	if (!source.workflowPath) throw new Error("plugins.entries.comfy.config.<capability>.workflow or workflowPath is required");
	const resolvedPath = resolveUserPath(source.workflowPath);
	const raw = await fs.readFile(resolvedPath, "utf8");
	const parsed = JSON.parse(raw);
	if (!isRecord(parsed)) throw new Error(`Comfy workflow at ${resolvedPath} must be a JSON object`);
	return parsed;
}
function setWorkflowInput(params) {
	const node = params.workflow[params.nodeId];
	if (!isRecord(node)) throw new Error(`Comfy workflow missing node "${params.nodeId}"`);
	const inputs = node.inputs;
	if (!isRecord(inputs)) throw new Error(`Comfy workflow node "${params.nodeId}" is missing an inputs object`);
	inputs[params.inputName] = params.value;
}
function resolveComfyNetworkPolicy(params) {
	let parsed;
	try {
		parsed = new URL(params.baseUrl);
	} catch {
		return {};
	}
	const hostname = normalizeOptionalLowercaseString(parsed.hostname) ?? "";
	if (!hostname || !params.allowPrivateNetwork || !isPrivateOrLoopbackHost(hostname)) return {};
	return { apiPolicy: mergeSsrFPolicies(buildHostnameAllowlistPolicyFromSuffixAllowlist([hostname]), ssrfPolicyFromDangerouslyAllowPrivateNetwork(true)) };
}
async function readJsonResponse(params) {
	const { response, release } = await comfyFetchGuard({
		url: params.url,
		init: params.init,
		timeoutMs: params.timeoutMs,
		policy: params.policy,
		dispatcherPolicy: params.dispatcherPolicy,
		auditContext: params.auditContext
	});
	try {
		await assertOkOrThrowHttpError(response, params.errorPrefix);
		try {
			return await response.json();
		} catch (cause) {
			throw new Error(`${params.errorPrefix}: malformed JSON response`, { cause });
		}
	} finally {
		await release();
	}
}
function resolveFileExtension(params) {
	const extension = extensionForMime(params.mimeType);
	if (extension) return extension.slice(1);
	const fileName = params.fileName?.trim();
	if (!fileName) return "bin";
	const dotIndex = fileName.lastIndexOf(".");
	if (dotIndex < 0 || dotIndex === fileName.length - 1) return "bin";
	return fileName.slice(dotIndex + 1);
}
function toBlobBytes(buffer) {
	const arrayBuffer = new ArrayBuffer(buffer.byteLength);
	new Uint8Array(arrayBuffer).set(buffer);
	return arrayBuffer;
}
async function uploadInputImage(params) {
	const form = new FormData();
	form.set("image", new Blob([toBlobBytes(params.image.buffer)], { type: params.image.mimeType }), normalizeOptionalString(params.image.fileName) || `input.${resolveFileExtension({ mimeType: params.image.mimeType })}`);
	form.set("type", "input");
	form.set("overwrite", "true");
	const headers = new Headers(params.headers);
	headers.delete("Content-Type");
	const payload = await readJsonResponse({
		url: `${params.baseUrl}${params.mode === "cloud" ? "/api/upload/image" : "/upload/image"}`,
		init: {
			method: "POST",
			headers,
			body: form
		},
		timeoutMs: params.timeoutMs,
		policy: params.policy,
		dispatcherPolicy: params.dispatcherPolicy,
		auditContext: `comfy-${params.capability}-upload`,
		errorPrefix: "Comfy image upload failed"
	});
	const uploadedName = normalizeOptionalString(payload.filename) || normalizeOptionalString(payload.name);
	if (!uploadedName) throw new Error("Comfy image upload response missing filename");
	return uploadedName;
}
function extractHistoryEntry(history, promptId) {
	if (!isRecord(history)) return null;
	const directOutputs = history.outputs;
	if (isRecord(directOutputs)) return history;
	const nested = history[promptId];
	if (isRecord(nested)) return nested;
	return null;
}
async function waitForLocalHistory(params) {
	const deadline = Date.now() + params.timeoutMs;
	while (Date.now() <= deadline) {
		const entry = extractHistoryEntry(await readJsonResponse({
			url: `${params.baseUrl}/history/${params.promptId}`,
			init: {
				method: "GET",
				headers: params.headers
			},
			timeoutMs: params.timeoutMs,
			policy: params.policy,
			dispatcherPolicy: params.dispatcherPolicy,
			auditContext: "comfy-history",
			errorPrefix: "Comfy history lookup failed"
		}), params.promptId);
		if (entry?.outputs && Object.keys(entry.outputs).length > 0) return entry;
		await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
	}
	throw new Error(`Comfy workflow did not finish within ${Math.ceil(params.timeoutMs / 1e3)}s`);
}
async function waitForCloudCompletion(params) {
	const deadline = Date.now() + params.timeoutMs;
	while (Date.now() <= deadline) {
		const status = await readJsonResponse({
			url: `${params.baseUrl}/api/job/${params.promptId}/status`,
			init: {
				method: "GET",
				headers: params.headers
			},
			timeoutMs: params.timeoutMs,
			policy: params.policy,
			dispatcherPolicy: params.dispatcherPolicy,
			auditContext: "comfy-status",
			errorPrefix: "Comfy status lookup failed"
		});
		if (status.status === "completed") return;
		if (status.status === "failed" || status.status === "cancelled") throw new Error(`Comfy workflow ${status.status}: ${status.error ?? status.message ?? params.promptId}`);
		await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
	}
	throw new Error(`Comfy workflow did not finish within ${Math.ceil(params.timeoutMs / 1e3)}s`);
}
function collectOutputFiles(params) {
	const outputs = params.history.outputs;
	if (!outputs) return [];
	const nodeIds = params.outputNodeId ? [params.outputNodeId] : Object.keys(outputs);
	const files = [];
	for (const nodeId of nodeIds) {
		const entry = outputs[nodeId];
		if (!entry) continue;
		for (const kind of params.outputKinds) {
			const bucket = entry[kind];
			if (!Array.isArray(bucket)) continue;
			for (const file of bucket) files.push({
				nodeId,
				file
			});
		}
	}
	return files;
}
async function downloadOutputFile(params) {
	const fileName = normalizeOptionalString(params.file.filename) || normalizeOptionalString(params.file.name);
	if (!fileName) throw new Error("Comfy output entry missing filename");
	const query = new URLSearchParams({
		filename: fileName,
		subfolder: normalizeOptionalString(params.file.subfolder) ?? "",
		type: normalizeOptionalString(params.file.type) ?? "output"
	});
	const viewPath = params.mode === "cloud" ? "/api/view" : "/view";
	const auditContext = `comfy-${params.capability}-download`;
	const firstResponse = await comfyFetchGuard({
		url: `${params.baseUrl}${viewPath}?${query.toString()}`,
		init: {
			method: "GET",
			headers: params.headers,
			...params.mode === "cloud" ? { redirect: "manual" } : {}
		},
		timeoutMs: params.timeoutMs,
		policy: params.policy,
		dispatcherPolicy: params.dispatcherPolicy,
		auditContext
	});
	try {
		if (params.mode === "cloud" && [
			301,
			302,
			303,
			307,
			308
		].includes(firstResponse.response.status)) {
			const redirectUrl = normalizeOptionalString(firstResponse.response.headers.get("location"));
			if (!redirectUrl) throw new Error("Comfy cloud output redirect missing location header");
			const redirected = await comfyFetchGuard({
				url: redirectUrl,
				init: { method: "GET" },
				timeoutMs: params.timeoutMs,
				dispatcherPolicy: params.dispatcherPolicy,
				auditContext
			});
			try {
				await assertOkOrThrowHttpError(redirected.response, "Comfy output download failed");
				const mimeType = normalizeOptionalString(redirected.response.headers.get("content-type")) || "application/octet-stream";
				return {
					buffer: Buffer.from(await redirected.response.arrayBuffer()),
					mimeType
				};
			} finally {
				await redirected.release();
			}
		}
		await assertOkOrThrowHttpError(firstResponse.response, "Comfy output download failed");
		const mimeType = normalizeOptionalString(firstResponse.response.headers.get("content-type")) || "application/octet-stream";
		return {
			buffer: Buffer.from(await firstResponse.response.arrayBuffer()),
			mimeType
		};
	} finally {
		await firstResponse.release();
	}
}
function isComfyCapabilityConfigured(params) {
	const capabilityConfig = getComfyCapabilityConfig(getComfyConfig(params.cfg), params.capability);
	const hasWorkflow = Boolean(resolveComfyWorkflowSource(capabilityConfig).workflow || normalizeOptionalString(capabilityConfig.workflowPath));
	const hasPromptNode = Boolean(normalizeOptionalString(capabilityConfig.promptNodeId));
	if (!hasWorkflow || !hasPromptNode) return false;
	if (resolveComfyMode(capabilityConfig) === "local") return true;
	const configuredApiKey = resolveComfyApiKey(capabilityConfig, params.cfg);
	if (configuredApiKey.status === "available") return true;
	if (configuredApiKey.status === "configured_unavailable") return false;
	return isProviderApiKeyConfigured({
		provider: "comfy",
		agentDir: params.agentDir
	});
}
async function runComfyWorkflow(params) {
	const capabilityConfig = getComfyCapabilityConfig(getComfyConfig(params.cfg), params.capability);
	const mode = resolveComfyMode(capabilityConfig);
	const workflow = await loadComfyWorkflow(capabilityConfig);
	const promptNodeId = getRequiredConfigString(capabilityConfig, "promptNodeId");
	const promptInputName = normalizeOptionalString(capabilityConfig.promptInputName) ?? DEFAULT_PROMPT_INPUT_NAME;
	const inputImageNodeId = normalizeOptionalString(capabilityConfig.inputImageNodeId);
	const inputImageInputName = normalizeOptionalString(capabilityConfig.inputImageInputName) ?? DEFAULT_INPUT_IMAGE_INPUT_NAME;
	const outputNodeId = normalizeOptionalString(capabilityConfig.outputNodeId);
	const pollIntervalMs = readConfigInteger(capabilityConfig, "pollIntervalMs") ?? DEFAULT_POLL_INTERVAL_MS;
	const timeoutMs = readConfigInteger(capabilityConfig, "timeoutMs") ?? params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const providerModel = normalizeOptionalString(params.model) || "workflow";
	setWorkflowInput({
		workflow,
		nodeId: promptNodeId,
		inputName: promptInputName,
		value: params.prompt
	});
	const pluginApiKey = resolveComfyApiKey(capabilityConfig, params.cfg);
	const resolvedAuth = mode === "cloud" ? pluginApiKey.status === "available" ? {
		apiKey: pluginApiKey.apiKey,
		source: pluginApiKey.source,
		mode: "api-key"
	} : pluginApiKey.status === "configured_unavailable" ? null : await resolveApiKeyForProvider({
		provider: "comfy",
		cfg: params.cfg,
		agentDir: params.agentDir,
		store: params.authStore
	}) : null;
	if (mode === "cloud" && !resolvedAuth?.apiKey) throw new Error("Comfy Cloud API key missing");
	const { baseUrl, allowPrivateNetwork, headers, dispatcherPolicy } = resolveProviderHttpRequestConfig({
		baseUrl: normalizeOptionalString(capabilityConfig.baseUrl),
		defaultBaseUrl: mode === "cloud" ? DEFAULT_COMFY_CLOUD_BASE_URL : DEFAULT_COMFY_LOCAL_BASE_URL,
		allowPrivateNetwork: mode === "local" || readConfigBoolean(capabilityConfig, "allowPrivateNetwork") === true,
		defaultHeaders: mode === "cloud" ? {
			"X-API-Key": resolvedAuth?.apiKey ?? "",
			"Content-Type": "application/json"
		} : { "Content-Type": "application/json" },
		provider: "comfy",
		capability: params.capability === "music" ? "audio" : params.capability,
		transport: "http"
	});
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl) || (mode === "cloud" ? DEFAULT_COMFY_CLOUD_BASE_URL : DEFAULT_COMFY_LOCAL_BASE_URL);
	const networkPolicy = resolveComfyNetworkPolicy({
		baseUrl: normalizedBaseUrl,
		allowPrivateNetwork
	});
	if (params.inputImage) {
		if (!inputImageNodeId) throw new Error("Comfy edit requests require plugins.entries.comfy.config.<capability>.inputImageNodeId to be configured");
		setWorkflowInput({
			workflow,
			nodeId: inputImageNodeId,
			inputName: inputImageInputName,
			value: await uploadInputImage({
				baseUrl: normalizedBaseUrl,
				headers: new Headers(headers),
				timeoutMs,
				policy: networkPolicy.apiPolicy,
				dispatcherPolicy,
				image: params.inputImage,
				mode,
				capability: params.capability
			})
		});
	}
	const submitPayload = {
		prompt: workflow,
		...mode === "cloud" && resolvedAuth?.apiKey ? { extra_data: { api_key_comfy_org: resolvedAuth.apiKey } } : {}
	};
	const promptId = normalizeOptionalString((await readJsonResponse({
		url: `${normalizedBaseUrl}${mode === "cloud" ? "/api/prompt" : "/prompt"}`,
		init: {
			method: "POST",
			headers,
			body: JSON.stringify(submitPayload)
		},
		timeoutMs,
		policy: networkPolicy.apiPolicy,
		dispatcherPolicy,
		auditContext: `comfy-${params.capability}-generate`,
		errorPrefix: "Comfy workflow submit failed"
	})).prompt_id);
	if (!promptId) throw new Error("Comfy workflow submit response missing prompt_id");
	const historyEntry = extractHistoryEntry(mode === "cloud" ? await (async () => {
		await waitForCloudCompletion({
			baseUrl: normalizedBaseUrl,
			promptId,
			headers: new Headers(headers),
			timeoutMs,
			pollIntervalMs,
			policy: networkPolicy.apiPolicy,
			dispatcherPolicy
		});
		return await readJsonResponse({
			url: `${normalizedBaseUrl}/api/history_v2/${promptId}`,
			init: {
				method: "GET",
				headers: new Headers(headers)
			},
			timeoutMs,
			policy: networkPolicy.apiPolicy,
			dispatcherPolicy,
			auditContext: "comfy-history",
			errorPrefix: "Comfy history lookup failed"
		});
	})() : await waitForLocalHistory({
		baseUrl: normalizedBaseUrl,
		promptId,
		headers: new Headers(headers),
		timeoutMs,
		pollIntervalMs,
		policy: networkPolicy.apiPolicy,
		dispatcherPolicy
	}), promptId);
	if (!historyEntry) throw new Error(`Comfy history response missing outputs for prompt ${promptId}`);
	const outputFiles = collectOutputFiles({
		history: historyEntry,
		outputNodeId,
		outputKinds: params.outputKinds
	});
	if (outputFiles.length === 0) throw new Error(`Comfy workflow ${promptId} completed without ${params.capability} outputs`);
	const assets = [];
	let assetIndex = 0;
	for (const output of outputFiles) {
		const downloaded = await downloadOutputFile({
			baseUrl: normalizedBaseUrl,
			headers: new Headers(headers),
			timeoutMs,
			policy: networkPolicy.apiPolicy,
			dispatcherPolicy,
			file: output.file,
			mode,
			capability: params.capability
		});
		assetIndex += 1;
		const originalName = normalizeOptionalString(output.file.filename) || normalizeOptionalString(output.file.name);
		assets.push({
			buffer: downloaded.buffer,
			mimeType: downloaded.mimeType,
			fileName: originalName || `${params.capability}-${assetIndex}.${resolveFileExtension({ mimeType: downloaded.mimeType })}`,
			nodeId: output.nodeId
		});
	}
	return {
		assets,
		model: providerModel,
		promptId,
		outputNodeIds: Array.from(new Set(outputFiles.map((entry) => entry.nodeId)))
	};
}
//#endregion
export { setComfyFetchGuardForTesting as a, runComfyWorkflow as i, getComfyConfig as n, isComfyCapabilityConfigured as r, DEFAULT_COMFY_MODEL as t };
