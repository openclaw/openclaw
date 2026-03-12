import { J as displayPath, Ot as theme, Rt as CONFIG_PATH, gt as danger, qt as resolveGatewayPort, v as defaultRuntime } from "./entry.js";
import { L as writeConfigFile, N as readConfigFileSnapshot, R as validateConfigObjectWithPlugins, j as loadConfig } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import "./agent-scope-C2k6BQnt.js";
import "./openclaw-root-C9tYgTzw.js";
import { t as runCommandWithTimeout } from "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import "./host-env-security-BM8ktVlo.js";
import "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import "./frontmatter-DzgKaILZ.js";
import "./skills-DOryi61N.js";
import "./path-alias-guards-BpvAiXds.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import { C as normalizeServePath, S as normalizeHooksPath, T as resolveGmailHookRuntimeConfig, _ as buildGogWatchServeArgs, a as ensureTopic, b as generateHookToken, c as DEFAULT_GMAIL_LABEL, d as DEFAULT_GMAIL_SERVE_BIND, f as DEFAULT_GMAIL_SERVE_PATH, g as buildDefaultHookUrl, h as DEFAULT_GMAIL_TOPIC, i as ensureTailscaleEndpoint, l as DEFAULT_GMAIL_MAX_BYTES, m as DEFAULT_GMAIL_SUBSCRIPTION, n as ensureGcloudAuth, o as resolveProjectIdFromGogCredentials, p as DEFAULT_GMAIL_SERVE_PORT, r as ensureSubscription, s as runGcloud, t as ensureDependency, u as DEFAULT_GMAIL_RENEW_MINUTES, v as buildGogWatchStartArgs, w as parseTopicPath, x as mergeHookPresets, y as buildTopicPath } from "./gmail-setup-utils-BvUMfUSA.js";
import { spawn } from "node:child_process";

