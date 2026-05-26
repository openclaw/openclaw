import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { t as hasExplicitOptions } from "./command-options-Dhjl7AMa.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import { t as formatHelpExamples } from "./help-format-DXVAk021.js";
import { t as collectOption } from "./helpers-BNXNWxTW.js";
//#region src/cli/program/register.agent.ts
async function loadAgentCliCommand() {
	return (await import("./agent-via-gateway-rlBlKeho.js")).agentCliCommand;
}
async function loadAgentsAddCommand() {
	return (await import("./agents.commands.add-idxZa6ND.js")).agentsAddCommand;
}
async function loadAgentsBindCommand() {
	return (await import("./agents.commands.bind-Bl3Abj9r.js")).agentsBindCommand;
}
async function loadAgentsBindingsCommand() {
	return (await import("./agents.commands.bind-Bl3Abj9r.js")).agentsBindingsCommand;
}
async function loadAgentsUnbindCommand() {
	return (await import("./agents.commands.bind-Bl3Abj9r.js")).agentsUnbindCommand;
}
async function loadAgentsDeleteCommand() {
	return (await import("./agents.commands.delete-CrUwpQrz.js")).agentsDeleteCommand;
}
async function loadAgentsSetIdentityCommand() {
	return (await import("./agents.commands.identity-BbOMitkQ.js")).agentsSetIdentityCommand;
}
async function loadAgentsListCommand() {
	return (await import("./agents.commands.list-DrQOg5mT.js")).agentsListCommand;
}
async function loadCreateDefaultDeps() {
	return (await import("./deps-DynEVk0q.js")).createDefaultDeps;
}
async function loadSetVerbose() {
	return (await import("./global-state-B4gzUAcU.js")).setVerbose;
}
function registerAgentCommands(program, args) {
	program.command("agent").description("Run an agent turn via the Gateway (use --local for embedded)").requiredOption("-m, --message <text>", "Message body for the agent").option("-t, --to <number>", "Recipient number in E.164 used to derive the session key").option("--session-key <key>", "Explicit session key (agent:<id>:<key>, or scoped to --agent)").option("--session-id <id>", "Use an explicit session id").option("--agent <id>", "Agent id (overrides routing bindings)").option("--model <id>", "Model override for this run (provider/model or model id)").option("--thinking <level>", "Thinking level: off | minimal | low | medium | high | xhigh | adaptive | max where supported").option("--verbose <on|off>", "Persist agent verbose level for the session").option("--channel <channel>", `Delivery channel: ${args.agentChannelOptions} (omit to use the main session channel)`).option("--reply-to <target>", "Delivery target override (separate from session routing)").option("--reply-channel <channel>", "Delivery channel override (separate from routing)").option("--reply-account <id>", "Delivery account id override").option("--local", "Run the embedded agent locally (requires model provider API keys in your shell)", false).option("--deliver", "Send the agent's reply back to the selected channel", false).option("--json", "Output result as JSON", false).option("--timeout <seconds>", "Override agent command timeout (seconds, default 600 or config value)").addHelpText("after", () => `
${theme.heading("Examples:")}
${formatHelpExamples([
		["openclaw agent --to +15555550123 --message \"status update\"", "Start a new session."],
		["openclaw agent --agent ops --message \"Summarize logs\"", "Use a specific agent."],
		["openclaw agent --session-key agent:ops:incident-42 --message \"Summarize status\"", "Target an exact session key."],
		["openclaw agent --session-id 1234 --message \"Summarize inbox\" --thinking medium", "Target a session with explicit thinking level."],
		["openclaw agent --to +15555550123 --message \"Trace logs\" --verbose on --json", "Enable verbose logging and JSON output."],
		["openclaw agent --to +15555550123 --message \"Summon reply\" --deliver", "Deliver reply."],
		["openclaw agent --agent ops --message \"Generate report\" --deliver --reply-channel slack --reply-to \"#reports\"", "Send reply to a different channel/target."]
	])}

${theme.muted("Docs:")} ${formatDocsLink("/cli/agent", "docs.openclaw.ai/cli/agent")}`).action(async (opts) => {
		const verboseLevel = typeof opts.verbose === "string" ? normalizeLowercaseStringOrEmpty(opts.verbose) : "";
		await runCommandWithRuntime(defaultRuntime, async () => {
			(await loadSetVerbose())(verboseLevel === "on");
			const deps = (await loadCreateDefaultDeps())();
			await (await loadAgentCliCommand())(opts, defaultRuntime, deps);
		});
	});
	const agents = program.command("agents").description("Manage isolated agents (workspaces + auth + routing)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/agents", "docs.openclaw.ai/cli/agents")}\n`);
	agents.command("list").description("List configured agents").option("--json", "Output JSON instead of text", false).option("--bindings", "Include routing bindings", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await (await loadAgentsListCommand())({
				json: Boolean(opts.json),
				bindings: Boolean(opts.bindings)
			}, defaultRuntime);
		});
	});
	agents.command("bindings").description("List routing bindings").option("--agent <id>", "Filter by agent id").option("--json", "Output JSON instead of text", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await (await loadAgentsBindingsCommand())({
				agent: opts.agent,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.command("bind").description("Add routing bindings for an agent").option("--agent <id>", "Agent id (defaults to current default agent)").option("--bind <channel[:accountId]>", "Binding to add (repeatable). If omitted, accountId is resolved by channel defaults/hooks.", collectOption, []).option("--json", "Output JSON summary", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await (await loadAgentsBindCommand())({
				agent: opts.agent,
				bind: Array.isArray(opts.bind) ? opts.bind : void 0,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.command("unbind").description("Remove routing bindings for an agent").option("--agent <id>", "Agent id (defaults to current default agent)").option("--bind <channel[:accountId]>", "Binding to remove (repeatable)", collectOption, []).option("--all", "Remove all bindings for this agent", false).option("--json", "Output JSON summary", false).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await (await loadAgentsUnbindCommand())({
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
			await (await loadAgentsAddCommand())({
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
			await (await loadAgentsSetIdentityCommand())({
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
			await (await loadAgentsDeleteCommand())({
				id: String(id),
				force: Boolean(opts.force),
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	agents.action(async () => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await (await loadAgentsListCommand())({}, defaultRuntime);
		});
	});
}
//#endregion
export { registerAgentCommands };
