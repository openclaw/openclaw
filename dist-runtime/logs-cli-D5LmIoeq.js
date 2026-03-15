import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import { _ as isValidTimeZone, g as formatLocalIsoWithOffset } from "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import { n as isRich, r as theme, t as colorize } from "./theme-UkqnBJaj.js";
import { d as clearActiveProgressLine } from "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import { t as formatDocsLink } from "./links-Cx-Xmp-Y.js";
import { zd as buildGatewayConnectionDetails } from "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
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
import "./cli-utils-DRykF2zj.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-B_RKVlkq.js";
import { t as parseLogLine } from "./parse-log-line-vuU3mmrH.js";
import { setTimeout } from "node:timers/promises";
//#region src/terminal/stream-writer.ts
function isBrokenPipeError(err) {
	const code = err?.code;
	return code === "EPIPE" || code === "EIO";
}
function createSafeStreamWriter(options = {}) {
	let closed = false;
	let notified = false;
	const noteBrokenPipe = (err, stream) => {
		if (notified) {return;}
		notified = true;
		options.onBrokenPipe?.(err, stream);
	};
	const handleError = (err, stream) => {
		if (!isBrokenPipeError(err)) {throw err;}
		closed = true;
		noteBrokenPipe(err, stream);
		return false;
	};
	const write = (stream, text) => {
		if (closed) {return false;}
		try {
			options.beforeWrite?.();
		} catch (err) {
			return handleError(err, process.stderr);
		}
		try {
			stream.write(text);
			return !closed;
		} catch (err) {
			return handleError(err, stream);
		}
	};
	const writeLine = (stream, text) => write(stream, `${text}\n`);
	return {
		write,
		writeLine,
		reset: () => {
			closed = false;
			notified = false;
		},
		isClosed: () => closed
	};
}
//#endregion
//#region src/cli/logs-cli.ts
function parsePositiveInt(value, fallback) {
	if (!value) {return fallback;}
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
async function fetchLogs(opts, cursor, showProgress) {
	const payload = await callGatewayFromCli("logs.tail", opts, {
		cursor,
		limit: parsePositiveInt(opts.limit, 200),
		maxBytes: parsePositiveInt(opts.maxBytes, 25e4)
	}, { progress: showProgress });
	if (!payload || typeof payload !== "object") {throw new Error("Unexpected logs.tail response");}
	return payload;
}
function formatLogTimestamp(value, mode = "plain", localTime = false) {
	if (!value) {return "";}
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) {return value;}
	let timeString;
	if (localTime) {timeString = formatLocalIsoWithOffset(parsed);}
	else {timeString = parsed.toISOString();}
	if (mode === "pretty") {return timeString.slice(11, 19);}
	return timeString;
}
function formatLogLine(raw, opts) {
	const parsed = parseLogLine(raw);
	if (!parsed) {return raw;}
	const label = parsed.subsystem ?? parsed.module ?? "";
	const time = formatLogTimestamp(parsed.time, opts.pretty ? "pretty" : "plain", opts.localTime);
	const level = parsed.level ?? "";
	const levelLabel = level.padEnd(5).trim();
	const message = parsed.message || parsed.raw;
	if (!opts.pretty) {return [
		time,
		level,
		label,
		message
	].filter(Boolean).join(" ").trim();}
	const timeLabel = colorize(opts.rich, theme.muted, time);
	const labelValue = colorize(opts.rich, theme.accent, label);
	const levelValue = level === "error" || level === "fatal" ? colorize(opts.rich, theme.error, levelLabel) : level === "warn" ? colorize(opts.rich, theme.warn, levelLabel) : level === "debug" || level === "trace" ? colorize(opts.rich, theme.muted, levelLabel) : colorize(opts.rich, theme.info, levelLabel);
	const messageValue = level === "error" || level === "fatal" ? colorize(opts.rich, theme.error, message) : level === "warn" ? colorize(opts.rich, theme.warn, message) : level === "debug" || level === "trace" ? colorize(opts.rich, theme.muted, message) : colorize(opts.rich, theme.info, message);
	return [[
		timeLabel,
		levelValue,
		labelValue
	].filter(Boolean).join(" "), messageValue].filter(Boolean).join(" ").trim();
}
function createLogWriters() {
	const writer = createSafeStreamWriter({
		beforeWrite: () => clearActiveProgressLine(),
		onBrokenPipe: (err, stream) => {
			const code = err.code ?? "EPIPE";
			const message = `openclaw logs: output ${stream === process.stdout ? "stdout" : "stderr"} closed (${code}). Stopping tail.`;
			try {
				clearActiveProgressLine();
				process.stderr.write(`${message}\n`);
			} catch {}
		}
	});
	return {
		logLine: (text) => writer.writeLine(process.stdout, text),
		errorLine: (text) => writer.writeLine(process.stderr, text),
		emitJsonLine: (payload, toStdErr = false) => writer.write(toStdErr ? process.stderr : process.stdout, `${JSON.stringify(payload)}\n`)
	};
}
function emitGatewayError(err, opts, mode, rich, emitJsonLine, errorLine) {
	const details = buildGatewayConnectionDetails({ url: opts.url });
	const message = "Gateway not reachable. Is it running and accessible?";
	const hint = `Hint: run \`${formatCliCommand("openclaw doctor")}\`.`;
	const errorText = err instanceof Error ? err.message : String(err);
	if (mode === "json") {
		if (!emitJsonLine({
			type: "error",
			message,
			error: errorText,
			details,
			hint
		}, true)) {return;}
		return;
	}
	if (!errorLine(colorize(rich, theme.error, message))) {return;}
	if (!errorLine(details.message)) {return;}
	errorLine(colorize(rich, theme.muted, hint));
}
function registerLogsCli(program) {
	const logs = program.command("logs").description("Tail gateway file logs via RPC").option("--limit <n>", "Max lines to return", "200").option("--max-bytes <n>", "Max bytes to read", "250000").option("--follow", "Follow log output", false).option("--interval <ms>", "Polling interval in ms", "1000").option("--json", "Emit JSON log lines", false).option("--plain", "Plain text output (no ANSI styling)", false).option("--no-color", "Disable ANSI colors").option("--local-time", "Display timestamps in local timezone", false).addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/logs", "docs.openclaw.ai/cli/logs")}\n`);
	addGatewayClientOptions(logs);
	logs.action(async (opts) => {
		const { logLine, errorLine, emitJsonLine } = createLogWriters();
		const interval = parsePositiveInt(opts.interval, 1e3);
		let cursor;
		let first = true;
		const jsonMode = Boolean(opts.json);
		const pretty = !jsonMode && Boolean(process.stdout.isTTY) && !opts.plain;
		const rich = isRich() && opts.color !== false;
		const localTime = Boolean(opts.localTime) || !!process.env.TZ && isValidTimeZone(process.env.TZ);
		while (true) {
			let payload;
			const showProgress = first && !opts.follow;
			try {
				payload = await fetchLogs(opts, cursor, showProgress);
			} catch (err) {
				emitGatewayError(err, opts, jsonMode ? "json" : "text", rich, emitJsonLine, errorLine);
				process.exit(1);
				return;
			}
			const lines = Array.isArray(payload.lines) ? payload.lines : [];
			if (jsonMode) {
				if (first) {
					if (!emitJsonLine({
						type: "meta",
						file: payload.file,
						cursor: payload.cursor,
						size: payload.size
					})) {return;}
				}
				for (const line of lines) {
					const parsed = parseLogLine(line);
					if (parsed) {
						if (!emitJsonLine({
							type: "log",
							...parsed
						})) {return;}
					} else if (!emitJsonLine({
						type: "raw",
						raw: line
					})) {return;}
				}
				if (payload.truncated) {
					if (!emitJsonLine({
						type: "notice",
						message: "Log tail truncated (increase --max-bytes)."
					})) {return;}
				}
				if (payload.reset) {
					if (!emitJsonLine({
						type: "notice",
						message: "Log cursor reset (file rotated)."
					})) {return;}
				}
			} else {
				if (first && payload.file) {
					if (!logLine(`${pretty ? colorize(rich, theme.muted, "Log file:") : "Log file:"} ${payload.file}`)) {return;}
				}
				for (const line of lines) {if (!logLine(formatLogLine(line, {
					pretty,
					rich,
					localTime
				}))) return;}
				if (payload.truncated) {
					if (!errorLine("Log tail truncated (increase --max-bytes).")) {return;}
				}
				if (payload.reset) {
					if (!errorLine("Log cursor reset (file rotated).")) {return;}
				}
			}
			cursor = typeof payload.cursor === "number" && Number.isFinite(payload.cursor) ? payload.cursor : cursor;
			first = false;
			if (!opts.follow) {return;}
			await setTimeout(interval);
		}
	});
}
//#endregion
export { registerLogsCli };
