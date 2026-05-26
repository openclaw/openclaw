import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { a as logWarn } from "./logger-Dtrz4Rfi.js";
import { i as emitAgentEvent, l as onAgentEvent } from "./agent-events-CXxjiM_O.js";
import { i as isClientToolNameConflictError } from "./tool-split-CRTr29lR.js";
import { i as wrapExternalContent } from "./external-content-CjyYcKYs.js";
import { t as renderFileContextBlock } from "./file-context-BLoq0c-4.js";
import { a as extractImageContentFromSource, c as resolveInputFileLimits, i as extractFileContentFromSource, n as DEFAULT_INPUT_IMAGE_MIMES, o as normalizeMimeList } from "./input-files-CbOAsIgo.js";
import { r as agentCommandFromIngress } from "./agent-command-BQgTSh4F.js";
import { t as createDefaultDeps } from "./deps-eRxJcC0K.js";
import "./agent-834cof0Q.js";
import { a as sendJson, d as writeDone, l as setSseHeaders, u as watchClientDisconnect } from "./http-common-DBTbbBna.js";
import { a as getHeader, i as getBearerToken, l as resolveOpenAiCompatibleHttpOperatorScopes, u as resolveOpenAiCompatibleHttpSenderIsOwner } from "./http-auth-utils-Chseq2ys.js";
import { a as resolveGatewayRequestContext, o as resolveOpenAiCompatModelOverride, r as resolveAgentIdForRequest } from "./http-utils-0S65IYEg.js";
import { t as handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers-DamJdEfH.js";
import { n as buildAgentMessageFromConversationEntries, r as resolveAssistantStreamDeltaText, t as normalizeInputHostnameAllowlist } from "./input-allowlist-yY3PrJsO.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
//#region src/gateway/open-responses.schema.ts
/**
* OpenResponses API Zod Schemas
*
* Zod schemas for the OpenResponses `/v1/responses` endpoint.
* This module is isolated from gateway imports to enable future codegen and prevent drift.
*
* @see https://www.open-responses.com/
*/
const InputTextContentPartSchema = z.object({
	type: z.literal("input_text"),
	text: z.string()
}).strict();
const OutputTextContentPartSchema = z.object({
	type: z.literal("output_text"),
	text: z.string()
}).strict();
const InputImageSourceSchema = z.discriminatedUnion("type", [z.object({
	type: z.literal("url"),
	url: z.string().url()
}), z.object({
	type: z.literal("base64"),
	media_type: z.enum([
		"image/jpeg",
		"image/png",
		"image/gif",
		"image/webp",
		"image/heic",
		"image/heif"
	]),
	data: z.string().min(1)
})]);
const InputImageContentPartSchema = z.object({
	type: z.literal("input_image"),
	source: InputImageSourceSchema
}).strict();
const InputFileSourceSchema = z.discriminatedUnion("type", [z.object({
	type: z.literal("url"),
	url: z.string().url()
}), z.object({
	type: z.literal("base64"),
	media_type: z.string().min(1),
	data: z.string().min(1),
	filename: z.string().optional()
})]);
const InputFileContentPartSchema = z.object({
	type: z.literal("input_file"),
	source: InputFileSourceSchema
}).strict();
const ContentPartSchema = z.discriminatedUnion("type", [
	InputTextContentPartSchema,
	OutputTextContentPartSchema,
	InputImageContentPartSchema,
	InputFileContentPartSchema
]);
const MessageItemRoleSchema = z.enum([
	"system",
	"developer",
	"user",
	"assistant"
]);
const AssistantPhaseSchema = z.enum(["commentary", "final_answer"]);
const MessageItemSchema = z.object({
	type: z.literal("message"),
	role: MessageItemRoleSchema,
	content: z.union([z.string(), z.array(ContentPartSchema)]),
	phase: AssistantPhaseSchema.optional()
}).strict().superRefine((value, ctx) => {
	if (value.phase !== void 0 && value.role !== "assistant") ctx.addIssue({
		code: z.ZodIssueCode.custom,
		path: ["phase"],
		message: "`phase` is only valid on assistant messages."
	});
});
const FunctionCallItemSchema = z.object({
	type: z.literal("function_call"),
	id: z.string().optional(),
	call_id: z.string().optional(),
	name: z.string(),
	arguments: z.string()
}).strict();
const FunctionCallOutputItemSchema = z.object({
	type: z.literal("function_call_output"),
	call_id: z.string(),
	output: z.string()
}).strict();
const ReasoningItemSchema = z.object({
	type: z.literal("reasoning"),
	content: z.string().optional(),
	encrypted_content: z.string().optional(),
	summary: z.string().optional()
}).strict();
const ItemReferenceItemSchema = z.object({
	type: z.literal("item_reference"),
	id: z.string()
}).strict();
const ItemParamSchema = z.discriminatedUnion("type", [
	MessageItemSchema,
	FunctionCallItemSchema,
	FunctionCallOutputItemSchema,
	ReasoningItemSchema,
	ItemReferenceItemSchema
]);
const ToolDefinitionSchema = z.object({
	type: z.literal("function"),
	name: z.string().min(1, "Tool name cannot be empty"),
	description: z.string().optional(),
	parameters: z.record(z.string(), z.unknown()).optional(),
	strict: z.boolean().optional()
}).strict();
const ToolChoiceSchema = z.union([
	z.literal("auto"),
	z.literal("none"),
	z.literal("required"),
	z.object({
		type: z.literal("function"),
		function: z.object({ name: z.string() })
	})
]);
const CreateResponseBodySchema = z.object({
	model: z.string(),
	input: z.union([z.string(), z.array(ItemParamSchema)]),
	instructions: z.string().optional(),
	tools: z.array(ToolDefinitionSchema).optional(),
	tool_choice: ToolChoiceSchema.optional(),
	stream: z.boolean().optional(),
	max_output_tokens: z.number().int().positive().optional(),
	max_tool_calls: z.number().int().positive().optional(),
	user: z.string().optional(),
	temperature: z.number().optional(),
	top_p: z.number().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	store: z.boolean().optional(),
	previous_response_id: z.string().optional(),
	reasoning: z.object({
		effort: z.enum([
			"low",
			"medium",
			"high"
		]).optional(),
		summary: z.enum([
			"auto",
			"concise",
			"detailed"
		]).optional()
	}).optional(),
	truncation: z.enum(["auto", "disabled"]).optional()
}).strict();
const ResponseStatusSchema = z.enum([
	"in_progress",
	"completed",
	"failed",
	"cancelled",
	"incomplete"
]);
const OutputItemSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("message"),
		id: z.string(),
		role: z.literal("assistant"),
		content: z.array(OutputTextContentPartSchema),
		phase: AssistantPhaseSchema.optional(),
		status: z.enum(["in_progress", "completed"]).optional()
	}).strict(),
	z.object({
		type: z.literal("function_call"),
		id: z.string(),
		call_id: z.string(),
		name: z.string(),
		arguments: z.string(),
		status: z.enum(["in_progress", "completed"]).optional()
	}).strict(),
	z.object({
		type: z.literal("reasoning"),
		id: z.string(),
		content: z.string().optional(),
		summary: z.string().optional()
	}).strict()
]);
const UsageSchema = z.object({
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	total_tokens: z.number().int().nonnegative()
});
const ResponseResourceSchema = z.object({
	id: z.string(),
	object: z.literal("response"),
	created_at: z.number().int(),
	status: ResponseStatusSchema,
	model: z.string(),
	output: z.array(OutputItemSchema),
	usage: UsageSchema,
	error: z.object({
		code: z.string(),
		message: z.string()
	}).optional()
});
z.object({
	type: z.literal("response.created"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.in_progress"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.completed"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.failed"),
	response: ResponseResourceSchema
});
z.object({
	type: z.literal("response.output_item.added"),
	output_index: z.number().int().nonnegative(),
	item: OutputItemSchema
});
z.object({
	type: z.literal("response.output_item.done"),
	output_index: z.number().int().nonnegative(),
	item: OutputItemSchema
});
z.object({
	type: z.literal("response.content_part.added"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	part: OutputTextContentPartSchema
});
z.object({
	type: z.literal("response.content_part.done"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	part: OutputTextContentPartSchema
});
z.object({
	type: z.literal("response.output_text.delta"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	delta: z.string()
});
z.object({
	type: z.literal("response.output_text.done"),
	item_id: z.string(),
	output_index: z.number().int().nonnegative(),
	content_index: z.number().int().nonnegative(),
	text: z.string()
});
//#endregion
//#region src/gateway/openresponses-file-content.ts
function wrapUntrustedFileContent(content) {
	return wrapExternalContent(content, {
		source: "unknown",
		includeWarning: false
	});
}
//#endregion
//#region src/gateway/openresponses-prompt.ts
function extractTextContent(content) {
	if (typeof content === "string") return content;
	return content.map((part) => {
		if (part.type === "input_text") return part.text;
		if (part.type === "output_text") return part.text;
		return "";
	}).filter(Boolean).join("\n");
}
function buildAgentPrompt(input) {
	if (typeof input === "string") return { message: input };
	const systemParts = [];
	const conversationEntries = [];
	for (const item of input) if (item.type === "message") {
		const content = extractTextContent(item.content).trim();
		if (!content) continue;
		if (item.role === "system" || item.role === "developer") {
			systemParts.push(content);
			continue;
		}
		const normalizedRole = item.role === "assistant" ? "assistant" : "user";
		const sender = normalizedRole === "assistant" ? "Assistant" : "User";
		conversationEntries.push({
			role: normalizedRole,
			entry: {
				sender,
				body: content
			}
		});
	} else if (item.type === "function_call_output") conversationEntries.push({
		role: "tool",
		entry: {
			sender: `Tool:${item.call_id}`,
			body: item.output
		}
	});
	return {
		message: buildAgentMessageFromConversationEntries(conversationEntries),
		extraSystemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : void 0
	};
}
//#endregion
//#region src/gateway/openresponses-shape.ts
function createAssistantOutputItem(params) {
	return {
		type: "message",
		id: params.id,
		role: "assistant",
		content: [{
			type: "output_text",
			text: params.text
		}],
		...params.phase ? { phase: params.phase } : {},
		status: params.status
	};
}
function createFunctionCallOutputItem(params) {
	return {
		type: "function_call",
		id: params.id,
		call_id: params.callId,
		name: params.name,
		arguments: params.arguments,
		status: params.status
	};
}
//#endregion
//#region src/gateway/openresponses-http.ts
/**
* OpenResponses HTTP Handler
*
* Implements the OpenResponses `/v1/responses` endpoint for OpenClaw Gateway.
*
* @see https://www.open-responses.com/
*/
const DEFAULT_BODY_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_URL_PARTS = 8;
const RESPONSE_SESSION_TTL_MS = 1800 * 1e3;
const MAX_RESPONSE_SESSION_ENTRIES = 500;
const responseSessionMap = /* @__PURE__ */ new Map();
function normalizeResponseSessionScope(scope) {
	const authSubject = scope.authSubject.trim();
	const requestedSessionKey = scope.requestedSessionKey?.trim();
	return {
		authSubject,
		agentId: scope.agentId,
		requestedSessionKey: requestedSessionKey || void 0
	};
}
function resolveResponseSessionAuthSubject(params) {
	const bearer = getBearerToken(params.req);
	if (bearer) return `bearer:${createHash("sha256").update(bearer).digest("hex")}`;
	if (params.auth.mode === "trusted-proxy" && params.auth.trustedProxy?.userHeader) {
		const user = getHeader(params.req, params.auth.trustedProxy.userHeader)?.trim();
		if (user) return `trusted-proxy:${user}`;
	}
	return `gateway-auth:${params.auth.mode}`;
}
function createResponseSessionScope(params) {
	return normalizeResponseSessionScope({
		authSubject: resolveResponseSessionAuthSubject({
			req: params.req,
			auth: params.auth
		}),
		agentId: params.agentId,
		requestedSessionKey: getHeader(params.req, "x-openclaw-session-key")
	});
}
function matchesResponseSessionScope(entry, scope) {
	return entry.authSubject === scope.authSubject && entry.agentId === scope.agentId && entry.requestedSessionKey === scope.requestedSessionKey;
}
function pruneExpiredResponseSessions(now) {
	while (responseSessionMap.size > 0) {
		const oldest = responseSessionMap.entries().next().value;
		if (!oldest) return;
		const [oldestKey, oldestValue] = oldest;
		if (now - oldestValue.ts <= RESPONSE_SESSION_TTL_MS) return;
		responseSessionMap.delete(oldestKey);
	}
}
function evictOverflowResponseSessions() {
	while (responseSessionMap.size > MAX_RESPONSE_SESSION_ENTRIES) {
		const oldestKey = responseSessionMap.keys().next().value;
		if (!oldestKey) return;
		responseSessionMap.delete(oldestKey);
	}
}
function storeResponseSession(responseId, sessionKey, scope, now = Date.now()) {
	responseSessionMap.delete(responseId);
	responseSessionMap.set(responseId, {
		...scope,
		sessionKey,
		ts: now
	});
	pruneExpiredResponseSessions(now);
	evictOverflowResponseSessions();
}
function lookupResponseSession(responseId, scope, now = Date.now()) {
	if (!responseId) return;
	const entry = responseSessionMap.get(responseId);
	if (!entry) return;
	if (now - entry.ts > RESPONSE_SESSION_TTL_MS) {
		responseSessionMap.delete(responseId);
		return;
	}
	if (!matchesResponseSessionScope(entry, scope)) return;
	return entry.sessionKey;
}
const __testing = {
	resetResponseSessionState() {
		responseSessionMap.clear();
	},
	wrapUntrustedFileContent,
	storeResponseSessionAt(responseId, sessionKey, now, scope = {
		authSubject: "test",
		agentId: "main"
	}) {
		storeResponseSession(responseId, sessionKey, normalizeResponseSessionScope(scope), now);
	},
	lookupResponseSessionAt(responseId, now, scope = {
		authSubject: "test",
		agentId: "main"
	}) {
		return lookupResponseSession(responseId, normalizeResponseSessionScope(scope), now);
	},
	getResponseSessionIds() {
		return [...responseSessionMap.keys()];
	}
};
function writeSseEvent(res, event) {
	res.write(`event: ${event.type}\n`);
	res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function resolveResponsesLimits(config) {
	const files = config?.files;
	const images = config?.images;
	const fileLimits = resolveInputFileLimits(files);
	return {
		maxBodyBytes: config?.maxBodyBytes ?? DEFAULT_BODY_BYTES,
		maxUrlParts: typeof config?.maxUrlParts === "number" ? Math.max(0, Math.floor(config.maxUrlParts)) : DEFAULT_MAX_URL_PARTS,
		files: {
			...fileLimits,
			urlAllowlist: normalizeInputHostnameAllowlist(files?.urlAllowlist)
		},
		images: {
			allowUrl: images?.allowUrl ?? true,
			urlAllowlist: normalizeInputHostnameAllowlist(images?.urlAllowlist),
			allowedMimes: normalizeMimeList(images?.allowedMimes, DEFAULT_INPUT_IMAGE_MIMES),
			maxBytes: images?.maxBytes ?? 10485760,
			maxRedirects: images?.maxRedirects ?? 3,
			timeoutMs: images?.timeoutMs ?? 1e4
		}
	};
}
function extractClientTools(body) {
	return (body.tools ?? []).map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			strict: tool.strict
		}
	}));
}
function applyToolChoice(params) {
	const { tools, toolChoice } = params;
	if (!toolChoice) return { tools };
	if (toolChoice === "none") return { tools: [] };
	if (toolChoice === "required") {
		if (tools.length === 0) throw new Error("tool_choice=required but no tools were provided");
		return {
			tools,
			extraSystemPrompt: "You must call one of the available tools before responding."
		};
	}
	if (typeof toolChoice === "object" && toolChoice.type === "function") {
		const targetName = toolChoice.function?.name?.trim();
		if (!targetName) throw new Error("tool_choice.function.name is required");
		const matched = tools.filter((tool) => tool.function?.name === targetName);
		if (matched.length === 0) throw new Error(`tool_choice requested unknown tool: ${targetName}`);
		return {
			tools: matched,
			extraSystemPrompt: `You must call the ${targetName} tool before responding.`
		};
	}
	return { tools };
}
function createEmptyUsage() {
	return {
		input_tokens: 0,
		output_tokens: 0,
		total_tokens: 0
	};
}
function toUsage(value) {
	if (!value) return createEmptyUsage();
	const input = value.input ?? 0;
	const output = value.output ?? 0;
	const cacheRead = value.cacheRead ?? 0;
	const cacheWrite = value.cacheWrite ?? 0;
	const total = value.total ?? input + output + cacheRead + cacheWrite;
	return {
		input_tokens: Math.max(0, input),
		output_tokens: Math.max(0, output),
		total_tokens: Math.max(0, total)
	};
}
function extractUsageFromResult(result) {
	const meta = result?.meta;
	return toUsage(meta && typeof meta === "object" ? meta.agentMeta?.usage : void 0);
}
function resolveStopReasonAndPendingToolCalls(meta) {
	if (!meta || typeof meta !== "object") return {
		stopReason: void 0,
		pendingToolCalls: void 0
	};
	const record = meta;
	return {
		stopReason: record.stopReason,
		pendingToolCalls: record.pendingToolCalls
	};
}
function createResponseResource(params) {
	return {
		id: params.id,
		object: "response",
		created_at: Math.floor(Date.now() / 1e3),
		status: params.status,
		model: params.model,
		output: params.output,
		usage: params.usage ?? createEmptyUsage(),
		error: params.error
	};
}
async function runResponsesAgentCommand(params) {
	return agentCommandFromIngress({
		message: params.message,
		images: params.images.length > 0 ? params.images : void 0,
		clientTools: params.clientTools.length > 0 ? params.clientTools : void 0,
		extraSystemPrompt: params.extraSystemPrompt || void 0,
		model: params.modelOverride,
		streamParams: params.streamParams ?? void 0,
		sessionKey: params.sessionKey,
		runId: params.runId,
		deliver: false,
		messageChannel: params.messageChannel,
		bestEffortDeliver: false,
		senderIsOwner: params.senderIsOwner,
		allowModelOverride: true,
		abortSignal: params.abortSignal
	}, defaultRuntime, params.deps);
}
async function handleOpenResponsesHttpRequest(req, res, opts) {
	const limits = resolveResponsesLimits(opts.config);
	const maxBodyBytes = opts.maxBodyBytes ?? (opts.config?.maxBodyBytes ? limits.maxBodyBytes : Math.max(limits.maxBodyBytes, limits.files.maxBytes * 2, limits.images.maxBytes * 2));
	const handled = await handleGatewayPostJsonEndpoint(req, res, {
		pathname: "/v1/responses",
		requiredOperatorMethod: "chat.send",
		resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter,
		maxBodyBytes
	});
	if (handled === false) return false;
	if (!handled) return true;
	const senderIsOwner = resolveOpenAiCompatibleHttpSenderIsOwner(req, handled.requestAuth);
	const parseResult = CreateResponseBodySchema.safeParse(handled.body);
	if (!parseResult.success) {
		const issue = parseResult.error.issues[0];
		sendJson(res, 400, { error: {
			message: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request body",
			type: "invalid_request_error"
		} });
		return true;
	}
	const payload = parseResult.data;
	const stream = Boolean(payload.stream);
	const model = payload.model;
	const user = payload.user;
	const { modelOverride, errorMessage: modelError } = await resolveOpenAiCompatModelOverride({
		req,
		agentId: resolveAgentIdForRequest({
			req,
			model
		}),
		model
	});
	if (modelError) {
		sendJson(res, 400, { error: {
			message: modelError,
			type: "invalid_request_error"
		} });
		return true;
	}
	let images = [];
	let fileContexts = [];
	let urlParts = 0;
	const markUrlPart = () => {
		urlParts += 1;
		if (urlParts > limits.maxUrlParts) throw new Error(`Too many URL-based input sources: ${urlParts} (limit: ${limits.maxUrlParts})`);
	};
	try {
		if (Array.isArray(payload.input)) {
			for (const item of payload.input) if (item.type === "message" && typeof item.content !== "string") for (const part of item.content) {
				if (part.type === "input_image") {
					const source = part.source;
					const sourceType = source.type === "base64" || source.type === "url" ? source.type : void 0;
					if (!sourceType) throw new Error("input_image must have 'source.url' or 'source.data'");
					if (sourceType === "url") markUrlPart();
					const image = await extractImageContentFromSource(sourceType === "url" ? {
						type: "url",
						url: source.url ?? "",
						mediaType: source.media_type
					} : {
						type: "base64",
						data: source.data ?? "",
						mediaType: source.media_type
					}, limits.images);
					images.push(image);
					continue;
				}
				if (part.type === "input_file") {
					const source = part.source;
					const sourceType = source.type === "base64" || source.type === "url" ? source.type : void 0;
					if (!sourceType) throw new Error("input_file must have 'source.url' or 'source.data'");
					if (sourceType === "url") markUrlPart();
					const file = await extractFileContentFromSource({
						source: sourceType === "url" ? {
							type: "url",
							url: source.url ?? "",
							mediaType: source.media_type,
							filename: source.filename
						} : {
							type: "base64",
							data: source.data ?? "",
							mediaType: source.media_type,
							filename: source.filename
						},
						limits: limits.files
					});
					const rawText = file.text;
					if (rawText?.trim()) fileContexts.push(renderFileContextBlock({
						filename: file.filename,
						content: wrapUntrustedFileContent(rawText)
					}));
					else if (file.images && file.images.length > 0) fileContexts.push(renderFileContextBlock({
						filename: file.filename,
						content: "[PDF content rendered to images]",
						surroundContentWithNewlines: false
					}));
					if (file.images && file.images.length > 0) images = images.concat(file.images);
				}
			}
		}
	} catch (err) {
		logWarn(`openresponses: request parsing failed: ${String(err)}`);
		sendJson(res, 400, { error: {
			message: "invalid request",
			type: "invalid_request_error"
		} });
		return true;
	}
	const clientTools = extractClientTools(payload);
	let toolChoicePrompt;
	let resolvedClientTools = clientTools;
	try {
		const toolChoiceResult = applyToolChoice({
			tools: clientTools,
			toolChoice: payload.tool_choice
		});
		resolvedClientTools = toolChoiceResult.tools;
		toolChoicePrompt = toolChoiceResult.extraSystemPrompt;
	} catch (err) {
		logWarn(`openresponses: tool configuration failed: ${String(err)}`);
		sendJson(res, 400, { error: {
			message: "invalid tool configuration",
			type: "invalid_request_error"
		} });
		return true;
	}
	const resolved = resolveGatewayRequestContext({
		req,
		model,
		user,
		sessionPrefix: "openresponses",
		defaultMessageChannel: "webchat",
		useMessageChannelHeader: true
	});
	const responseSessionScope = createResponseSessionScope({
		req,
		auth: opts.auth,
		agentId: resolved.agentId
	});
	const sessionKey = lookupResponseSession(payload.previous_response_id, responseSessionScope) ?? resolved.sessionKey;
	const messageChannel = resolved.messageChannel;
	const prompt = buildAgentPrompt(payload.input);
	const fileContext = fileContexts.length > 0 ? fileContexts.join("\n\n") : void 0;
	const toolChoiceContext = toolChoicePrompt?.trim();
	const extraSystemPrompt = [
		payload.instructions,
		prompt.extraSystemPrompt,
		toolChoiceContext,
		fileContext
	].filter(Boolean).join("\n\n");
	if (!prompt.message) {
		sendJson(res, 400, { error: {
			message: "Missing user message in `input`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	const responseId = `resp_${randomUUID()}`;
	const rememberResponseSession = () => storeResponseSession(responseId, sessionKey, responseSessionScope);
	const outputItemId = `msg_${randomUUID()}`;
	const deps = createDefaultDeps();
	const abortController = new AbortController();
	const streamParams = typeof payload.max_output_tokens === "number" ? { maxTokens: payload.max_output_tokens } : void 0;
	if (!stream) {
		const stopWatchingDisconnect = watchClientDisconnect(req, res, abortController);
		try {
			const result = await runResponsesAgentCommand({
				message: prompt.message,
				images,
				clientTools: resolvedClientTools,
				extraSystemPrompt,
				modelOverride,
				streamParams,
				sessionKey,
				runId: responseId,
				messageChannel,
				senderIsOwner,
				deps,
				abortSignal: abortController.signal
			});
			if (abortController.signal.aborted) return true;
			const payloads = result?.payloads;
			const usage = extractUsageFromResult(result);
			const meta = result?.meta;
			const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
			if (stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
				const assistantText = Array.isArray(payloads) && payloads.length > 0 ? payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") : "";
				const output = [];
				if (assistantText) output.push(createAssistantOutputItem({
					id: outputItemId,
					text: assistantText,
					phase: "commentary",
					status: "completed"
				}));
				for (const functionCall of pendingToolCalls) output.push(createFunctionCallOutputItem({
					id: `call_${randomUUID()}`,
					callId: functionCall.id,
					name: functionCall.name,
					arguments: functionCall.arguments
				}));
				const response = createResponseResource({
					id: responseId,
					model,
					status: "incomplete",
					output,
					usage
				});
				rememberResponseSession();
				sendJson(res, 200, response);
				return true;
			}
			const response = createResponseResource({
				id: responseId,
				model,
				status: "completed",
				output: [createAssistantOutputItem({
					id: outputItemId,
					text: Array.isArray(payloads) && payloads.length > 0 ? payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") : "No response from OpenClaw.",
					phase: "final_answer",
					status: "completed"
				})],
				usage
			});
			rememberResponseSession();
			sendJson(res, 200, response);
		} catch (err) {
			if (abortController.signal.aborted) return true;
			logWarn(`openresponses: non-stream response failed: ${String(err)}`);
			if (isClientToolNameConflictError(err)) {
				sendJson(res, 400, createResponseResource({
					id: responseId,
					model,
					status: "failed",
					output: [],
					error: {
						code: "invalid_request_error",
						message: "invalid tool configuration"
					}
				}));
				return true;
			}
			const response = createResponseResource({
				id: responseId,
				model,
				status: "failed",
				output: [],
				error: {
					code: "api_error",
					message: "internal error"
				}
			});
			rememberResponseSession();
			sendJson(res, 500, response);
		} finally {
			stopWatchingDisconnect();
		}
		return true;
	}
	setSseHeaders(res);
	let accumulatedText = "";
	let sawAssistantDelta = false;
	let closed = false;
	let unsubscribe = () => {};
	let stopWatchingDisconnect = () => {};
	let finalUsage;
	let finalizeRequested = null;
	const maybeFinalize = () => {
		if (closed) return;
		if (!finalizeRequested) return;
		if (!finalUsage) return;
		const usage = finalUsage;
		closed = true;
		stopWatchingDisconnect();
		unsubscribe();
		writeSseEvent(res, {
			type: "response.output_text.done",
			item_id: outputItemId,
			output_index: 0,
			content_index: 0,
			text: finalizeRequested.text
		});
		writeSseEvent(res, {
			type: "response.content_part.done",
			item_id: outputItemId,
			output_index: 0,
			content_index: 0,
			part: {
				type: "output_text",
				text: finalizeRequested.text
			}
		});
		const completedItem = createAssistantOutputItem({
			id: outputItemId,
			text: finalizeRequested.text,
			phase: finalizeRequested.status === "completed" ? "final_answer" : "commentary",
			status: "completed"
		});
		writeSseEvent(res, {
			type: "response.output_item.done",
			output_index: 0,
			item: completedItem
		});
		const finalResponse = createResponseResource({
			id: responseId,
			model,
			status: finalizeRequested.status,
			output: [completedItem],
			usage
		});
		rememberResponseSession();
		writeSseEvent(res, {
			type: "response.completed",
			response: finalResponse
		});
		writeDone(res);
		res.end();
	};
	const requestFinalize = (status, text) => {
		if (finalizeRequested) return;
		finalizeRequested = {
			status,
			text
		};
		maybeFinalize();
	};
	const initialResponse = createResponseResource({
		id: responseId,
		model,
		status: "in_progress",
		output: []
	});
	writeSseEvent(res, {
		type: "response.created",
		response: initialResponse
	});
	writeSseEvent(res, {
		type: "response.in_progress",
		response: initialResponse
	});
	writeSseEvent(res, {
		type: "response.output_item.added",
		output_index: 0,
		item: createAssistantOutputItem({
			id: outputItemId,
			text: "",
			status: "in_progress"
		})
	});
	writeSseEvent(res, {
		type: "response.content_part.added",
		item_id: outputItemId,
		output_index: 0,
		content_index: 0,
		part: {
			type: "output_text",
			text: ""
		}
	});
	unsubscribe = onAgentEvent((evt) => {
		if (evt.runId !== responseId) return;
		if (closed) return;
		if (evt.stream === "assistant") {
			const text = evt.data?.text;
			if (evt.data?.replace === true && typeof text === "string") accumulatedText = text;
			const content = resolveAssistantStreamDeltaText(evt);
			if (!content) return;
			sawAssistantDelta = true;
			accumulatedText += content;
			writeSseEvent(res, {
				type: "response.output_text.delta",
				item_id: outputItemId,
				output_index: 0,
				content_index: 0,
				delta: content
			});
			return;
		}
		if (evt.stream === "lifecycle") {
			const phase = evt.data?.phase;
			if (phase === "end" || phase === "error") requestFinalize(phase === "error" ? "failed" : "completed", accumulatedText || "No response from OpenClaw.");
		}
	});
	stopWatchingDisconnect = watchClientDisconnect(req, res, abortController, () => {
		closed = true;
		unsubscribe();
	});
	(async () => {
		try {
			const result = await runResponsesAgentCommand({
				message: prompt.message,
				images,
				clientTools: resolvedClientTools,
				extraSystemPrompt,
				modelOverride,
				streamParams,
				sessionKey,
				runId: responseId,
				messageChannel,
				senderIsOwner,
				deps,
				abortSignal: abortController.signal
			});
			finalUsage = extractUsageFromResult(result);
			const resultAny = result;
			const meta = resultAny.meta;
			const { stopReason, pendingToolCalls } = resolveStopReasonAndPendingToolCalls(meta);
			if (!closed && stopReason === "tool_calls" && pendingToolCalls && pendingToolCalls.length > 0) {
				const usage = finalUsage ?? createEmptyUsage();
				const finalText = accumulatedText || (Array.isArray(resultAny.payloads) ? resultAny.payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") : "");
				writeSseEvent(res, {
					type: "response.output_text.done",
					item_id: outputItemId,
					output_index: 0,
					content_index: 0,
					text: finalText
				});
				writeSseEvent(res, {
					type: "response.content_part.done",
					item_id: outputItemId,
					output_index: 0,
					content_index: 0,
					part: {
						type: "output_text",
						text: finalText
					}
				});
				const completedItem = createAssistantOutputItem({
					id: outputItemId,
					text: finalText,
					phase: "commentary",
					status: "completed"
				});
				writeSseEvent(res, {
					type: "response.output_item.done",
					output_index: 0,
					item: completedItem
				});
				const functionCallItems = [];
				let nextStreamOutputIndex = 1;
				for (const functionCall of pendingToolCalls) {
					const functionCallItemId = `call_${randomUUID()}`;
					const functionCallItem = createFunctionCallOutputItem({
						id: functionCallItemId,
						callId: functionCall.id,
						name: functionCall.name,
						arguments: functionCall.arguments
					});
					writeSseEvent(res, {
						type: "response.output_item.added",
						output_index: nextStreamOutputIndex,
						item: functionCallItem
					});
					const completedFunctionCallItem = createFunctionCallOutputItem({
						id: functionCallItemId,
						callId: functionCall.id,
						name: functionCall.name,
						arguments: functionCall.arguments,
						status: "completed"
					});
					writeSseEvent(res, {
						type: "response.output_item.done",
						output_index: nextStreamOutputIndex,
						item: completedFunctionCallItem
					});
					functionCallItems.push(functionCallItem);
					nextStreamOutputIndex += 1;
				}
				const incompleteResponse = createResponseResource({
					id: responseId,
					model,
					status: "incomplete",
					output: [completedItem, ...functionCallItems],
					usage
				});
				closed = true;
				stopWatchingDisconnect();
				unsubscribe();
				rememberResponseSession();
				writeSseEvent(res, {
					type: "response.completed",
					response: incompleteResponse
				});
				writeDone(res);
				res.end();
				return;
			}
			maybeFinalize();
			if (closed) return;
			if (!sawAssistantDelta) {
				const payloads = resultAny.payloads;
				const content = Array.isArray(payloads) && payloads.length > 0 ? payloads.map((p) => typeof p.text === "string" ? p.text : "").filter(Boolean).join("\n\n") : "No response from OpenClaw.";
				accumulatedText = content;
				sawAssistantDelta = true;
				writeSseEvent(res, {
					type: "response.output_text.delta",
					item_id: outputItemId,
					output_index: 0,
					content_index: 0,
					delta: content
				});
			}
		} catch (err) {
			if (closed || abortController.signal.aborted) return;
			logWarn(`openresponses: streaming response failed: ${String(err)}`);
			finalUsage = finalUsage ?? createEmptyUsage();
			if (isClientToolNameConflictError(err)) {
				writeSseEvent(res, {
					type: "response.failed",
					response: createResponseResource({
						id: responseId,
						model,
						status: "failed",
						output: [],
						error: {
							code: "invalid_request_error",
							message: "invalid tool configuration"
						},
						usage: finalUsage
					})
				});
				emitAgentEvent({
					runId: responseId,
					stream: "lifecycle",
					data: { phase: "error" }
				});
				return;
			}
			const errorResponse = createResponseResource({
				id: responseId,
				model,
				status: "failed",
				output: [],
				error: {
					code: "api_error",
					message: "internal error"
				},
				usage: finalUsage
			});
			rememberResponseSession();
			writeSseEvent(res, {
				type: "response.failed",
				response: errorResponse
			});
			emitAgentEvent({
				runId: responseId,
				stream: "lifecycle",
				data: { phase: "error" }
			});
		} finally {
			if (!closed) emitAgentEvent({
				runId: responseId,
				stream: "lifecycle",
				data: { phase: "end" }
			});
		}
	})();
	return true;
}
//#endregion
export { __testing, buildAgentPrompt, handleOpenResponsesHttpRequest };
