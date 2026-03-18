import "./redact-qojvLPM7.js";
import "./errors-nCFRNLA6.js";
import "./unhandled-rejections-DGuis5pC.js";
import { b as isValidTimeZone, v as formatLocalIsoWithOffset, y as init_timestamps } from "./globals-B6h30oSy.js";
import "./paths-DqbqmTPe.js";
import { i as theme, n as init_theme, r as isRich, t as colorize } from "./theme-CL08MjAq.js";
import { g as init_progress_line, h as clearActiveProgressLine } from "./subsystem-CZwunM2N.js";
import "./ansi-CeMmGDji.js";
import "./boolean-B938tROv.js";
import "./env--LwFRA3k.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-BiUV1eIQ.js";
import { t as formatDocsLink } from "./links-DPi3kBux.js";
import { Rd as buildGatewayConnectionDetails } from "./auth-profiles-DAOR1fRn.js";
import "./plugins-allowlist-E4LSkJ7R.js";
import "./registry-ep1yQ6WN.js";
import "./fetch-COjVSrBr.js";
import "./config-state-CkhXLglq.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-DZywV-kg.js";
import "./method-scopes-CLHNYIU6.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import "./plugins-DC9n978g.js";
import "./brew-CAA1PAwX.js";
import "./agent-scope-C0PckUtv.js";
import "./logger-DLmJXd-S.js";
import "./exec-BmPfiSbq.js";
import "./env-overrides-Dbt5eAZJ.js";
import "./safe-text-BN5UJvnR.js";
import "./version-Dubp0iGu.js";
import "./config-DZ3oWznn.js";
import "./workspace-dirs-Ejflbukt.js";
import "./search-manager-CVctuSlw.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-V82ct97U.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-DUmWDILI.js";
import "./commands-BfMCtxuV.js";
import "./ports-D4BnBb9r.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-DMTCLBKm.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-_j5H8TrE.js";
import "./paths-55bRPK_d.js";
import "./session-cost-usage-DqIvfSaZ.js";
import "./fetch-wLdC1F30.js";
import "./identity-file-GRgHESaI.js";
import "./dm-policy-shared-QWD8iFx0.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-ur8rDo4q.js";
import "./prompt-style-CEH2A0QE.js";
import "./secret-file-CGJfrW4K.js";
import "./token-BE5e8NTA.js";
import "./restart-stale-pids-Be6QOzfZ.js";
import "./accounts-C8zoA5z4.js";
import "./audit-BTP1ZwHz.js";
import "./cli-utils-DRykF2zj.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-D-H0eFDI.js";
import { t as parseLogLine } from "./parse-log-line-vuU3mmrH.js";
import { setTimeout } from "node:timers/promises";
//#region src/terminal/stream-writer.ts
init_progress_line();
init_timestamps();
function isBrokenPipeError(err) {
	const code = err?.code;
	return code === "EPIPE" || code === "EIO";
}
function createSafeStreamWriter(options = {}) {
	let closed = false;
	let notified = false;
	const noteBrokenPipe = (err, stream) => {
		if (notified) return;
		notified = true;
		options.onBrokenPipe?.(err, stream);
	};
	const handleError = (err, stream) => {
		if (!isBrokenPipeError(err)) throw err;
		closed = true;
		noteBrokenPipe(err, stream);
		return false;
	};
	const write = (stream, text) => {
		if (closed) return false;
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
init_theme();
function parsePositiveInt(value, fallback) {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
async function fetchLogs(opts, cursor, showProgress) {
	const payload = await callGatewayFromCli("logs.tail", opts, {
		cursor,
		limit: parsePositiveInt(opts.limit, 200),
		maxBytes: parsePositiveInt(opts.maxBytes, 25e4)
	}, { progress: showProgress });
	if (!payload || typeof payload !== "object") throw new Error("Unexpected logs.tail response");
	return payload;
}
function formatLogTimestamp(value, mode = "plain", localTime = false) {
	if (!value) return "";
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime())) return value;
	let timeString;
	if (localTime) timeString = formatLocalIsoWithOffset(parsed);
	else timeString = parsed.toISOString();
	if (mode === "pretty") return timeString.slice(11, 19);
	return timeString;
}
function formatLogLine(raw, opts) {
	const parsed = parseLogLine(raw);
	if (!parsed) return raw;
	const label = parsed.subsystem ?? parsed.module ?? "";
	const time = formatLogTimestamp(parsed.time, opts.pretty ? "pretty" : "plain", opts.localTime);
	const level = parsed.level ?? "";
	const levelLabel = level.padEnd(5).trim();
	const message = parsed.message || parsed.raw;
	if (!opts.pretty) return [
		time,
		level,
		label,
		message
	].filter(Boolean).join(" ").trim();
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
		}, true)) return;
		return;
	}
	if (!errorLine(colorize(rich, theme.error, message))) return;
	if (!errorLine(details.message)) return;
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
					})) return;
				}
				for (const line of lines) {
					const parsed = parseLogLine(line);
					if (parsed) {
						if (!emitJsonLine({
							type: "log",
							...parsed
						})) return;
					} else if (!emitJsonLine({
						type: "raw",
						raw: line
					})) return;
				}
				if (payload.truncated) {
					if (!emitJsonLine({
						type: "notice",
						message: "Log tail truncated (increase --max-bytes)."
					})) return;
				}
				if (payload.reset) {
					if (!emitJsonLine({
						type: "notice",
						message: "Log cursor reset (file rotated)."
					})) return;
				}
			} else {
				if (first && payload.file) {
					if (!logLine(`${pretty ? colorize(rich, theme.muted, "Log file:") : "Log file:"} ${payload.file}`)) return;
				}
				for (const line of lines) if (!logLine(formatLogLine(line, {
					pretty,
					rich,
					localTime
				}))) return;
				if (payload.truncated) {
					if (!errorLine("Log tail truncated (increase --max-bytes).")) return;
				}
				if (payload.reset) {
					if (!errorLine("Log cursor reset (file rotated).")) return;
				}
			}
			cursor = typeof payload.cursor === "number" && Number.isFinite(payload.cursor) ? payload.cursor : cursor;
			first = false;
			if (!opts.follow) return;
			await setTimeout(interval);
		}
	});
}
//#endregion
export { registerLogsCli };