//#region src/hooks/gmail-ops.ts
const DEFAULT_GMAIL_TOPIC_IAM_MEMBER = "serviceAccount:gmail-api-push@system.gserviceaccount.com";
async function runGmailSetup(opts) {
	await ensureDependency("gcloud", ["--cask", "gcloud-cli"]);
	await ensureDependency("gog", ["gogcli"]);
	if (opts.tailscale !== "off" && !opts.pushEndpoint) await ensureDependency("tailscale", ["tailscale"]);
	await ensureGcloudAuth();
	const configSnapshot = await readConfigFileSnapshot();
	if (!configSnapshot.valid) throw new Error(`Config invalid: ${CONFIG_PATH}`);
	const baseConfig = configSnapshot.config;
	const hooksPath = normalizeHooksPath(baseConfig.hooks?.path);
	const hookToken = opts.hookToken ?? baseConfig.hooks?.token ?? generateHookToken();
	const pushToken = opts.pushToken ?? baseConfig.hooks?.gmail?.pushToken ?? generateHookToken();
	const topicInput = opts.topic ?? baseConfig.hooks?.gmail?.topic ?? DEFAULT_GMAIL_TOPIC;
	const parsedTopic = parseTopicPath(topicInput);
	const topicName = parsedTopic?.topicName ?? topicInput;
	const projectId = opts.project ?? parsedTopic?.projectId ?? await resolveProjectIdFromGogCredentials();
	if (!projectId) throw new Error("GCP project id required (use --project or ensure gog credentials are available)");
	const topicPath = buildTopicPath(projectId, topicName);
	const subscription = opts.subscription ?? DEFAULT_GMAIL_SUBSCRIPTION;
	const label = opts.label ?? DEFAULT_GMAIL_LABEL;
	const hookUrl = opts.hookUrl ?? baseConfig.hooks?.gmail?.hookUrl ?? buildDefaultHookUrl(hooksPath, resolveGatewayPort(baseConfig));
	const serveBind = opts.bind ?? DEFAULT_GMAIL_SERVE_BIND;
	const servePort = opts.port ?? DEFAULT_GMAIL_SERVE_PORT;
	const configuredServePath = opts.path ?? baseConfig.hooks?.gmail?.serve?.path;
	const configuredTailscaleTarget = opts.tailscaleTarget ?? baseConfig.hooks?.gmail?.tailscale?.target;
	const normalizedServePath = typeof configuredServePath === "string" && configuredServePath.trim().length > 0 ? normalizeServePath(configuredServePath) : DEFAULT_GMAIL_SERVE_PATH;
	const normalizedTailscaleTarget = typeof configuredTailscaleTarget === "string" && configuredTailscaleTarget.trim().length > 0 ? configuredTailscaleTarget.trim() : void 0;
	const includeBody = opts.includeBody ?? true;
	const maxBytes = opts.maxBytes ?? DEFAULT_GMAIL_MAX_BYTES;
	const renewEveryMinutes = opts.renewEveryMinutes ?? DEFAULT_GMAIL_RENEW_MINUTES;
	const tailscaleMode = opts.tailscale ?? "funnel";
	const servePath = normalizeServePath(tailscaleMode !== "off" && !normalizedTailscaleTarget ? "/" : normalizedServePath);
	const tailscalePath = normalizeServePath(opts.tailscalePath ?? baseConfig.hooks?.gmail?.tailscale?.path ?? (tailscaleMode !== "off" ? normalizedServePath : servePath));
	await runGcloud([
		"config",
		"set",
		"project",
		projectId,
		"--quiet"
	]);
	await runGcloud([
		"services",
		"enable",
		"gmail.googleapis.com",
		"pubsub.googleapis.com",
		"--project",
		projectId,
		"--quiet"
	]);
	await ensureTopic(projectId, topicName);
	await runGcloud([
		"pubsub",
		"topics",
		"add-iam-policy-binding",
		topicName,
		"--project",
		projectId,
		"--member",
		DEFAULT_GMAIL_TOPIC_IAM_MEMBER,
		"--role",
		"roles/pubsub.publisher",
		"--quiet"
	]);
	const pushEndpoint = opts.pushEndpoint ? opts.pushEndpoint : await ensureTailscaleEndpoint({
		mode: tailscaleMode,
		path: tailscalePath,
		port: servePort,
		target: normalizedTailscaleTarget,
		token: pushToken
	});
	if (!pushEndpoint) throw new Error("push endpoint required (set --push-endpoint)");
	await ensureSubscription(projectId, subscription, topicName, pushEndpoint);
	await startGmailWatch({
		account: opts.account,
		label,
		topic: topicPath
	}, true);
	const validated = validateConfigObjectWithPlugins({
		...baseConfig,
		hooks: {
			...baseConfig.hooks,
			enabled: true,
			path: hooksPath,
			token: hookToken,
			presets: mergeHookPresets(baseConfig.hooks?.presets, "gmail"),
			gmail: {
				...baseConfig.hooks?.gmail,
				account: opts.account,
				label,
				topic: topicPath,
				subscription,
				pushToken,
				hookUrl,
				includeBody,
				maxBytes,
				renewEveryMinutes,
				serve: {
					...baseConfig.hooks?.gmail?.serve,
					bind: serveBind,
					port: servePort,
					path: servePath
				},
				tailscale: {
					...baseConfig.hooks?.gmail?.tailscale,
					mode: tailscaleMode,
					path: tailscalePath,
					target: normalizedTailscaleTarget
				}
			}
		}
	});
	if (!validated.ok) throw new Error(`Config validation failed: ${validated.issues[0]?.message ?? "invalid"}`);
	await writeConfigFile(validated.config);
	const summary = {
		projectId,
		topic: topicPath,
		subscription,
		pushEndpoint,
		hookUrl,
		hookToken,
		pushToken,
		serve: {
			bind: serveBind,
			port: servePort,
			path: servePath
		}
	};
	if (opts.json) {
		defaultRuntime.log(JSON.stringify(summary, null, 2));
		return;
	}
	defaultRuntime.log("Gmail hooks configured:");
	defaultRuntime.log(`- project: ${projectId}`);
	defaultRuntime.log(`- topic: ${topicPath}`);
	defaultRuntime.log(`- subscription: ${subscription}`);
	defaultRuntime.log(`- push endpoint: ${pushEndpoint}`);
	defaultRuntime.log(`- hook url: ${hookUrl}`);
	defaultRuntime.log(`- config: ${displayPath(CONFIG_PATH)}`);
	defaultRuntime.log(`Next: ${formatCliCommand("openclaw webhooks gmail run")}`);
}
async function runGmailService(opts) {
	await ensureDependency("gog", ["gogcli"]);
	const resolved = resolveGmailHookRuntimeConfig(loadConfig(), {
		account: opts.account,
		topic: opts.topic,
		subscription: opts.subscription,
		label: opts.label,
		hookToken: opts.hookToken,
		pushToken: opts.pushToken,
		hookUrl: opts.hookUrl,
		serveBind: opts.bind,
		servePort: opts.port,
		servePath: opts.path,
		includeBody: opts.includeBody,
		maxBytes: opts.maxBytes,
		renewEveryMinutes: opts.renewEveryMinutes,
		tailscaleMode: opts.tailscale,
		tailscalePath: opts.tailscalePath,
		tailscaleTarget: opts.tailscaleTarget
	});
	if (!resolved.ok) throw new Error(resolved.error);
	const runtimeConfig = resolved.value;
	if (runtimeConfig.tailscale.mode !== "off") {
		await ensureDependency("tailscale", ["tailscale"]);
		await ensureTailscaleEndpoint({
			mode: runtimeConfig.tailscale.mode,
			path: runtimeConfig.tailscale.path,
			port: runtimeConfig.serve.port,
			target: runtimeConfig.tailscale.target
		});
	}
	await startGmailWatch(runtimeConfig);
	let shuttingDown = false;
	let child = spawnGogServe(runtimeConfig);
	const renewMs = runtimeConfig.renewEveryMinutes * 6e4;
	const renewTimer = setInterval(() => {
		startGmailWatch(runtimeConfig);
	}, renewMs);
	const detachSignals = () => {
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
	};
	const shutdown = () => {
		if (shuttingDown) return;
		shuttingDown = true;
		detachSignals();
		clearInterval(renewTimer);
		child.kill("SIGTERM");
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
	child.on("exit", () => {
		if (shuttingDown) {
			detachSignals();
			return;
		}
		defaultRuntime.log("gog watch serve exited; restarting in 2s");
		setTimeout(() => {
			if (shuttingDown) return;
			child = spawnGogServe(runtimeConfig);
		}, 2e3);
	});
}
function spawnGogServe(cfg) {
	const args = buildGogWatchServeArgs(cfg);
	defaultRuntime.log(`Starting gog ${args.join(" ")}`);
	return spawn("gog", args, { stdio: "inherit" });
}
async function startGmailWatch(cfg, fatal = false) {
	const result = await runCommandWithTimeout(["gog", ...buildGogWatchStartArgs(cfg)], { timeoutMs: 12e4 });
	if (result.code !== 0) {
		const message = result.stderr || result.stdout || "gog watch start failed";
		if (fatal) throw new Error(message);
		defaultRuntime.error(message);
	}
}

//#endregion
//#region src/cli/webhooks-cli.ts
function registerWebhooksCli(program) {
	const gmail = program.command("webhooks").description("Webhook helpers and integrations").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/webhooks", "docs.openclaw.ai/cli/webhooks")}\n`).command("gmail").description("Gmail Pub/Sub hooks (via gogcli)");
	gmail.command("setup").description("Configure Gmail watch + Pub/Sub + OpenClaw hooks").requiredOption("--account <email>", "Gmail account to watch").option("--project <id>", "GCP project id (OAuth client owner)").option("--topic <name>", "Pub/Sub topic name", DEFAULT_GMAIL_TOPIC).option("--subscription <name>", "Pub/Sub subscription name", DEFAULT_GMAIL_SUBSCRIPTION).option("--label <label>", "Gmail label to watch", DEFAULT_GMAIL_LABEL).option("--hook-url <url>", "OpenClaw hook URL").option("--hook-token <token>", "OpenClaw hook token").option("--push-token <token>", "Push token for gog watch serve").option("--bind <host>", "gog watch serve bind host", DEFAULT_GMAIL_SERVE_BIND).option("--port <port>", "gog watch serve port", String(DEFAULT_GMAIL_SERVE_PORT)).option("--path <path>", "gog watch serve path", DEFAULT_GMAIL_SERVE_PATH).option("--include-body", "Include email body snippets", true).option("--max-bytes <n>", "Max bytes for body snippets", String(DEFAULT_GMAIL_MAX_BYTES)).option("--renew-minutes <n>", "Renew watch every N minutes", String(DEFAULT_GMAIL_RENEW_MINUTES)).option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)", "funnel").option("--tailscale-path <path>", "Path for tailscale serve/funnel").option("--tailscale-target <target>", "Tailscale serve/funnel target (port, host:port, or URL)").option("--push-endpoint <url>", "Explicit Pub/Sub push endpoint").option("--json", "Output JSON summary", false).action(async (opts) => {
		try {
			await runGmailSetup(parseGmailSetupOptions(opts));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
	gmail.command("run").description("Run gog watch serve + auto-renew loop").option("--account <email>", "Gmail account to watch").option("--topic <topic>", "Pub/Sub topic path (projects/.../topics/..)").option("--subscription <name>", "Pub/Sub subscription name").option("--label <label>", "Gmail label to watch").option("--hook-url <url>", "OpenClaw hook URL").option("--hook-token <token>", "OpenClaw hook token").option("--push-token <token>", "Push token for gog watch serve").option("--bind <host>", "gog watch serve bind host").option("--port <port>", "gog watch serve port").option("--path <path>", "gog watch serve path").option("--include-body", "Include email body snippets").option("--max-bytes <n>", "Max bytes for body snippets").option("--renew-minutes <n>", "Renew watch every N minutes").option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)").option("--tailscale-path <path>", "Path for tailscale serve/funnel").option("--tailscale-target <target>", "Tailscale serve/funnel target (port, host:port, or URL)").action(async (opts) => {
		try {
			await runGmailService(parseGmailRunOptions(opts));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	});
}
function parseGmailSetupOptions(raw) {
	const accountRaw = raw.account;
	const account = typeof accountRaw === "string" ? accountRaw.trim() : "";
	if (!account) throw new Error("--account is required");
	const common = parseGmailCommonOptions(raw);
	return {
		account,
		project: stringOption(raw.project),
		...gmailOptionsFromCommon(common),
		pushEndpoint: stringOption(raw.pushEndpoint),
		json: Boolean(raw.json)
	};
}
function parseGmailRunOptions(raw) {
	const common = parseGmailCommonOptions(raw);
	return {
		account: stringOption(raw.account),
		...gmailOptionsFromCommon(common)
	};
}
function parseGmailCommonOptions(raw) {
	return {
		topic: stringOption(raw.topic),
		subscription: stringOption(raw.subscription),
		label: stringOption(raw.label),
		hookUrl: stringOption(raw.hookUrl),
		hookToken: stringOption(raw.hookToken),
		pushToken: stringOption(raw.pushToken),
		bind: stringOption(raw.bind),
		port: numberOption(raw.port),
		path: stringOption(raw.path),
		includeBody: booleanOption(raw.includeBody),
		maxBytes: numberOption(raw.maxBytes),
		renewEveryMinutes: numberOption(raw.renewMinutes),
		tailscaleRaw: stringOption(raw.tailscale),
		tailscalePath: stringOption(raw.tailscalePath),
		tailscaleTarget: stringOption(raw.tailscaleTarget)
	};
}
function gmailOptionsFromCommon(common) {
	return {
		topic: common.topic,
		subscription: common.subscription,
		label: common.label,
		hookUrl: common.hookUrl,
		hookToken: common.hookToken,
		pushToken: common.pushToken,
		bind: common.bind,
		port: common.port,
		path: common.path,
		includeBody: common.includeBody,
		maxBytes: common.maxBytes,
		renewEveryMinutes: common.renewEveryMinutes,
		tailscale: common.tailscaleRaw,
		tailscalePath: common.tailscalePath,
		tailscaleTarget: common.tailscaleTarget
	};
}
function stringOption(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed ? trimmed : void 0;
}
function numberOption(value) {
	if (value === void 0 || value === null) return;
	const n = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(n) || n <= 0) return;
	return Math.floor(n);
}
function booleanOption(value) {
	if (value === void 0 || value === null) return;
	return Boolean(value);
}

//#endregion
export { registerWebhooksCli };