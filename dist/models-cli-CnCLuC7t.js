import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as formatDocsLink } from "./links-Dz4PCYCN.js";
import { r as theme } from "./theme-CStEj1vt.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { n as runCommandWithRuntime, t as resolveOptionFromCommand } from "./cli-utils-C7ZilvgD.js";
//#region src/cli/models-cli.ts
function runModelsCommand(action) {
	return runCommandWithRuntime(defaultRuntime, action);
}
function rejectAgentScopedModelWrite(command, commandName) {
	if (!resolveOptionFromCommand(command, "agent")) return;
	throw new Error(`openclaw models ${commandName} does not support --agent; it only updates global model defaults. Remove --agent, or run ${formatCliCommand("openclaw agents list")} and set the per-agent model in agent config.`);
}
function registerModelsCli(program) {
	const models = program.command("models").description("Model discovery, scanning, and configuration").option("--status-json", "Output JSON (alias for `models status --json`)", false).option("--status-plain", "Plain output (alias for `models status --plain`)", false).option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR/PI_CODING_AGENT_DIR)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/models", "docs.openclaw.ai/cli/models")}\n`);
	models.command("list").description("List models (configured by default)").option("--all", "Show full model catalog", false).option("--local", "Filter to local models", false).option("--provider <id>", "Filter by provider id").option("--json", "Output JSON", false).option("--plain", "Plain line output", false).action(async (opts) => {
		await runModelsCommand(async () => {
			const { modelsListCommand } = await import("./list.list-command-CppjUD45.js");
			await modelsListCommand(opts, defaultRuntime);
		});
	});
	models.command("status").description("Show configured model state").option("--json", "Output JSON", false).option("--plain", "Plain output", false).option("--check", "Exit non-zero if auth is expiring/expired (1=expired/missing, 2=expiring)", false).option("--probe", "Probe configured provider auth (live)", false).option("--probe-provider <name>", "Only probe a single provider").option("--probe-profile <id>", "Only probe specific auth profile ids (repeat or comma-separated)", (value, previous) => {
		const next = Array.isArray(previous) ? previous : previous ? [previous] : [];
		next.push(value);
		return next;
	}).option("--probe-timeout <ms>", "Per-probe timeout in ms").option("--probe-concurrency <n>", "Concurrent probes").option("--probe-max-tokens <n>", "Probe max tokens (best-effort)").option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR/PI_CODING_AGENT_DIR)").action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? opts.agent;
		await runModelsCommand(async () => {
			const { modelsStatusCommand } = await import("./list.status-command-Buoxqzi2.js");
			await modelsStatusCommand({
				json: Boolean(opts.json),
				plain: Boolean(opts.plain),
				check: Boolean(opts.check),
				probe: Boolean(opts.probe),
				probeProvider: opts.probeProvider,
				probeProfile: opts.probeProfile,
				probeTimeout: opts.probeTimeout,
				probeConcurrency: opts.probeConcurrency,
				probeMaxTokens: opts.probeMaxTokens,
				agent
			}, defaultRuntime);
		});
	});
	models.command("set").description("Set the default model").argument("<model>", "Model id or alias").action(async (model, _opts, command) => {
		rejectAgentScopedModelWrite(command, "set");
		await runModelsCommand(async () => {
			const { modelsSetCommand } = await import("./set-C8OF3nAN.js");
			await modelsSetCommand(model, defaultRuntime);
		});
	});
	models.command("set-image").description("Set the image model").argument("<model>", "Model id or alias").action(async (model, _opts, command) => {
		rejectAgentScopedModelWrite(command, "set-image");
		await runModelsCommand(async () => {
			const { modelsSetImageCommand } = await import("./set-image-CSBoPODN.js");
			await modelsSetImageCommand(model, defaultRuntime);
		});
	});
	const aliases = models.command("aliases").description("Manage model aliases");
	aliases.command("list").description("List model aliases").option("--json", "Output JSON", false).option("--plain", "Plain output", false).action(async (opts) => {
		await runModelsCommand(async () => {
			const { modelsAliasesListCommand } = await import("./aliases-DlOJ1oQ8.js");
			await modelsAliasesListCommand(opts, defaultRuntime);
		});
	});
	aliases.command("add").description("Add or update a model alias").argument("<alias>", "Alias name").argument("<model>", "Model id or alias").action(async (alias, model) => {
		await runModelsCommand(async () => {
			const { modelsAliasesAddCommand } = await import("./aliases-DlOJ1oQ8.js");
			await modelsAliasesAddCommand(alias, model, defaultRuntime);
		});
	});
	aliases.command("remove").description("Remove a model alias").argument("<alias>", "Alias name").action(async (alias) => {
		await runModelsCommand(async () => {
			const { modelsAliasesRemoveCommand } = await import("./aliases-DlOJ1oQ8.js");
			await modelsAliasesRemoveCommand(alias, defaultRuntime);
		});
	});
	const fallbacks = models.command("fallbacks").description("Manage model fallback list");
	fallbacks.command("list").description("List fallback models").option("--json", "Output JSON", false).option("--plain", "Plain output", false).action(async (opts) => {
		await runModelsCommand(async () => {
			const { modelsFallbacksListCommand } = await import("./fallbacks-BhV3m1UP.js");
			await modelsFallbacksListCommand(opts, defaultRuntime);
		});
	});
	fallbacks.command("add").description("Add a fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			const { modelsFallbacksAddCommand } = await import("./fallbacks-BhV3m1UP.js");
			await modelsFallbacksAddCommand(model, defaultRuntime);
		});
	});
	fallbacks.command("remove").description("Remove a fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			const { modelsFallbacksRemoveCommand } = await import("./fallbacks-BhV3m1UP.js");
			await modelsFallbacksRemoveCommand(model, defaultRuntime);
		});
	});
	fallbacks.command("clear").description("Clear all fallback models").action(async () => {
		await runModelsCommand(async () => {
			const { modelsFallbacksClearCommand } = await import("./fallbacks-BhV3m1UP.js");
			await modelsFallbacksClearCommand(defaultRuntime);
		});
	});
	const imageFallbacks = models.command("image-fallbacks").description("Manage image model fallback list");
	imageFallbacks.command("list").description("List image fallback models").option("--json", "Output JSON", false).option("--plain", "Plain output", false).action(async (opts) => {
		await runModelsCommand(async () => {
			const { modelsImageFallbacksListCommand } = await import("./image-fallbacks-DL_lb7uc.js");
			await modelsImageFallbacksListCommand(opts, defaultRuntime);
		});
	});
	imageFallbacks.command("add").description("Add an image fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			const { modelsImageFallbacksAddCommand } = await import("./image-fallbacks-DL_lb7uc.js");
			await modelsImageFallbacksAddCommand(model, defaultRuntime);
		});
	});
	imageFallbacks.command("remove").description("Remove an image fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			const { modelsImageFallbacksRemoveCommand } = await import("./image-fallbacks-DL_lb7uc.js");
			await modelsImageFallbacksRemoveCommand(model, defaultRuntime);
		});
	});
	imageFallbacks.command("clear").description("Clear all image fallback models").action(async () => {
		await runModelsCommand(async () => {
			const { modelsImageFallbacksClearCommand } = await import("./image-fallbacks-DL_lb7uc.js");
			await modelsImageFallbacksClearCommand(defaultRuntime);
		});
	});
	models.command("scan").description("Scan OpenRouter free models for tools + images").option("--min-params <b>", "Minimum parameter size (billions)").option("--max-age-days <days>", "Skip models older than N days").option("--provider <name>", "Filter by provider prefix").option("--max-candidates <n>", "Max fallback candidates", "6").option("--timeout <ms>", "Per-probe timeout in ms").option("--concurrency <n>", "Probe concurrency").option("--no-probe", "Skip live probes; list free candidates only").option("--yes", "Accept defaults without prompting", false).option("--no-input", "Disable prompts (use defaults)").option("--set-default", "Set agents.defaults.model to the first selection", false).option("--set-image", "Set agents.defaults.imageModel to the first image selection", false).option("--json", "Output JSON", false).action(async (opts) => {
		await runModelsCommand(async () => {
			const { modelsScanCommand } = await import("./scan-stAqQVv-.js");
			await modelsScanCommand(opts, defaultRuntime);
		});
	});
	models.action(async (opts) => {
		await runModelsCommand(async () => {
			const { modelsStatusCommand } = await import("./list.status-command-Buoxqzi2.js");
			await modelsStatusCommand({
				json: Boolean(opts?.statusJson),
				plain: Boolean(opts?.statusPlain),
				agent: opts?.agent
			}, defaultRuntime);
		});
	});
	const auth = models.command("auth").description("Manage model auth profiles");
	auth.option("--agent <id>", "Agent id for auth commands");
	auth.action(() => {
		auth.help();
	});
	auth.command("list").description("List saved auth profiles").option("--provider <id>", "Filter by provider id").option("--agent <id>", "Agent id (default: configured default agent)").option("--json", "Output JSON", false).action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? opts.agent;
		await runModelsCommand(async () => {
			const { modelsAuthListCommand } = await import("./auth-list-DM88MyHf.js");
			await modelsAuthListCommand({
				provider: opts.provider,
				agent,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	auth.command("add").description("Interactive auth helper (provider auth or paste token)").action(async (command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? resolveOptionFromCommand(auth, "agent");
		await runModelsCommand(async () => {
			const { modelsAuthAddCommand } = await import("./auth-D1sGUVJ4.js");
			await modelsAuthAddCommand({ agent }, defaultRuntime);
		});
	});
	auth.command("login").description("Run a provider plugin auth flow (OAuth/API key)").option("--provider <id>", "Provider id registered by a plugin").option("--method <id>", "Provider auth method id").option("--set-default", "Apply the provider's default model recommendation", false).action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent");
		await runModelsCommand(async () => {
			const { modelsAuthLoginCommand } = await import("./auth-D1sGUVJ4.js");
			await modelsAuthLoginCommand({
				provider: opts.provider,
				method: opts.method,
				setDefault: Boolean(opts.setDefault),
				agent
			}, defaultRuntime);
		});
	});
	auth.command("setup-token").description("Run a provider CLI to create/sync a token (TTY required)").option("--provider <name>", "Provider id").option("--yes", "Skip confirmation", false).action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent");
		await runModelsCommand(async () => {
			const { modelsAuthSetupTokenCommand } = await import("./auth-D1sGUVJ4.js");
			await modelsAuthSetupTokenCommand({
				provider: opts.provider,
				yes: Boolean(opts.yes),
				agent
			}, defaultRuntime);
		});
	});
	auth.command("paste-token").description("Paste a token into auth-profiles.json and update config").requiredOption("--provider <name>", "Provider id (e.g. anthropic)").option("--profile-id <id>", "Auth profile id (default: <provider>:manual)").option("--expires-in <duration>", "Optional expiry duration (e.g. 365d, 12h). Stored as absolute expiresAt.").action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent");
		await runModelsCommand(async () => {
			const { modelsAuthPasteTokenCommand } = await import("./auth-D1sGUVJ4.js");
			await modelsAuthPasteTokenCommand({
				provider: opts.provider,
				profileId: opts.profileId,
				expiresIn: opts.expiresIn,
				agent
			}, defaultRuntime);
		});
	});
	auth.command("login-github-copilot").description("Login to GitHub Copilot via GitHub device flow (TTY required)").option("--yes", "Overwrite existing profile without prompting", false).action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent");
		await runModelsCommand(async () => {
			const { modelsAuthLoginCommand } = await import("./auth-D1sGUVJ4.js");
			await modelsAuthLoginCommand({
				provider: "github-copilot",
				method: "device",
				yes: Boolean(opts.yes),
				agent
			}, defaultRuntime);
		});
	});
	const order = auth.command("order").description("Manage per-agent auth profile order overrides");
	order.command("get").description("Show per-agent auth order override (from auth-state.json)").requiredOption("--provider <name>", "Provider id (e.g. anthropic)").option("--agent <id>", "Agent id (default: configured default agent)").option("--json", "Output JSON", false).action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? opts.agent;
		await runModelsCommand(async () => {
			const { modelsAuthOrderGetCommand } = await import("./auth-order-DuFQhJQS.js");
			await modelsAuthOrderGetCommand({
				provider: opts.provider,
				agent,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	order.command("set").description("Set per-agent auth order override (writes auth-state.json)").requiredOption("--provider <name>", "Provider id (e.g. anthropic)").option("--agent <id>", "Agent id (default: configured default agent)").argument("<profileIds...>", "Auth profile ids (e.g. anthropic:default)").action(async (profileIds, opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? opts.agent;
		await runModelsCommand(async () => {
			const { modelsAuthOrderSetCommand } = await import("./auth-order-DuFQhJQS.js");
			await modelsAuthOrderSetCommand({
				provider: opts.provider,
				agent,
				order: profileIds
			}, defaultRuntime);
		});
	});
	order.command("clear").description("Clear per-agent auth order override (fall back to config/round-robin)").requiredOption("--provider <name>", "Provider id (e.g. anthropic)").option("--agent <id>", "Agent id (default: configured default agent)").action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? opts.agent;
		await runModelsCommand(async () => {
			const { modelsAuthOrderClearCommand } = await import("./auth-order-DuFQhJQS.js");
			await modelsAuthOrderClearCommand({
				provider: opts.provider,
				agent
			}, defaultRuntime);
		});
	});
}
//#endregion
export { registerModelsCli };
