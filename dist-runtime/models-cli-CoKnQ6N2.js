import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import { r as theme } from "./theme-UkqnBJaj.js";
import { l as defaultRuntime } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import { n as runCommandWithRuntime, t as resolveOptionFromCommand } from "./cli-utils-DRykF2zj.js";
import "./issue-format-B2YddtHw.js";
import "./table-BFTFgs1v.js";
import "./shared-Sjx2CiAv.js";
import "./onboard-auth-0RfaRoQs.js";
import "./logging-DySkJB06.js";
import { C as modelsAliasesRemoveCommand, S as modelsAliasesListCommand, _ as modelsAuthAddCommand, a as modelsListCommand, b as modelsAuthSetupTokenCommand, c as modelsImageFallbacksListCommand, d as modelsFallbacksClearCommand, f as modelsFallbacksListCommand, g as modelsAuthOrderSetCommand, h as modelsAuthOrderGetCommand, i as modelsStatusCommand, l as modelsImageFallbacksRemoveCommand, m as modelsAuthOrderClearCommand, n as modelsSetCommand, o as modelsImageFallbacksAddCommand, p as modelsFallbacksRemoveCommand, r as modelsScanCommand, s as modelsImageFallbacksClearCommand, t as modelsSetImageCommand, u as modelsFallbacksAddCommand, v as modelsAuthLoginCommand, x as modelsAliasesAddCommand, y as modelsAuthPasteTokenCommand } from "./models-CeVDCXem.js";
import "./note-DjpUEsPR.js";
import "./clack-prompter-BaCJN1xb.js";
import "./provider-auth-helpers-DMtxsQKd.js";
import "./provider-auth-guidance-G2xaBDs-.js";
//#region src/cli/models-cli.ts
function runModelsCommand(action) {
	return runCommandWithRuntime(defaultRuntime, action);
}
function registerModelsCli(program) {
	const models = program.command("models").description("Model discovery, scanning, and configuration").option("--status-json", "Output JSON (alias for `models status --json`)", false).option("--status-plain", "Plain output (alias for `models status --plain`)", false).option("--agent <id>", "Agent id to inspect (overrides OPENCLAW_AGENT_DIR/PI_CODING_AGENT_DIR)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/models", "docs.openclaw.ai/cli/models")}\n`);
	models.command("list").description("List models (configured by default)").option("--all", "Show full model catalog", false).option("--local", "Filter to local models", false).option("--provider <name>", "Filter by provider").option("--json", "Output JSON", false).option("--plain", "Plain line output", false).action(async (opts) => {
		await runModelsCommand(async () => {
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
	models.command("set").description("Set the default model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			await modelsSetCommand(model, defaultRuntime);
		});
	});
	models.command("set-image").description("Set the image model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			await modelsSetImageCommand(model, defaultRuntime);
		});
	});
	const aliases = models.command("aliases").description("Manage model aliases");
	aliases.command("list").description("List model aliases").option("--json", "Output JSON", false).option("--plain", "Plain output", false).action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsAliasesListCommand(opts, defaultRuntime);
		});
	});
	aliases.command("add").description("Add or update a model alias").argument("<alias>", "Alias name").argument("<model>", "Model id or alias").action(async (alias, model) => {
		await runModelsCommand(async () => {
			await modelsAliasesAddCommand(alias, model, defaultRuntime);
		});
	});
	aliases.command("remove").description("Remove a model alias").argument("<alias>", "Alias name").action(async (alias) => {
		await runModelsCommand(async () => {
			await modelsAliasesRemoveCommand(alias, defaultRuntime);
		});
	});
	const fallbacks = models.command("fallbacks").description("Manage model fallback list");
	fallbacks.command("list").description("List fallback models").option("--json", "Output JSON", false).option("--plain", "Plain output", false).action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsFallbacksListCommand(opts, defaultRuntime);
		});
	});
	fallbacks.command("add").description("Add a fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			await modelsFallbacksAddCommand(model, defaultRuntime);
		});
	});
	fallbacks.command("remove").description("Remove a fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			await modelsFallbacksRemoveCommand(model, defaultRuntime);
		});
	});
	fallbacks.command("clear").description("Clear all fallback models").action(async () => {
		await runModelsCommand(async () => {
			await modelsFallbacksClearCommand(defaultRuntime);
		});
	});
	const imageFallbacks = models.command("image-fallbacks").description("Manage image model fallback list");
	imageFallbacks.command("list").description("List image fallback models").option("--json", "Output JSON", false).option("--plain", "Plain output", false).action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsImageFallbacksListCommand(opts, defaultRuntime);
		});
	});
	imageFallbacks.command("add").description("Add an image fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			await modelsImageFallbacksAddCommand(model, defaultRuntime);
		});
	});
	imageFallbacks.command("remove").description("Remove an image fallback model").argument("<model>", "Model id or alias").action(async (model) => {
		await runModelsCommand(async () => {
			await modelsImageFallbacksRemoveCommand(model, defaultRuntime);
		});
	});
	imageFallbacks.command("clear").description("Clear all image fallback models").action(async () => {
		await runModelsCommand(async () => {
			await modelsImageFallbacksClearCommand(defaultRuntime);
		});
	});
	models.command("scan").description("Scan OpenRouter free models for tools + images").option("--min-params <b>", "Minimum parameter size (billions)").option("--max-age-days <days>", "Skip models older than N days").option("--provider <name>", "Filter by provider prefix").option("--max-candidates <n>", "Max fallback candidates", "6").option("--timeout <ms>", "Per-probe timeout in ms").option("--concurrency <n>", "Probe concurrency").option("--no-probe", "Skip live probes; list free candidates only").option("--yes", "Accept defaults without prompting", false).option("--no-input", "Disable prompts (use defaults)").option("--set-default", "Set agents.defaults.model to the first selection", false).option("--set-image", "Set agents.defaults.imageModel to the first image selection", false).option("--json", "Output JSON", false).action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsScanCommand(opts, defaultRuntime);
		});
	});
	models.action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsStatusCommand({
				json: Boolean(opts?.statusJson),
				plain: Boolean(opts?.statusPlain),
				agent: opts?.agent
			}, defaultRuntime);
		});
	});
	const auth = models.command("auth").description("Manage model auth profiles");
	auth.option("--agent <id>", "Agent id for auth order get/set/clear");
	auth.action(() => {
		auth.help();
	});
	auth.command("add").description("Interactive auth helper (setup-token or paste token)").action(async () => {
		await runModelsCommand(async () => {
			await modelsAuthAddCommand({}, defaultRuntime);
		});
	});
	auth.command("login").description("Run a provider plugin auth flow (OAuth/API key)").option("--provider <id>", "Provider id registered by a plugin").option("--method <id>", "Provider auth method id").option("--set-default", "Apply the provider's default model recommendation", false).action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsAuthLoginCommand({
				provider: opts.provider,
				method: opts.method,
				setDefault: Boolean(opts.setDefault)
			}, defaultRuntime);
		});
	});
	auth.command("setup-token").description("Run a provider CLI to create/sync a token (TTY required)").option("--provider <name>", "Provider id (default: anthropic)").option("--yes", "Skip confirmation", false).action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsAuthSetupTokenCommand({
				provider: opts.provider,
				yes: Boolean(opts.yes)
			}, defaultRuntime);
		});
	});
	auth.command("paste-token").description("Paste a token into auth-profiles.json and update config").requiredOption("--provider <name>", "Provider id (e.g. anthropic)").option("--profile-id <id>", "Auth profile id (default: <provider>:manual)").option("--expires-in <duration>", "Optional expiry duration (e.g. 365d, 12h). Stored as absolute expiresAt.").action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsAuthPasteTokenCommand({
				provider: opts.provider,
				profileId: opts.profileId,
				expiresIn: opts.expiresIn
			}, defaultRuntime);
		});
	});
	auth.command("login-github-copilot").description("Login to GitHub Copilot via GitHub device flow (TTY required)").option("--yes", "Overwrite existing profile without prompting", false).action(async (opts) => {
		await runModelsCommand(async () => {
			await modelsAuthLoginCommand({
				provider: "github-copilot",
				method: "device",
				yes: Boolean(opts.yes)
			}, defaultRuntime);
		});
	});
	const order = auth.command("order").description("Manage per-agent auth profile order overrides");
	order.command("get").description("Show per-agent auth order override (from auth-profiles.json)").requiredOption("--provider <name>", "Provider id (e.g. anthropic)").option("--agent <id>", "Agent id (default: configured default agent)").option("--json", "Output JSON", false).action(async (opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? opts.agent;
		await runModelsCommand(async () => {
			await modelsAuthOrderGetCommand({
				provider: opts.provider,
				agent,
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
	order.command("set").description("Set per-agent auth order override (locks rotation to this list)").requiredOption("--provider <name>", "Provider id (e.g. anthropic)").option("--agent <id>", "Agent id (default: configured default agent)").argument("<profileIds...>", "Auth profile ids (e.g. anthropic:default)").action(async (profileIds, opts, command) => {
		const agent = resolveOptionFromCommand(command, "agent") ?? opts.agent;
		await runModelsCommand(async () => {
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
			await modelsAuthOrderClearCommand({
				provider: opts.provider,
				agent
			}, defaultRuntime);
		});
	});
}
//#endregion
export { registerModelsCli };
