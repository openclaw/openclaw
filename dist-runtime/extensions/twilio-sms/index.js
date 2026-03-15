import { z } from "zod";
import crypto from "node:crypto";
import http from "node:http";
import { Type } from "@sinclair/typebox";
import { parse } from "node:querystring";
//#region extensions/twilio-sms/src/config.ts
const E164Schema = z.string().regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");
/**
* Controls which senders can trigger agent dispatch:
* - "open": accept SMS from any number
* - "allowlist": only numbers in allowFrom are accepted; others get 403
*/
const InboundPolicySchema = z.enum(["open", "allowlist"]);
const TwilioCredsSchema = z.object({
	accountSid: z.string().min(1).optional(),
	authToken: z.string().min(1).optional()
}).strict();
const SmsServeConfigSchema = z.object({
	port: z.number().int().positive().default(3335),
	bind: z.string().default("127.0.0.1"),
	path: z.string().min(1).default("/sms/webhook")
}).strict().default({
	port: 3335,
	bind: "127.0.0.1",
	path: "/sms/webhook"
});
const SmsConfigSchema = z.object({
	fromNumber: E164Schema.optional(),
	twilio: TwilioCredsSchema.optional(),
	serve: SmsServeConfigSchema,
	publicUrl: z.string().url().optional(),
	inboundPolicy: InboundPolicySchema.default("allowlist"),
	allowFrom: z.array(E164Schema).default([]),
	skipSignatureVerification: z.boolean().default(false)
}).strict();
const DEFAULT_SMS_CONFIG = SmsConfigSchema.parse({});
function normalizeSmsConfig(input) {
	const defaults = structuredClone(DEFAULT_SMS_CONFIG);
	return {
		...defaults,
		...input,
		allowFrom: input.allowFrom ?? defaults.allowFrom,
		serve: {
			...defaults.serve,
			...input.serve
		},
		twilio: input.twilio ?? defaults.twilio
	};
}
/**
* Resolve config, filling in Twilio credentials from environment variables
* when not explicitly provided.
*/
function resolveSmsConfig(input) {
	const config = normalizeSmsConfig(input);
	config.twilio = config.twilio ?? {};
	config.twilio.accountSid = config.twilio.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
	config.twilio.authToken = config.twilio.authToken ?? process.env.TWILIO_AUTH_TOKEN;
	return config;
}
//#endregion
//#region extensions/twilio-sms/src/allowlist.ts
/** Strip all non-digit characters for comparison (mirrors voice-call/src/allowlist.ts). */
function normalizePhoneNumber(input) {
	if (!input) return "";
	return input.replace(/\D/g, "");
}
/** Return true if the digit-normalized sender matches any number in the allowlist. */
function isAllowlistedSender(normalizedFrom, allowFrom) {
	if (!normalizedFrom) return false;
	return (allowFrom ?? []).some((num) => {
		const normalizedAllow = normalizePhoneNumber(num);
		return normalizedAllow !== "" && normalizedAllow === normalizedFrom;
	});
}
//#endregion
//#region extensions/twilio-sms/src/webhook.ts
const MAX_BODY_BYTES = 64 * 1024;
/**
* Compute the Twilio HMAC-SHA1 signature for webhook validation.
* Algorithm: HMAC-SHA1(authToken, publicUrl + sorted(key + value pairs)) → base64.
* See: https://www.twilio.com/docs/usage/webhooks/webhooks-security
*/
function verifySmsSignature(authToken, publicUrl, params, signature) {
	const sortedStr = Object.keys(params).sort().reduce((acc, key) => acc + key + (params[key] ?? ""), publicUrl);
	const computed = crypto.createHmac("sha1", authToken).update(sortedStr, "utf8").digest("base64");
	try {
		return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
	} catch {
		return false;
	}
}
async function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		let bytes = 0;
		req.on("data", (chunk) => {
			bytes += chunk.length;
			if (bytes > MAX_BODY_BYTES) {
				req.destroy(/* @__PURE__ */ new Error("Request body too large"));
				return;
			}
			data += chunk.toString("utf8");
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}
/** Handle one inbound Twilio SMS POST. Responds immediately; dispatch is fire-and-forget. */
async function handleSmsRequest(req, res, opts) {
	const { config, onMessage } = opts;
	if (req.method !== "POST") {
		res.writeHead(405, { "Content-Type": "text/plain" });
		res.end("Method Not Allowed");
		return;
	}
	let rawBody;
	try {
		rawBody = await readBody(req);
	} catch {
		res.writeHead(400, { "Content-Type": "text/plain" });
		res.end("Bad Request");
		return;
	}
	const params = parse(rawBody);
	if (!config.skipSignatureVerification) {
		const signature = req.headers["x-twilio-signature"] ?? "";
		const publicUrl = config.publicUrl ?? "";
		const authToken = config.twilio?.authToken ?? "";
		if (!publicUrl || !authToken) {
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Server misconfigured: publicUrl and twilio.authToken are required");
			return;
		}
		if (!verifySmsSignature(authToken, publicUrl, params, signature)) {
			res.writeHead(403, { "Content-Type": "text/plain" });
			res.end("Forbidden");
			return;
		}
	}
	const from = params["From"] ?? "";
	const to = params["To"] ?? "";
	if (config.fromNumber && normalizePhoneNumber(to) !== normalizePhoneNumber(config.fromNumber)) {
		res.writeHead(403, { "Content-Type": "text/plain" });
		res.end("Forbidden");
		return;
	}
	if (config.inboundPolicy === "allowlist") {
		if (!isAllowlistedSender(normalizePhoneNumber(from), config.allowFrom)) {
			res.writeHead(403, { "Content-Type": "text/plain" });
			res.end("Forbidden");
			return;
		}
	}
	const msg = {
		from,
		to,
		body: params["Body"] ?? "",
		messageSid: params["MessageSid"] ?? "",
		receivedAt: Date.now()
	};
	res.writeHead(200, { "Content-Type": "text/xml" });
	res.end("<Response/>");
	onMessage(msg);
}
//#endregion
//#region extensions/twilio-sms/src/runtime.ts
const INBOX_MAX = 50;
async function createSmsRuntime(config, agentRuntime, coreConfig, logger) {
	if (!config.skipSignatureVerification && (!config.publicUrl || !config.twilio?.authToken)) throw new Error("twilio-sms requires publicUrl and twilio.authToken when signature verification is enabled");
	const inbox = [];
	const onMessage = (msg) => {
		inbox.push(msg);
		if (inbox.length > INBOX_MAX) inbox.shift();
		const sessionKey = `sms:${normalizePhoneNumber(msg.from)}`;
		logger.info(`[twilio-sms] dispatching message to agent (session=${sessionKey})`);
		dispatchToAgent(msg, sessionKey, agentRuntime, coreConfig, logger).catch((err) => logger.error(`[twilio-sms] agent dispatch failed: ${String(err)}`));
	};
	const server = http.createServer((req, res) => {
		if ((req.url?.split("?")[0] ?? "") !== config.serve.path) {
			res.writeHead(404, { "Content-Type": "text/plain" });
			res.end("Not Found");
			return;
		}
		handleSmsRequest(req, res, {
			config,
			onMessage
		}).catch((err) => {
			logger.error(`[twilio-sms] webhook handler error: ${String(err)}`);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error");
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.listen(config.serve.port, config.serve.bind, resolve);
		server.on("error", reject);
	});
	logger.info(`[twilio-sms] webhook server listening on ${config.serve.bind}:${config.serve.port}${config.serve.path}`);
	return {
		stop: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
		getInbox: () => [...inbox]
	};
}
async function dispatchToAgent(msg, sessionKey, agentRuntime, cfg, logger) {
	const agentId = "main";
	const storePath = agentRuntime.session.resolveStorePath(cfg.session?.store, { agentId });
	const agentDir = agentRuntime.resolveAgentDir(cfg, agentId);
	const workspaceDir = agentRuntime.resolveAgentWorkspaceDir(cfg, agentId);
	await agentRuntime.ensureAgentWorkspace({ dir: workspaceDir });
	const sessionStore = agentRuntime.session.loadSessionStore(storePath);
	const now = Date.now();
	let sessionEntry = sessionStore[sessionKey];
	if (!sessionEntry) {
		sessionEntry = {
			sessionId: crypto.randomUUID(),
			updatedAt: now
		};
		sessionStore[sessionKey] = sessionEntry;
		await agentRuntime.session.saveSessionStore(storePath, sessionStore);
	}
	const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionEntry.sessionId, void 0, { agentId });
	const modelRef = cfg.agents?.defaults?.model?.primary || `${agentRuntime.defaults.provider}/${agentRuntime.defaults.model}`;
	const slashIndex = modelRef.indexOf("/");
	const provider = slashIndex === -1 ? agentRuntime.defaults.provider : modelRef.slice(0, slashIndex);
	const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);
	const thinkLevel = agentRuntime.resolveThinkingDefault({
		cfg,
		provider,
		model
	});
	const agentName = agentRuntime.resolveAgentIdentity(cfg, agentId)?.name?.trim() || "assistant";
	const timeoutMs = agentRuntime.resolveAgentTimeoutMs({ cfg });
	const runId = `sms:${sessionKey}:${Date.now()}`;
	const extraSystemPrompt = `You are ${agentName}. You are receiving an SMS message. The sender's phone number is ${msg.from}. Respond helpfully and concisely.`;
	await agentRuntime.runEmbeddedPiAgent({
		sessionId: sessionEntry.sessionId,
		sessionKey,
		messageProvider: "sms",
		sessionFile,
		workspaceDir,
		config: cfg,
		prompt: `SMS from ${msg.from}: ${msg.body}`,
		provider,
		model,
		thinkLevel,
		verboseLevel: "off",
		timeoutMs,
		runId,
		lane: "sms",
		extraSystemPrompt,
		agentDir
	});
	logger.info(`[twilio-sms] agent run complete (session=${sessionKey})`);
}
//#endregion
//#region extensions/twilio-sms/index.ts
const smsPlugin = {
	id: "twilio-sms",
	name: "Twilio SMS",
	description: "Receive inbound SMS via Twilio and route messages to the OC agent (Phase 1: inbound only)",
	register(api) {
		const config = SmsConfigSchema.parse(resolveSmsConfig(api.pluginConfig ?? {}));
		let runtime = null;
		api.registerService({
			id: "twilio-sms",
			start: async () => {
				runtime = await createSmsRuntime(config, api.runtime.agent, api.config, api.logger);
			},
			stop: async () => {
				await runtime?.stop();
				runtime = null;
			}
		});
		api.registerGatewayMethod("sms.status", ({ respond }) => {
			respond(true, {
				running: !!runtime,
				port: config.serve.port
			});
		});
		api.registerTool({
			name: "sms_inbox",
			label: "SMS Inbox",
			description: "View recent inbound SMS messages received at the configured Twilio number. Returns up to 50 messages.",
			parameters: Type.Object({}),
			async execute(_toolCallId) {
				const messages = runtime?.getInbox() ?? [];
				return {
					content: [{
						type: "text",
						text: JSON.stringify(messages, null, 2)
					}],
					details: { messages }
				};
			}
		});
	}
};
//#endregion
export { smsPlugin as default };
