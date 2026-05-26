import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { t as hasExplicitOptions } from "./command-options-BprOyVpY.js";
import { c as normalizeAgentId } from "./session-key-DFEyR49L.js";
import { n as listAgentIds } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
import { n as defaultRuntime, r as writeRuntimeJson } from "./runtime-DDH_zqCr.js";
import { C as setVerbose } from "./logger-DIiFDaHc.js";
import "./globals-CouSpJO4.js";
import { a as routeLogsToStderr } from "./console-DTusPN3F.js";
import { i as getRuntimeConfig } from "./io-5xE1dPMK.js";
import "./config-CzeRK-GW.js";
import { i as GATEWAY_CLIENT_NAMES, r as GATEWAY_CLIENT_MODES } from "./client-info-CgOISqZp.js";
import { u as normalizeMessageChannel } from "./message-channel-s-A-ruKR.js";
import { t as ADMIN_SCOPE } from "./operator-scopes-CpnZaPqz.js";
import { i as callGateway, l as isGatewayTransportError, u as randomIdempotencyKey } from "./call-DO7ujqcl.js";
import { m as resolveSendableOutboundReplyParts } from "./reply-payload-BOrd8HRU.js";
import { c as resolveSessionKeyForRequest, o as buildExplicitSessionIdSessionKey } from "./model-fallback-CFP2h22a.js";
import { r as withProgress } from "./progress-Cw6xZlhJ.js";
import { n as agentCommand } from "./agent-command-BQgTSh4F.js";
import { n as runCommandWithRuntime } from "./cli-utils-C7ZilvgD.js";
import { t as formatHelpExamples } from "./help-format-C6bIKvbJ.js";
import { t as collectOption } from "./helpers-CSBw61zy.js";
import { t as createDefaultDeps } from "./deps-eRxJcC0K.js";
import "./agent-834cof0Q.js";
import { t as agentsAddCommand } from "./agents.commands.add-u6GD6aHm.js";
import { a as agentsBindingsCommand, i as agentsBindCommand, n as agentsSetIdentityCommand, o as agentsUnbindCommand, r as agentsDeleteCommand, t as agentsListCommand } from "./agents-DgmKX1Jr.js";
import { randomUUID } from "node:crypto";
//#region src/commands/agent-via-gateway.ts
const NO_GATEWAY_TIMEOUT_MS = 2147e6;
const EMBEDDED_FALLBACK_META = {
	transport: "embedded",
	fallbackFrom: "gateway"
};
const GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX = "gateway-fallback-";
function protectJsonStdout(opts) {
	if (opts.json === true) routeLogsToStderr();
}
function parseTimeoutSeconds(opts) {
	const raw = opts.timeout !== void 0 ? Number.parseInt(opts.timeout, 10) : opts.cfg.agents?.defaults?.timeoutSeconds ?? 600;
	if (Number.isNaN(raw) || raw < 0) throw new Error(`Invalid --timeout. Use seconds as a non-negative integer, for example --timeout 600. Use --timeout 0 to disable the timeout.`);
	return raw;
}
function formatPayloadForLog(payload) {
	const parts = resolveSendableOutboundReplyParts({
		text: payload.text,
		mediaUrls: payload.mediaUrls,
		mediaUrl: typeof payload.mediaUrl === "string" ? payload.mediaUrl : void 0
	});
	const lines = [];
	if (parts.text) lines.push(parts.text.trimEnd());
	for (const url of parts.mediaUrls) lines.push(`MEDIA:${url}`);
	return lines.join("\n").trimEnd();
}
function isGatewayAgentTimeoutError(err) {
	if (isGatewayTransportError(err)) return err.kind === "timeout";
	return err instanceof Error && err.message.includes("gateway request timeout for agent");
}
function isGatewayAgentEmbeddedFallbackError(err) {
	return isGatewayTransportError(err);
}
function createGatewayTimeoutFallbackSessionId() {
	return `${GATEWAY_TIMEOUT_FALLBACK_SESSION_PREFIX}${randomUUID()}`;
}
function createGatewayTimeoutFallbackSession(agentId) {
	const sessionId = createGatewayTimeoutFallbackSessionId();
	return {
		sessionId,
		sessionKey: buildExplicitSessionIdSessionKey({
			sessionId,
			agentId
		})
	};
}
function buildGatewayJsonResponse(response) {
	const deliveryStatus = response.result?.deliveryStatus;
	if (deliveryStatus === void 0) return response;
	return {
		...response,
		deliveryStatus
	};
}
async function agentViaGatewayCommand(opts, runtime) {
	protectJsonStdout(opts);
	const body = (opts.message ?? "").trim();
	if (!body) throw new Error(`Missing message. Use ${formatCliCommand("openclaw agent --message \"...\" --agent <id>")} or pass --to/--session-id for an existing conversation.`);
	if (!opts.to && !opts.sessionId && !opts.agent) throw new Error(`No target session selected. Use --agent <id>, --session-id <id>, or --to <E.164>. Run ${formatCliCommand("openclaw agents list")} to see agents.`);
	const cfg = getRuntimeConfig();
	const agentIdRaw = opts.agent?.trim();
	const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : void 0;
	if (agentId) {
		if (!listAgentIds(cfg).includes(agentId)) throw new Error(`Unknown agent id "${agentIdRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`);
	}
	const timeoutSeconds = parseTimeoutSeconds({
		cfg,
		timeout: opts.timeout
	});
	const gatewayTimeoutMs = timeoutSeconds === 0 ? NO_GATEWAY_TIMEOUT_MS : Math.max(1e4, (timeoutSeconds + 30) * 1e3);
	const sessionKey = resolveSessionKeyForRequest({
		cfg,
		agentId,
		to: opts.to,
		sessionId: opts.sessionId
	}).sessionKey;
	const channel = normalizeMessageChannel(opts.channel);
	const idempotencyKey = normalizeOptionalString(opts.runId) || randomIdempotencyKey();
	const modelOverride = normalizeOptionalString(opts.model);
	const hasModelOverride = Boolean(modelOverride);
	const response = await withProgress({
		label: "Waiting for agent reply…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		method: "agent",
		params: {
			message: body,
			agentId,
			model: modelOverride,
			to: opts.to,
			replyTo: opts.replyTo,
			sessionId: opts.sessionId,
			sessionKey,
			thinking: opts.thinking,
			deliver: Boolean(opts.deliver),
			channel,
			replyChannel: opts.replyChannel,
			replyAccountId: opts.replyAccount,
			bestEffortDeliver: opts.bestEffortDeliver,
			timeout: timeoutSeconds,
			lane: opts.lane,
			extraSystemPrompt: opts.extraSystemPrompt,
			idempotencyKey
		},
		expectFinal: true,
		timeoutMs: gatewayTimeoutMs,
		clientName: hasModelOverride ? GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT : GATEWAY_CLIENT_NAMES.CLI,
		mode: hasModelOverride ? GATEWAY_CLIENT_MODES.BACKEND : GATEWAY_CLIENT_MODES.CLI,
		...hasModelOverride ? { scopes: [ADMIN_SCOPE] } : {}
	}));
	if (opts.json) {
		writeRuntimeJson(runtime, buildGatewayJsonResponse(response));
		return response;
	}
	const payloads = (response?.result)?.payloads ?? [];
	if (payloads.length === 0) {
		if (response?.status !== "ok") runtime.log(response?.summary ? response.summary : "No reply from agent.");
		return response;
	}
	for (const payload of payloads) {
		const out = formatPayloadForLog(payload);
		if (out) runtime.log(out);
	}
	return response;
}
async function agentCliCommand(opts, runtime, deps) {
	protectJsonStdout(opts);
	const localOpts = {
		...opts,
		agentId: opts.agent,
		replyAccountId: opts.replyAccount,
		cleanupBundleMcpOnRunEnd: true,
		cleanupCliLiveSessionOnRunEnd: true
	};
	if (opts.local === true) return await agentCommand(localOpts, runtime, deps);
	try {
		return await agentViaGatewayCommand(opts, runtime);
	} catch (err) {
		if (isGatewayAgentTimeoutError(err)) {
			const fallbackSession = createGatewayTimeoutFallbackSession(opts.agent);
			runtime.error?.(`EMBEDDED FALLBACK: Gateway agent timed out; running embedded agent with fresh session ${fallbackSession.sessionId}: ${String(err)}`);
			return await agentCommand({
				...localOpts,
				sessionId: fallbackSession.sessionId,
				sessionKey: fallbackSession.sessionKey,
				runId: fallbackSession.sessionId,
				resultMetaOverrides: {
					...EMBEDDED_FALLBACK_META,
					fallbackReason: "gateway_timeout",
					fallbackSessionId: fallbackSession.sessionId,
					fallbackSessionKey: fallbackSession.sessionKey
				}
			}, runtime, deps);
		}
		if (!isGatewayAgentEmbeddedFallbackError(err)) throw err;
		runtime.error?.(`EMBEDDED FALLBACK: Gateway agent failed; running embedded agent: ${String(err)}`);
		return await agentCommand({
			...localOpts,
			resultMetaOverrides: EMBEDDED_FALLBACK_META
		}, runtime, deps);
	}
}
//#endregion
//#region src/cli/program/register.agent.ts
function registerAgentCommands(program, args) {
	program.command("agent").description("Run an agent turn via the Gateway (use --local for embedded)").requiredOption("-m, --message <text>", "Message body for the agent").option("-t, --to <number>", "Recipient number in E.164 used to derive the session key").option("--session-id <id>", "Use an explicit session id").option("--agent <id>", "Agent id (overrides routing bindings)").option("--model <id>", "Model override for this run (provider/model or model id)").option("--thinking <level>", "Thinking level: off | minimal | low | medium | high | xhigh | adaptive | max where supported").option("--verbose <on|off>", "Persist agent verbose level for the session").option("--channel <channel>", `Delivery channel: ${args.agentChannelOptions} (omit to use the main session channel)`).option("--reply-to <target>", "Delivery target override (separate from session routing)").option("--reply-channel <channel>", "Delivery channel override (separate from routing)").option("--reply-account <id>", "Delivery account id override").option("--local", "Run the embedded agent locally (requires model provider API keys in your shell)", false).option("--deliver", "Send the agent's reply back to the selected channel", false).option("--json", "Output result as JSON", false).option("--timeout <seconds>", "Override agent command timeout (seconds, default 600 or config value)").addHelpText("after", () => `
${theme.heading("Examples:")}
${formatHelpExamples([
		["openclaw agent --to +15555550123 --message \"status update\"", "Start a new session."],
		["openclaw agent --agent ops --message \"Summarize logs\"", "Use a specific agent."],
		["openclaw agent --session-id 1234 --message \"Summarize inbox\" --thinking medium", "Target a session with explicit thinking level."],
		["openclaw agent --to +15555550123 --message \"Trace logs\" --verbose on --json", "Enable verbose logging and JSON output."],
		["openclaw agent --to +15555550123 --message \"Summon reply\" --deliver", "Deliver reply."],
		["openclaw agent --agent ops --message \"Generate report\" --deliver --reply-channel slack --reply-to \"#reports\"", "Send reply to a different channel/target."]
	])}

${theme.muted("Docs:")} ${formatDocsLink("/cli/agent", "docs.openclaw.ai/cli/agent")}`).action(async (opts) => {
		setVerbose((typeof opts.verbose === "string" ? normalizeLowercaseStringOrEmpty(opts.verbose) : "") === "on");
		const deps = createDefaultDeps();
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentCliCommand(opts, defaultRuntime, deps);
		});
	});
	const agents = program.command("agents").description("Manage isolated agents (workspaces + auth + routing)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/agents", "docs.openclaw.ai/cli/agents")}\n`);
	agents.command("list").description("List configured agents").option("--json", "Output JSON instead of text", false).option("--bindings", "Include routing bindings", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentsListCommand({
				json: Boolean(opts.json),
				bindings: Boolean(opts.bindings)
			}, defaultRuntime);
		});
	});
	agents.command("bindings").description("List routing bindings").option("--agent <id>", "Filter by agent id").option("--json", "Output JSON instead of text", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentsBindingsCommand({
				agent: opts.agent,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.command("bind").description("Add routing bindings for an agent").option("--agent <id>", "Agent id (defaults to current default agent)").option("--bind <channel[:accountId]>", "Binding to add (repeatable). If omitted, accountId is resolved by channel defaults/hooks.", collectOption, []).option("--json", "Output JSON summary", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentsBindCommand({
				agent: opts.agent,
				bind: Array.isArray(opts.bind) ? opts.bind : void 0,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.command("unbind").description("Remove routing bindings for an agent").option("--agent <id>", "Agent id (defaults to current default agent)").option("--bind <channel[:accountId]>", "Binding to remove (repeatable)", collectOption, []).option("--all", "Remove all bindings for this agent", false).option("--json", "Output JSON summary", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentsUnbindCommand({
				agent: opts.agent,
				bind: Array.isArray(opts.bind) ? opts.bind : void 0,
				all: Boolean(opts.all),
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.command("add [name]").description("Add a new isolated agent").option("--workspace <dir>", "Workspace directory for the new agent").option("--model <id>", "Model id for this agent").option("--agent-dir <dir>", "Agent state directory for this agent").option("--bind <channel[:accountId]>", "Route channel binding (repeatable)", collectOption, []).option("--non-interactive", "Disable prompts; requires --workspace", false).option("--json", "Output JSON summary", false).action(async (name, opts, command) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			const hasFlags = hasExplicitOptions(command, [
				"workspace",
				"model",
				"agentDir",
				"bind",
				"nonInteractive"
			]);
			await agentsAddCommand({
				name: typeof name === "string" ? name : void 0,
				workspace: opts.workspace,
				model: opts.model,
				agentDir: opts.agentDir,
				bind: Array.isArray(opts.bind) ? opts.bind : void 0,
				nonInteractive: Boolean(opts.nonInteractive),
				json: Boolean(opts.json)
			}, defaultRuntime, { hasFlags });
		});
	});
	agents.command("set-identity").description("Update an agent identity (name/theme/emoji/avatar)").option("--agent <id>", "Agent id to update").option("--workspace <dir>", "Workspace directory used to locate the agent + IDENTITY.md").option("--identity-file <path>", "Explicit IDENTITY.md path to read").option("--from-identity", "Read values from IDENTITY.md", false).option("--name <name>", "Identity name").option("--theme <theme>", "Identity theme").option("--emoji <emoji>", "Identity emoji").option("--avatar <value>", "Identity avatar (workspace path, http(s) URL, or data URI)").option("--json", "Output JSON summary", false).addHelpText("after", () => `
${theme.heading("Examples:")}
${formatHelpExamples([
		["openclaw agents set-identity --agent main --name \"OpenClaw\" --emoji \"🦞\"", "Set name + emoji."],
		["openclaw agents set-identity --agent main --avatar avatars/openclaw.png", "Set avatar path."],
		["openclaw agents set-identity --workspace ~/.openclaw/workspace --from-identity", "Load from IDENTITY.md."],
		["openclaw agents set-identity --identity-file ~/.openclaw/workspace/IDENTITY.md --agent main", "Use a specific IDENTITY.md."]
	])}
`).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentsSetIdentityCommand({
				agent: opts.agent,
				workspace: opts.workspace,
				identityFile: opts.identityFile,
				fromIdentity: Boolean(opts.fromIdentity),
				name: opts.name,
				theme: opts.theme,
				emoji: opts.emoji,
				avatar: opts.avatar,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.command("delete <id>").description("Delete an agent and prune workspace/state").option("--force", "Skip confirmation", false).option("--json", "Output JSON summary", false).action(async (id, opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentsDeleteCommand({
				id: String(id),
				force: Boolean(opts.force),
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.action(async () => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await agentsListCommand({}, defaultRuntime);
		});
	});
}
//#endregion
export { registerAgentCommands };
