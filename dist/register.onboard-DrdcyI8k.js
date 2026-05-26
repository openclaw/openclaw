import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import { a as resolveManifestProviderOnboardAuthFlags } from "./provider-auth-choices-BFWeF5vS.js";
import { r as formatAuthChoiceChoicesForCli } from "./auth-choice-options-DBrbPlbn.js";
import { t as CORE_ONBOARD_AUTH_FLAGS } from "./onboard-core-auth-flags-CINE1eGu.js";
//#region src/cli/program/register.onboard.ts
function resolveInstallDaemonFlag(command, opts) {
	if (!command || typeof command !== "object") return;
	const getOptionValueSource = "getOptionValueSource" in command ? command.getOptionValueSource : void 0;
	if (typeof getOptionValueSource !== "function") return;
	if (getOptionValueSource.call(command, "skipDaemon") === "cli") return false;
	if (getOptionValueSource.call(command, "installDaemon") === "cli") return Boolean(opts.installDaemon);
}
const AUTH_CHOICE_HELP = formatAuthChoiceChoicesForCli({
	includeLegacyAliases: true,
	includeSkip: true
});
function extractCliFlags(cliOption) {
	return cliOption.split(/[ ,|]+/).filter((part) => part.startsWith("-")).map((part) => {
		const equalsIndex = part.indexOf("=");
		return equalsIndex === -1 ? part : part.slice(0, equalsIndex);
	});
}
function resolveOnboardAuthFlags() {
	const seenCliFlags = /* @__PURE__ */ new Set();
	const flags = [];
	for (const flag of [...CORE_ONBOARD_AUTH_FLAGS, ...resolveManifestProviderOnboardAuthFlags()]) {
		const cliFlags = extractCliFlags(flag.cliOption);
		if (cliFlags.some((cliFlag) => seenCliFlags.has(cliFlag))) continue;
		for (const cliFlag of cliFlags) seenCliFlags.add(cliFlag);
		flags.push(flag);
	}
	return flags;
}
const ONBOARD_AUTH_FLAGS = resolveOnboardAuthFlags();
function pickOnboardProviderAuthOptionValues(opts) {
	return Object.fromEntries(ONBOARD_AUTH_FLAGS.map((flag) => [flag.optionKey, opts[flag.optionKey]]));
}
function registerOnboardCommand(program) {
	const command = program.command("onboard").description("Guided setup for auth, models, Gateway, workspace, channels, and skills").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/onboard", "docs.openclaw.ai/cli/onboard")}\n`).option("--workspace <dir>", "Agent workspace directory (default: ~/.openclaw/workspace)").option("--reset", "Reset config + credentials + sessions before running onboard (workspace only with --reset-scope full)").option("--reset-scope <scope>", "Reset scope: config|config+creds+sessions|full").option("--non-interactive", "Run without prompts", false).option("--modern", "Use the conversational setup/repair assistant", false).option("--accept-risk", "Acknowledge that agents are powerful and full system access is risky (required for --non-interactive)", false).option("--flow <flow>", "Onboard flow: quickstart|advanced|manual|import").option("--mode <mode>", "Onboard mode: local|remote").option("--auth-choice <choice>", `Auth: ${AUTH_CHOICE_HELP}`).option("--token-provider <id>", "Token provider id (non-interactive; used with --auth-choice token)").option("--token <token>", "Token value (non-interactive; used with --auth-choice token)").option("--token-profile-id <id>", "Auth profile id (non-interactive; default: <provider>:manual)").option("--token-expires-in <duration>", "Optional token expiry duration (e.g. 365d, 12h)").option("--secret-input-mode <mode>", "API key persistence mode: plaintext|ref (default: plaintext)").option("--cloudflare-ai-gateway-account-id <id>", "Cloudflare Account ID").option("--cloudflare-ai-gateway-gateway-id <id>", "Cloudflare AI Gateway ID");
	for (const providerFlag of ONBOARD_AUTH_FLAGS) command.option(providerFlag.cliOption, providerFlag.description);
	command.option("--custom-base-url <url>", "Custom provider base URL").option("--custom-api-key <key>", "Custom provider API key (optional)").option("--custom-model-id <id>", "Custom provider model ID").option("--custom-provider-id <id>", "Custom provider ID (optional; auto-derived by default)").option("--custom-compatibility <mode>", "Custom provider API compatibility: openai|anthropic (default: openai)").option("--custom-image-input", "Mark the custom provider model as image-capable").option("--custom-text-input", "Mark the custom provider model as text-only").option("--gateway-port <port>", "Gateway port").option("--gateway-bind <mode>", "Gateway bind: loopback|tailnet|lan|auto|custom").option("--gateway-auth <mode>", "Gateway auth: token|password").option("--gateway-token <token>", "Gateway token (token auth)").option("--gateway-token-ref-env <name>", "Gateway token SecretRef env var name (token auth; e.g. OPENCLAW_GATEWAY_TOKEN)").option("--gateway-password <password>", "Gateway password (password auth)").option("--remote-url <url>", "Remote Gateway WebSocket URL").option("--remote-token <token>", "Remote Gateway token (optional)").option("--tailscale <mode>", "Tailscale: off|serve|funnel").option("--tailscale-reset-on-exit", "Reset tailscale serve/funnel on exit").option("--install-daemon", "Install gateway service").option("--no-install-daemon", "Skip gateway service install").option("--skip-daemon", "Skip gateway service install").option("--daemon-runtime <runtime>", "Daemon runtime: node|bun").option("--skip-channels", "Skip channel setup").option("--skip-skills", "Skip skills setup").option("--skip-bootstrap", "Skip creating default agent workspace files").option("--skip-search", "Skip search provider setup").option("--skip-health", "Skip health check").option("--skip-ui", "Skip Control UI/TUI prompts").option("--suppress-gateway-token-output", "Suppress token-bearing Gateway/UI output").option("--skip-hooks", "Skip hook setup").option("--node-manager <name>", "Node manager for skills: npm|pnpm|bun").option("--import-from <provider>", "Migration provider to run during onboarding").option("--import-source <path>", "Source agent home for --import-from").option("--import-secrets", "Import supported secrets during onboarding migration", false).option("--json", "Output JSON summary", false);
	command.action(async (opts, commandRuntime) => {
		const { defaultRuntime } = await import("./runtime-DRhjCMq8.js");
		await runCommandWithRuntime(defaultRuntime, async () => {
			if (opts.modern) {
				const { runCrestodian } = await import("./crestodian/crestodian.js");
				await runCrestodian({
					message: opts.nonInteractive ? "overview" : void 0,
					yes: false,
					json: Boolean(opts.json),
					interactive: !opts.nonInteractive
				});
				return;
			}
			const installDaemon = resolveInstallDaemonFlag(commandRuntime, { installDaemon: Boolean(opts.installDaemon) });
			const gatewayPort = typeof opts.gatewayPort === "string" ? Number.parseInt(opts.gatewayPort, 10) : void 0;
			const providerAuthOptionValues = pickOnboardProviderAuthOptionValues(opts);
			const { setupWizardCommand } = await import("./onboard-CePsejdX.js");
			await setupWizardCommand({
				workspace: opts.workspace,
				nonInteractive: Boolean(opts.nonInteractive),
				acceptRisk: Boolean(opts.acceptRisk),
				flow: opts.flow,
				mode: opts.mode,
				authChoice: opts.authChoice,
				tokenProvider: opts.tokenProvider,
				token: opts.token,
				tokenProfileId: opts.tokenProfileId,
				tokenExpiresIn: opts.tokenExpiresIn,
				secretInputMode: opts.secretInputMode,
				...providerAuthOptionValues,
				cloudflareAiGatewayAccountId: opts.cloudflareAiGatewayAccountId,
				cloudflareAiGatewayGatewayId: opts.cloudflareAiGatewayGatewayId,
				customBaseUrl: opts.customBaseUrl,
				customApiKey: opts.customApiKey,
				customModelId: opts.customModelId,
				customProviderId: opts.customProviderId,
				customCompatibility: opts.customCompatibility,
				customImageInput: opts.customTextInput === true ? false : opts.customImageInput === true ? true : void 0,
				gatewayPort: typeof gatewayPort === "number" && Number.isFinite(gatewayPort) ? gatewayPort : void 0,
				gatewayBind: opts.gatewayBind,
				gatewayAuth: opts.gatewayAuth,
				gatewayToken: opts.gatewayToken,
				gatewayTokenRefEnv: opts.gatewayTokenRefEnv,
				gatewayPassword: opts.gatewayPassword,
				remoteUrl: opts.remoteUrl,
				remoteToken: opts.remoteToken,
				tailscale: opts.tailscale,
				tailscaleResetOnExit: Boolean(opts.tailscaleResetOnExit),
				reset: Boolean(opts.reset),
				resetScope: opts.resetScope,
				installDaemon,
				daemonRuntime: opts.daemonRuntime,
				skipChannels: Boolean(opts.skipChannels),
				skipSkills: Boolean(opts.skipSkills),
				skipBootstrap: Boolean(opts.skipBootstrap),
				skipSearch: Boolean(opts.skipSearch),
				skipHealth: Boolean(opts.skipHealth),
				skipUi: Boolean(opts.skipUi),
				suppressGatewayTokenOutput: Boolean(opts.suppressGatewayTokenOutput),
				skipHooks: Boolean(opts.skipHooks),
				nodeManager: opts.nodeManager,
				importFrom: opts.importFrom,
				importSource: opts.importSource,
				importSecrets: Boolean(opts.importSecrets),
				json: Boolean(opts.json)
			}, defaultRuntime);
		});
	});
}
//#endregion
export { registerOnboardCommand };
