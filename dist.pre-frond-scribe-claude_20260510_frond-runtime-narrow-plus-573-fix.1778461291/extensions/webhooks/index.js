import { a as normalizeLowercaseStringOrEmpty } from "../../string-coerce-LndEvhRk.js";
import { t as resolveConfiguredSecretInputString } from "../../resolve-configured-secret-input-string-CAkKVZGk.js";
import { t as safeEqualSecret } from "../../secret-equal-ZBNsLQt9.js";
import { g as resolveRequestClientIp } from "../../net-I-1keREy.js";
import "../../text-runtime-CEUy8PW0.js";
import { t as definePluginEntry } from "../../plugin-entry-Db0KoQjL.js";
import "../../security-runtime-xUFanVUG.js";
import { a as createFixedWindowRateLimiter, r as WEBHOOK_RATE_LIMIT_DEFAULTS } from "../../webhook-ingress-BK9PCoig.js";
import { a as createWebhookInFlightLimiter, n as WEBHOOK_IN_FLIGHT_DEFAULTS, s as readJsonWebhookBodyOrReject } from "../../webhook-request-guards-DdIT8L7Q.js";
import { t as normalizeWebhookPath } from "../../webhook-path-bhr1QjC5.js";
import { l as withResolvedWebhookRequestPipeline, o as resolveWebhookTargetWithAuthOrReject } from "../../webhook-targets-Bloj0ok3.js";
import { t as zod_exports } from "../../zod-CH7V6TB8.js";
import "../../api-CfYs-u1P.js";
import "../../runtime-api-eU44Yh1A.js";
//#region extensions/webhooks/src/config.ts
const secretRefSchema = zod_exports.z.object({
	source: zod_exports.z.enum([
		"env",
		"file",
		"exec"
	]),
	provider: zod_exports.z.string().trim().min(1),
	id: zod_exports.z.string().trim().min(1)
}).strict();
const secretInputSchema = zod_exports.z.union([zod_exports.z.string().trim().min(1), secretRefSchema]);
const webhookRouteConfigSchema = zod_exports.z.object({
	enabled: zod_exports.z.boolean().optional().default(true),
	path: zod_exports.z.string().trim().min(1).optional(),
	sessionKey: zod_exports.z.string().trim().min(1),
	secret: secretInputSchema,
	controllerId: zod_exports.z.string().trim().min(1).optional(),
	description: zod_exports.z.string().trim().min(1).optional()
}).strict();
const webhooksPluginConfigSchema = zod_exports.z.object({ routes: zod_exports.z.record(zod_exports.z.string().trim().min(1), webhookRouteConfigSchema).default({}) }).strict();
function resolveWebhooksPluginConfig(params) {
	const parsed = webhooksPluginConfigSchema.parse(params.pluginConfig ?? {});
	const configuredRoutes = [];
	const seenPaths = /* @__PURE__ */ new Map();
	for (const [routeId, route] of Object.entries(parsed.routes)) {
		if (!route.enabled) continue;
		const path = normalizeWebhookPath(route.path ?? `/plugins/webhooks/${routeId}`);
		const existingRouteId = seenPaths.get(path);
		if (existingRouteId) throw new Error(`webhooks.routes.${routeId}.path conflicts with routes.${existingRouteId}.path (${path}).`);
		seenPaths.set(path, routeId);
		configuredRoutes.push({
			routeId,
			path,
			sessionKey: route.sessionKey,
			secret: route.secret,
			controllerId: route.controllerId ?? `webhooks/${routeId}`,
			...route.description ? { description: route.description } : {}
		});
	}
	return configuredRoutes;
}
//#endregion
//#region extensions/webhooks/src/http.ts
const jsonValueSchema = zod_exports.z.lazy(() => zod_exports.z.union([
	zod_exports.z.null(),
	zod_exports.z.boolean(),
	zod_exports.z.number().finite(),
	zod_exports.z.string(),
	zod_exports.z.array(jsonValueSchema),
	zod_exports.z.record(zod_exports.z.string(), jsonValueSchema)
]));
const nullableStringSchema = zod_exports.z.string().trim().min(1).nullable().optional();
const createFlowRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("create_flow"),
	controllerId: zod_exports.z.string().trim().min(1).optional(),
	goal: zod_exports.z.string().trim().min(1),
	status: zod_exports.z.enum([
		"queued",
		"running",
		"waiting",
		"blocked"
	]).optional(),
	notifyPolicy: zod_exports.z.enum([
		"done_only",
		"state_changes",
		"silent"
	]).optional(),
	currentStep: nullableStringSchema,
	stateJson: jsonValueSchema.nullable().optional(),
	waitJson: jsonValueSchema.nullable().optional()
}).strict();
const getFlowRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("get_flow"),
	flowId: zod_exports.z.string().trim().min(1)
}).strict();
const listFlowsRequestSchema = zod_exports.z.object({ action: zod_exports.z.literal("list_flows") }).strict();
const findLatestFlowRequestSchema = zod_exports.z.object({ action: zod_exports.z.literal("find_latest_flow") }).strict();
const resolveFlowRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("resolve_flow"),
	token: zod_exports.z.string().trim().min(1)
}).strict();
const getTaskSummaryRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("get_task_summary"),
	flowId: zod_exports.z.string().trim().min(1)
}).strict();
const setWaitingRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("set_waiting"),
	flowId: zod_exports.z.string().trim().min(1),
	expectedRevision: zod_exports.z.number().int().nonnegative(),
	currentStep: nullableStringSchema,
	stateJson: jsonValueSchema.nullable().optional(),
	waitJson: jsonValueSchema.nullable().optional(),
	blockedTaskId: nullableStringSchema,
	blockedSummary: nullableStringSchema
}).strict();
const resumeFlowRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("resume_flow"),
	flowId: zod_exports.z.string().trim().min(1),
	expectedRevision: zod_exports.z.number().int().nonnegative(),
	status: zod_exports.z.enum(["queued", "running"]).optional(),
	currentStep: nullableStringSchema,
	stateJson: jsonValueSchema.nullable().optional()
}).strict();
const finishFlowRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("finish_flow"),
	flowId: zod_exports.z.string().trim().min(1),
	expectedRevision: zod_exports.z.number().int().nonnegative(),
	stateJson: jsonValueSchema.nullable().optional()
}).strict();
const failFlowRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("fail_flow"),
	flowId: zod_exports.z.string().trim().min(1),
	expectedRevision: zod_exports.z.number().int().nonnegative(),
	stateJson: jsonValueSchema.nullable().optional(),
	blockedTaskId: nullableStringSchema,
	blockedSummary: nullableStringSchema
}).strict();
const requestCancelRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("request_cancel"),
	flowId: zod_exports.z.string().trim().min(1),
	expectedRevision: zod_exports.z.number().int().nonnegative()
}).strict();
const cancelFlowRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("cancel_flow"),
	flowId: zod_exports.z.string().trim().min(1)
}).strict();
const runTaskRequestSchema = zod_exports.z.object({
	action: zod_exports.z.literal("run_task"),
	flowId: zod_exports.z.string().trim().min(1),
	runtime: zod_exports.z.enum(["subagent", "acp"]),
	sourceId: zod_exports.z.string().trim().min(1).optional(),
	childSessionKey: zod_exports.z.string().trim().min(1).optional(),
	parentTaskId: zod_exports.z.string().trim().min(1).optional(),
	agentId: zod_exports.z.string().trim().min(1).optional(),
	runId: zod_exports.z.string().trim().min(1).optional(),
	label: zod_exports.z.string().trim().min(1).optional(),
	task: zod_exports.z.string().trim().min(1),
	preferMetadata: zod_exports.z.boolean().optional(),
	notifyPolicy: zod_exports.z.enum([
		"done_only",
		"state_changes",
		"silent"
	]).optional(),
	status: zod_exports.z.enum(["queued", "running"]).optional(),
	startedAt: zod_exports.z.number().int().nonnegative().optional(),
	lastEventAt: zod_exports.z.number().int().nonnegative().optional(),
	progressSummary: nullableStringSchema
}).strict().superRefine((value, ctx) => {
	if (value.status !== "running" && (value.startedAt !== void 0 || value.lastEventAt !== void 0 || value.progressSummary !== void 0)) ctx.addIssue({
		code: zod_exports.z.ZodIssueCode.custom,
		message: "status must be running when startedAt, lastEventAt, or progressSummary is provided",
		path: ["status"]
	});
});
const webhookActionSchema = zod_exports.z.discriminatedUnion("action", [
	createFlowRequestSchema,
	getFlowRequestSchema,
	listFlowsRequestSchema,
	findLatestFlowRequestSchema,
	resolveFlowRequestSchema,
	getTaskSummaryRequestSchema,
	setWaitingRequestSchema,
	resumeFlowRequestSchema,
	finishFlowRequestSchema,
	failFlowRequestSchema,
	requestCancelRequestSchema,
	cancelFlowRequestSchema,
	runTaskRequestSchema
]);
function pickOptionalFields(source, keys) {
	const result = {};
	for (const key of keys) {
		const value = source[key];
		if (value !== void 0) result[key] = value;
	}
	return result;
}
function pickOptionalTruthyStringFields(source, keys) {
	const result = {};
	for (const key of keys) {
		const value = source[key];
		if (typeof value === "string" && value) result[key] = value;
	}
	return result;
}
function toFlowView(flow) {
	return {
		flowId: flow.flowId,
		syncMode: flow.syncMode,
		...pickOptionalTruthyStringFields(flow, [
			"controllerId",
			"currentStep",
			"blockedTaskId",
			"blockedSummary"
		]),
		revision: flow.revision,
		status: flow.status,
		notifyPolicy: flow.notifyPolicy,
		goal: flow.goal,
		...pickOptionalFields(flow, [
			"stateJson",
			"waitJson",
			"cancelRequestedAt"
		]),
		createdAt: flow.createdAt,
		updatedAt: flow.updatedAt,
		...pickOptionalFields(flow, ["endedAt"])
	};
}
function toTaskView(task) {
	return {
		taskId: task.taskId,
		runtime: task.runtime,
		...pickOptionalTruthyStringFields(task, [
			"sourceId",
			"childSessionKey",
			"parentFlowId",
			"parentTaskId",
			"agentId",
			"runId",
			"label",
			"error",
			"progressSummary",
			"terminalSummary",
			"terminalOutcome"
		]),
		scopeKind: task.scopeKind,
		task: task.task,
		status: task.status,
		deliveryStatus: task.deliveryStatus,
		notifyPolicy: task.notifyPolicy,
		createdAt: task.createdAt,
		...pickOptionalFields(task, [
			"startedAt",
			"endedAt",
			"lastEventAt",
			"cleanupAfter"
		])
	};
}
function writeJson(res, statusCode, body) {
	res.statusCode = statusCode;
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
function extractSharedSecret(req) {
	const authHeader = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] ?? "" : req.headers.authorization ?? "";
	if (normalizeLowercaseStringOrEmpty(authHeader).startsWith("bearer ")) return authHeader.slice(7).trim();
	const sharedHeader = req.headers["x-openclaw-webhook-secret"];
	return Array.isArray(sharedHeader) ? (sharedHeader[0] ?? "").trim() : (sharedHeader ?? "").trim();
}
function timingSafeEquals(left, right) {
	return safeEqualSecret(left, right);
}
function formatZodError(error) {
	const firstIssue = error.issues[0];
	if (!firstIssue) return "invalid request";
	return `${firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : ""}${firstIssue.message}`;
}
function mapMutationResult(result) {
	return result;
}
function mapFlowMutationResult(result) {
	return mapMutationResult(result.applied ? {
		applied: true,
		flow: toFlowView(result.flow)
	} : {
		applied: false,
		code: result.code,
		...result.current ? { current: toFlowView(result.current) } : {}
	});
}
function mapMutationStatus(result) {
	if (result.applied) return { statusCode: 200 };
	switch (result.code) {
		case "not_found": return {
			statusCode: 404,
			code: "not_found",
			error: "TaskFlow not found."
		};
		case "not_managed": return {
			statusCode: 409,
			code: "not_managed",
			error: "TaskFlow is not managed by this webhook surface."
		};
		case "revision_conflict": return {
			statusCode: 409,
			code: "revision_conflict",
			error: "TaskFlow changed since the caller's expected revision."
		};
		default: return {
			statusCode: 409,
			code: "mutation_rejected",
			error: "TaskFlow mutation was rejected."
		};
	}
}
function mapRunTaskStatus(result) {
	if (result.created) return { statusCode: 200 };
	if (!result.found) return {
		statusCode: 404,
		code: "not_found",
		error: "TaskFlow not found."
	};
	if (result.reason === "Flow cancellation has already been requested.") return {
		statusCode: 409,
		code: "cancel_requested",
		error: result.reason
	};
	if (result.reason === "Flow does not accept managed child tasks.") return {
		statusCode: 409,
		code: "not_managed",
		error: result.reason
	};
	if (result.reason?.startsWith("Flow is already ")) return {
		statusCode: 409,
		code: "terminal",
		error: result.reason
	};
	return {
		statusCode: 409,
		code: "task_not_created",
		error: result.reason ?? "TaskFlow task was not created."
	};
}
function mapCancelStatus(result) {
	if (result.cancelled) return { statusCode: 200 };
	if (!result.found) return {
		statusCode: 404,
		code: "not_found",
		error: "TaskFlow not found."
	};
	if (result.reason === "One or more child tasks are still active.") return {
		statusCode: 202,
		code: "cancel_pending",
		error: result.reason
	};
	if (result.reason === "Flow changed while cancellation was in progress.") return {
		statusCode: 409,
		code: "revision_conflict",
		error: result.reason
	};
	if (result.reason?.startsWith("Flow is already ")) return {
		statusCode: 409,
		code: "terminal",
		error: result.reason
	};
	return {
		statusCode: 409,
		code: "cancel_rejected",
		error: result.reason ?? "TaskFlow cancellation was rejected."
	};
}
function describeWebhookOutcome(params) {
	switch (params.action.action) {
		case "set_waiting":
		case "resume_flow":
		case "finish_flow":
		case "fail_flow":
		case "request_cancel": return mapMutationStatus(params.result);
		case "cancel_flow": return mapCancelStatus(params.result);
		case "run_task": return mapRunTaskStatus(params.result);
		default: return { statusCode: 200 };
	}
}
async function executeWebhookAction(params) {
	const { action, target } = params;
	switch (action.action) {
		case "create_flow": return { flow: toFlowView(target.taskFlow.createManaged({
			controllerId: action.controllerId ?? target.defaultControllerId,
			goal: action.goal,
			status: action.status,
			notifyPolicy: action.notifyPolicy,
			currentStep: action.currentStep ?? void 0,
			stateJson: action.stateJson,
			waitJson: action.waitJson
		})) };
		case "get_flow": {
			const flow = target.taskFlow.get(action.flowId);
			return { flow: flow ? toFlowView(flow) : null };
		}
		case "list_flows": return { flows: target.taskFlow.list().map(toFlowView) };
		case "find_latest_flow": {
			const flow = target.taskFlow.findLatest();
			return { flow: flow ? toFlowView(flow) : null };
		}
		case "resolve_flow": {
			const flow = target.taskFlow.resolve(action.token);
			return { flow: flow ? toFlowView(flow) : null };
		}
		case "get_task_summary": return { summary: target.taskFlow.getTaskSummary(action.flowId) ?? null };
		case "set_waiting": return mapFlowMutationResult(target.taskFlow.setWaiting({
			flowId: action.flowId,
			expectedRevision: action.expectedRevision,
			currentStep: action.currentStep,
			stateJson: action.stateJson,
			waitJson: action.waitJson,
			blockedTaskId: action.blockedTaskId,
			blockedSummary: action.blockedSummary
		}));
		case "resume_flow": return mapFlowMutationResult(target.taskFlow.resume({
			flowId: action.flowId,
			expectedRevision: action.expectedRevision,
			status: action.status,
			currentStep: action.currentStep,
			stateJson: action.stateJson
		}));
		case "finish_flow": return mapFlowMutationResult(target.taskFlow.finish({
			flowId: action.flowId,
			expectedRevision: action.expectedRevision,
			stateJson: action.stateJson
		}));
		case "fail_flow": return mapFlowMutationResult(target.taskFlow.fail({
			flowId: action.flowId,
			expectedRevision: action.expectedRevision,
			stateJson: action.stateJson,
			blockedTaskId: action.blockedTaskId,
			blockedSummary: action.blockedSummary
		}));
		case "request_cancel": return mapFlowMutationResult(target.taskFlow.requestCancel({
			flowId: action.flowId,
			expectedRevision: action.expectedRevision
		}));
		case "cancel_flow": {
			const result = await target.taskFlow.cancel({
				flowId: action.flowId,
				cfg: params.cfg
			});
			return {
				found: result.found,
				cancelled: result.cancelled,
				...result.reason ? { reason: result.reason } : {},
				...result.flow ? { flow: toFlowView(result.flow) } : {},
				...result.tasks ? { tasks: result.tasks.map(toTaskView) } : {}
			};
		}
		case "run_task": {
			const result = target.taskFlow.runTask({
				flowId: action.flowId,
				runtime: action.runtime,
				sourceId: action.sourceId,
				childSessionKey: action.childSessionKey,
				parentTaskId: action.parentTaskId,
				agentId: action.agentId,
				runId: action.runId,
				label: action.label,
				task: action.task,
				preferMetadata: action.preferMetadata,
				notifyPolicy: action.notifyPolicy,
				status: action.status,
				startedAt: action.startedAt,
				lastEventAt: action.lastEventAt,
				progressSummary: action.progressSummary
			});
			if (result.created) return {
				created: true,
				flow: toFlowView(result.flow),
				task: toTaskView(result.task)
			};
			return {
				found: result.found,
				created: false,
				reason: result.reason,
				...result.flow ? { flow: toFlowView(result.flow) } : {}
			};
		}
	}
	throw new Error("Unsupported webhook action");
}
function createTaskFlowWebhookRequestHandler(params) {
	const rateLimiter = createFixedWindowRateLimiter({
		windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
		maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
		maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys
	});
	const inFlightLimiter = params.inFlightLimiter ?? createWebhookInFlightLimiter({
		maxInFlightPerKey: WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey,
		maxTrackedKeys: WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys
	});
	const resolveTargetSecret = async (target) => {
		if (typeof target.secretInput === "string") return target.secretInput;
		return (await resolveConfiguredSecretInputString({
			config: params.cfg,
			env: process.env,
			value: target.secretInput,
			path: target.secretConfigPath
		})).value;
	};
	return async (req, res) => {
		return await withResolvedWebhookRequestPipeline({
			req,
			res,
			targetsByPath: params.targetsByPath,
			allowMethods: ["POST"],
			requireJsonContentType: true,
			rateLimiter,
			rateLimitKey: (() => {
				const clientIp = resolveRequestClientIp(req, params.cfg.gateway?.trustedProxies, params.cfg.gateway?.allowRealIpFallback === true) ?? req.socket.remoteAddress ?? "unknown";
				return `${new URL(req.url ?? "/", "http://localhost").pathname}:${clientIp}`;
			})(),
			inFlightLimiter,
			handle: async ({ targets }) => {
				const presentedSecret = extractSharedSecret(req);
				const target = await resolveWebhookTargetWithAuthOrReject({
					targets,
					res,
					isMatch: async (candidate) => {
						if (presentedSecret.length === 0) return false;
						const resolvedSecret = await resolveTargetSecret(candidate);
						return Boolean(resolvedSecret && timingSafeEquals(resolvedSecret, presentedSecret));
					}
				});
				if (!target) return true;
				const body = await readJsonWebhookBodyOrReject({
					req,
					res,
					maxBytes: 256 * 1024,
					timeoutMs: 15e3,
					emptyObjectOnEmpty: false,
					invalidJsonMessage: "invalid request body"
				});
				if (!body.ok) return true;
				const parsed = webhookActionSchema.safeParse(body.value);
				if (!parsed.success) {
					writeJson(res, 400, {
						ok: false,
						code: "invalid_request",
						error: formatZodError(parsed.error)
					});
					return true;
				}
				const result = await executeWebhookAction({
					action: parsed.data,
					target,
					cfg: params.cfg
				});
				const outcome = describeWebhookOutcome({
					action: parsed.data,
					result
				});
				writeJson(res, outcome.statusCode, outcome.statusCode < 400 ? {
					ok: true,
					routeId: target.routeId,
					...outcome.code ? { code: outcome.code } : {},
					result
				} : {
					ok: false,
					routeId: target.routeId,
					code: outcome.code ?? "request_rejected",
					error: outcome.error ?? "request rejected",
					result
				});
				return true;
			}
		});
	};
}
//#endregion
//#region extensions/webhooks/index.ts
function registerWebhookRoutes(api) {
	const routes = resolveWebhooksPluginConfig({ pluginConfig: api.pluginConfig });
	if (routes.length === 0) return;
	const targetsByPath = /* @__PURE__ */ new Map();
	const handler = createTaskFlowWebhookRequestHandler({
		cfg: api.config,
		targetsByPath
	});
	for (const route of routes) {
		const taskFlow = api.runtime.tasks.managedFlows.bindSession({ sessionKey: route.sessionKey });
		const target = {
			routeId: route.routeId,
			path: route.path,
			secretInput: route.secret,
			secretConfigPath: `plugins.entries.webhooks.routes.${route.routeId}.secret`,
			defaultControllerId: route.controllerId,
			taskFlow
		};
		targetsByPath.set(target.path, [...targetsByPath.get(target.path) ?? [], target]);
		api.registerHttpRoute({
			path: target.path,
			auth: "plugin",
			match: "exact",
			replaceExisting: true,
			handler
		});
		api.logger.info?.(`[webhooks] registered route ${route.routeId} on ${route.path} for session ${route.sessionKey}`);
	}
}
var webhooks_default = definePluginEntry({
	id: "webhooks",
	name: "Webhooks",
	description: "Authenticated inbound webhooks that bind external automation to OpenClaw TaskFlows.",
	register(api) {
		registerWebhookRoutes(api);
	}
});
//#endregion
export { webhooks_default as default };
