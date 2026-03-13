import { A as theme, p as defaultRuntime, w as setVerbose } from "./subsystem-DVwhOlEq.js";
import "./paths-BfR2LXbA.js";
import "./boolean-BHdNsbzF.js";
import { G as formatHelpExamples, Jp as GATEWAY_CLIENT_MODES, U as withProgress, Wp as normalizeMessageChannel, Yp as GATEWAY_CLIENT_NAMES, dc as randomIdempotencyKey, lc as callGateway, zg as loadConfig } from "./auth-profiles-CAw5gP6f.js";
import { t as formatCliCommand } from "./command-format-CO3N-oGG.js";
import { r as listAgentIds } from "./agent-scope-DBEC2O3x.js";
import { c as normalizeAgentId } from "./session-key-GuEQvqMH.js";
import "./utils-8QNki08A.js";
import "./boundary-file-read-CcBHg_z-.js";
import "./logger-CDI_b4HB.js";
import "./exec-CHkvLtoM.js";
import "./github-copilot-token-CcBrBN3h.js";
import "./registry-B23eaqdH.js";
import "./skills-D75zdym7.js";
import "./frontmatter-BsxcWDrh.js";
import "./env-overrides-DWoj3eoQ.js";
import "./version-N--ZkDj4.js";
import "./search-manager-B1FsI6Ow.js";
import "./plugins-BKDaOrHv.js";
import "./query-expansion-kdDusy7Q.js";
import "./redact-D9pXgQ9w.js";
import { n as runCommandWithRuntime } from "./cli-utils-Cikq4_a8.js";
import "./fetch-ZNxqGXAR.js";
import "./path-alias-guards-Bq601o2U.js";
import "./delivery-queue-O9EZYTUe.js";
import "./paths-QMxjnO9x.js";
import "./session-cost-usage-6HYiRnfr.js";
import "./prompt-style-2BF77KhS.js";
import { t as formatDocsLink } from "./links-BpBLDDXV.js";
import "./outbound-iUFHHirG.js";
import "./channel-web-Ql-CqtDd.js";
import "./session-C-_NKLAF.js";
import "./login-5iQve08y.js";
import "./provider-env-vars-DW9Ss6dw.js";
import { t as hasExplicitOptions } from "./command-options-Ca7QaJTS.js";
import "./note-8rWqI7pr.js";
import "./clack-prompter-CXacm0PY.js";
import "./config-validation-BOYv73Fk.js";
import "./agents.config--ndKAeXM.js";
import "./enable-4ooqBfl0.js";
import "./install-safe-path-D-MWaGBf.js";
import "./npm-pack-install-_tDKiU0I.js";
import "./skill-scanner-CREeAGqo.js";
import "./installs-CUYjSCwp.js";
import "./plugin-install-plan-BLEKmQ3a.js";
import "./onboard-channels-C7ZWlUyS.js";
import "./auth-choice.apply-helpers-C8fI-9Ep.js";
import "./issue-format-jHeRIpoa.js";
import { t as collectOption } from "./helpers-CMntEmit.js";
import { n as createDefaultDeps } from "./outbound-send-deps-Cf5LU1Bc.js";
import { r as resolveSessionKeyForRequest, t as agentCommand } from "./agent-ZpQQi4fz.js";
import "./provider-auth-helpers-BygHxwmm.js";
import "./logging-4N75Zj7h.js";
import "./openai-codex-oauth-BEsM_Kyw.js";
import "./auth-token-DhmL38FQ.js";
import "./oauth-tls-preflight-_UA74bO6.js";
import "./provider-wizard-D0dlzJPh.js";
import "./auth-choice-options-DERPQpCw.js";
import "./auth-choice-prompt-CUqQs3AP.js";
import "./auth-choice-CklNVwmG.js";
import "./auth-choice.preferred-provider-M6BWK6_E.js";
import "./model-picker-CqMaZ-5Q.js";
import { agentsAddCommand, agentsBindCommand, agentsBindingsCommand, agentsDeleteCommand, agentsListCommand, agentsSetIdentityCommand, agentsUnbindCommand } from "./agents-BN_0N5yM.js";
//#region src/commands/agent-via-gateway.ts
const NO_GATEWAY_TIMEOUT_MS = 2147e6;
function parseTimeoutSeconds(opts) {
	const raw = opts.timeout !== void 0 ? Number.parseInt(String(opts.timeout), 10) : opts.cfg.agents?.defaults?.timeoutSeconds ?? 600;
	if (Number.isNaN(raw) || raw < 0) throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
	return raw;
}
function formatPayloadForLog(payload) {
	const lines = [];
	if (payload.text) lines.push(payload.text.trimEnd());
	const mediaUrl = typeof payload.mediaUrl === "string" && payload.mediaUrl.trim() ? payload.mediaUrl.trim() : void 0;
	const media = payload.mediaUrls ?? (mediaUrl ? [mediaUrl] : []);
	for (const url of media) lines.push(`MEDIA:${url}`);
	return lines.join("\n").trimEnd();
}
async function agentViaGatewayCommand(opts, runtime) {
	const body = (opts.message ?? "").trim();
	if (!body) throw new Error("Message (--message) is required");
	if (!opts.to && !opts.sessionId && !opts.agent) throw new Error("Pass --to <E.164>, --session-id, or --agent to choose a session");
	const cfg = loadConfig();
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
	const idempotencyKey = opts.runId?.trim() || randomIdempotencyKey();
	const response = await withProgress({
		label: "Waiting for agent reply…",
		indeterminate: true,
		enabled: opts.json !== true
	}, async () => await callGateway({
		method: "agent",
		params: {
			message: body,
			agentId,
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
		clientName: GATEWAY_CLIENT_NAMES.CLI,
		mode: GATEWAY_CLIENT_MODES.CLI
	}));
	if (opts.json) {
		runtime.log(JSON.stringify(response, null, 2));
		return response;
	}
	const payloads = (response?.result)?.payloads ?? [];
	if (payloads.length === 0) {
		runtime.log(response?.summary ? String(response.summary) : "No reply from agent.");
		return response;
	}
	for (const payload of payloads) {
		const out = formatPayloadForLog(payload);
		if (out) runtime.log(out);
	}
	return response;
}
async function agentCliCommand(opts, runtime, deps) {
	const localOpts = {
		...opts,
		agentId: opts.agent,
		replyAccountId: opts.replyAccount
	};
	if (opts.local === true) return await agentCommand(localOpts, runtime, deps);
	try {
		return await agentViaGatewayCommand(opts, runtime);
	} catch (err) {
		runtime.error?.(`Gateway agent failed; falling back to embedded: ${String(err)}`);
		return await agentCommand(localOpts, runtime, deps);
	}
}
//#endregion
//#region src/cli/program/register.agent.ts
function registerAgentCommands(program, args) {
	program.command("agent").description("Run an agent turn via the Gateway (use --local for embedded)").requiredOption("-m, --message <text>", "Message body for the agent").option("-t, --to <number>", "Recipient number in E.164 used to derive the session key").option("--session-id <id>", "Use an explicit session id").option("--agent <id>", "Agent id (overrides routing bindings)").option("--thinking <level>", "Thinking level: off | minimal | low | medium | high").option("--verbose <on|off>", "Persist agent verbose level for the session").option("--channel <channel>", `Delivery channel: ${args.agentChannelOptions} (omit to use the main session channel)`).option("--reply-to <target>", "Delivery target override (separate from session routing)").option("--reply-channel <channel>", "Delivery channel override (separate from routing)").option("--reply-account <id>", "Delivery account id override").option("--local", "Run the embedded agent locally (requires model provider API keys in your shell)", false).option("--deliver", "Send the agent's reply back to the selected channel", false).option("--json", "Output result as JSON", false).option("--timeout <seconds>", "Override agent command timeout (seconds, default 600 or config value)").addHelpText("after", () => `
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
		setVerbose((typeof opts.verbose === "string" ? opts.verbose.toLowerCase() : "") === "on");
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
