import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { t as dispatchGatewayMethod } from "../../gateway-method-runtime-BFariBif.js";
import { randomUUID } from "node:crypto";
//#region extensions/admin-http-rpc/src/methods.ts
const ADMIN_HTTP_RPC_ALLOWED_METHODS = new Set(Object.values({
	gateway: [
		"health",
		"status",
		"logs.tail",
		"usage.status",
		"usage.cost",
		"gateway.restart.request"
	],
	discovery: ["commands.list"],
	config: [
		"config.get",
		"config.schema",
		"config.schema.lookup",
		"config.set",
		"config.patch",
		"config.apply"
	],
	channels: [
		"channels.status",
		"channels.start",
		"channels.stop",
		"channels.logout"
	],
	web: ["web.login.start", "web.login.wait"],
	models: ["models.list", "models.authStatus"],
	agents: [
		"agents.list",
		"agents.create",
		"agents.update",
		"agents.delete"
	],
	approvals: [
		"exec.approvals.get",
		"exec.approvals.set",
		"exec.approvals.node.get",
		"exec.approvals.node.set"
	],
	cron: [
		"cron.status",
		"cron.list",
		"cron.get",
		"cron.runs",
		"cron.add",
		"cron.update",
		"cron.remove",
		"cron.run"
	],
	devices: [
		"device.pair.list",
		"device.pair.approve",
		"device.pair.reject",
		"device.pair.remove"
	],
	nodes: [
		"node.list",
		"node.describe",
		"node.pair.list",
		"node.pair.approve",
		"node.pair.reject",
		"node.pair.remove",
		"node.rename"
	],
	tasks: [
		"tasks.list",
		"tasks.get",
		"tasks.cancel"
	],
	diagnostics: ["doctor.memory.status", "update.status"]
}).flat());
function isAdminHttpRpcAllowedMethod(method) {
	return ADMIN_HTTP_RPC_ALLOWED_METHODS.has(method);
}
function listAdminHttpRpcAllowedMethods() {
	return Array.from(ADMIN_HTTP_RPC_ALLOWED_METHODS);
}
//#endregion
//#region extensions/admin-http-rpc/src/handler.ts
const DEFAULT_RPC_BODY_BYTES = 1024 * 1024;
const ErrorCodes = {
	AGENT_TIMEOUT: "AGENT_TIMEOUT",
	APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
	INVALID_REQUEST: "INVALID_REQUEST",
	NOT_LINKED: "NOT_LINKED",
	NOT_PAIRED: "NOT_PAIRED",
	UNAVAILABLE: "UNAVAILABLE"
};
function isRecord(value) {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function createError(code, message) {
	return {
		code,
		message
	};
}
function rpcHttpStatus(response) {
	if (response.ok) return 200;
	switch (response.error.code) {
		case ErrorCodes.INVALID_REQUEST: return 400;
		case ErrorCodes.APPROVAL_NOT_FOUND: return 404;
		case ErrorCodes.UNAVAILABLE: return 503;
		case ErrorCodes.AGENT_TIMEOUT: return 504;
		case ErrorCodes.NOT_LINKED:
		case ErrorCodes.NOT_PAIRED: return 409;
		default: return 500;
	}
}
function sendJson(res, status, body) {
	res.statusCode = status;
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Content-Type", "application/json; charset=utf-8");
	res.end(JSON.stringify(body));
}
function sendError(res, status, error) {
	sendJson(res, status, {
		ok: false,
		error
	});
}
async function readJsonBody(req, maxBytes) {
	const chunks = [];
	let totalBytes = 0;
	try {
		for await (const chunk of req) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			totalBytes += buffer.byteLength;
			if (totalBytes > maxBytes) return {
				ok: false,
				status: 413,
				message: "Payload too large"
			};
			chunks.push(buffer);
		}
	} catch {
		return {
			ok: false,
			status: 400,
			message: "failed to read request body"
		};
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return {
		ok: false,
		status: 400,
		message: "request body must be JSON"
	};
	try {
		return {
			ok: true,
			value: JSON.parse(raw)
		};
	} catch {
		return {
			ok: false,
			status: 400,
			message: "request body must be valid JSON"
		};
	}
}
function readRpcRequestBody(body) {
	if (!isRecord(body)) return {
		ok: false,
		message: "request body must be an object"
	};
	const rpcBody = body;
	if (typeof rpcBody.method !== "string" || rpcBody.method.trim().length === 0) return {
		ok: false,
		message: "method must be a non-empty string"
	};
	return {
		ok: true,
		request: {
			id: typeof rpcBody.id === "string" && rpcBody.id.trim().length > 0 ? rpcBody.id.trim() : randomUUID(),
			method: rpcBody.method.trim(),
			...Object.prototype.hasOwnProperty.call(rpcBody, "params") ? { params: rpcBody.params } : {}
		}
	};
}
function methodNotAllowed(id, method) {
	return {
		id,
		ok: false,
		error: createError(ErrorCodes.INVALID_REQUEST, `admin HTTP RPC method is not supported: ${method}`)
	};
}
function commandsList(id) {
	return {
		id,
		ok: true,
		payload: { methods: listAdminHttpRpcAllowedMethods() }
	};
}
async function dispatchAdminRpc(request) {
	try {
		const response = await dispatchGatewayMethod(request.method, request.params);
		if (response.ok) return {
			id: request.id,
			ok: true,
			payload: response.payload,
			...response.meta ? { meta: response.meta } : {}
		};
		return {
			id: request.id,
			ok: false,
			error: response.error ?? createError(ErrorCodes.UNAVAILABLE, "gateway method failed before returning a response"),
			...response.meta ? { meta: response.meta } : {}
		};
	} catch {
		return {
			id: request.id,
			ok: false,
			error: createError(ErrorCodes.UNAVAILABLE, "gateway method failed before returning a response")
		};
	}
}
async function handleAdminHttpRpcRequest(req, res) {
	if ((req.method ?? "GET").toUpperCase() !== "POST") {
		res.setHeader("Allow", "POST");
		sendError(res, 405, {
			type: "method_not_allowed",
			message: "Method Not Allowed"
		});
		return true;
	}
	const body = await readJsonBody(req, DEFAULT_RPC_BODY_BYTES);
	if (!body.ok) {
		sendError(res, body.status, {
			type: "invalid_request",
			message: body.message
		});
		return true;
	}
	const parsed = readRpcRequestBody(body.value);
	if (!parsed.ok) {
		sendError(res, 400, {
			type: "invalid_request",
			message: parsed.message
		});
		return true;
	}
	if (!isAdminHttpRpcAllowedMethod(parsed.request.method)) {
		const response = methodNotAllowed(parsed.request.id, parsed.request.method);
		sendJson(res, rpcHttpStatus(response), response);
		return true;
	}
	if (parsed.request.method === "commands.list") {
		sendJson(res, 200, commandsList(parsed.request.id));
		return true;
	}
	const response = await dispatchAdminRpc(parsed.request);
	sendJson(res, rpcHttpStatus(response), response);
	return true;
}
//#endregion
//#region extensions/admin-http-rpc/index.ts
var admin_http_rpc_default = definePluginEntry({
	id: "admin-http-rpc",
	name: "Admin HTTP RPC",
	description: "Expose selected Gateway admin RPC methods over HTTP",
	register(api) {
		api.registerHttpRoute({
			path: "/api/v1/admin/rpc",
			auth: "gateway",
			match: "exact",
			gatewayRuntimeScopeSurface: "trusted-operator",
			handler: handleAdminHttpRpcRequest
		});
	}
});
//#endregion
export { admin_http_rpc_default as default };
