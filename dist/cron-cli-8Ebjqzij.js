import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString, s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { n as isRich, r as theme, t as colorize } from "./theme-D58JpUfy.js";
import { m as sanitizeAgentId } from "./session-key-Bte0mmcq.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as danger } from "./globals-YU5FjfZK.js";
import { t as parseDurationMs$1 } from "./parse-duration-CD4d_yk2.js";
import { i as listChannelPlugins } from "./registry-Bf5TpUad.js";
import "./plugins-DYTHbmt7.js";
import { n as formatDurationHuman } from "./format-duration-BrZ-AaEJ.js";
import { i as parseAbsoluteTimeMs, n as resolveCronStaggerMs } from "./stagger-Bn6ApiDa.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-COT1oBPJ.js";
import { n as parsePositiveIntOrUndefined } from "./helpers-BNXNWxTW.js";
import { t as applyParentDefaultHelpAction } from "./parent-default-help-DQUF3qKA.js";
//#region src/infra/format-time/parse-offsetless-zoned-datetime.ts
const OFFSETLESS_ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?$/;
const OFFSETLESS_ISO_DATETIME_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;
function isOffsetlessIsoDateTime(raw) {
	return OFFSETLESS_ISO_DATETIME_RE.test(raw);
}
function parseOffsetlessIsoDateTimeInTimeZone(raw, timeZone) {
	const expectedParts = parseOffsetlessIsoDateTimeParts(raw);
	if (!expectedParts) return null;
	try {
		getZonedDateTimeParts(Date.now(), timeZone);
		const naiveMs = (/* @__PURE__ */ new Date(`${raw}Z`)).getTime();
		if (Number.isNaN(naiveMs)) return null;
		const resolvedMs = naiveMs - getTimeZoneOffsetMs(naiveMs - getTimeZoneOffsetMs(naiveMs, timeZone), timeZone);
		if (!matchesOffsetlessIsoDateTimeParts(resolvedMs, timeZone, expectedParts)) return null;
		return new Date(resolvedMs).toISOString();
	} catch {
		return null;
	}
}
function parseOffsetlessIsoDateTimeParts(raw) {
	const match = OFFSETLESS_ISO_DATETIME_PARTS_RE.exec(raw);
	if (!match) return null;
	const fractionalMs = (match[7] ?? "").padEnd(3, "0").slice(0, 3);
	return {
		year: Number.parseInt(match[1] ?? "0", 10),
		month: Number.parseInt(match[2] ?? "0", 10),
		day: Number.parseInt(match[3] ?? "0", 10),
		hour: Number.parseInt(match[4] ?? "0", 10),
		minute: Number.parseInt(match[5] ?? "0", 10),
		second: Number.parseInt(match[6] ?? "0", 10),
		millisecond: Number.parseInt(fractionalMs || "0", 10)
	};
}
function matchesOffsetlessIsoDateTimeParts(utcMs, timeZone, expected) {
	const actual = getZonedDateTimeParts(utcMs, timeZone);
	return actual.year === expected.year && actual.month === expected.month && actual.day === expected.day && actual.hour === expected.hour && actual.minute === expected.minute && actual.second === expected.second && actual.millisecond === expected.millisecond;
}
function getTimeZoneOffsetMs(utcMs, timeZone) {
	const parts = getZonedDateTimeParts(utcMs, timeZone);
	return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - utcMs;
}
function getZonedDateTimeParts(utcMs, timeZone) {
	const utcDate = new Date(utcMs);
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		hourCycle: "h23"
	}).formatToParts(utcDate);
	const getNumericPart = (type) => {
		const part = parts.find((candidate) => candidate.type === type);
		return Number.parseInt(part?.value ?? "0", 10);
	};
	return {
		year: getNumericPart("year"),
		month: getNumericPart("month"),
		day: getNumericPart("day"),
		hour: getNumericPart("hour"),
		minute: getNumericPart("minute"),
		second: getNumericPart("second"),
		millisecond: utcDate.getUTCMilliseconds()
	};
}
//#endregion
//#region src/cli/cron-cli/shared.ts
const getCronChannelOptions = () => {
	const pluginIds = listChannelPlugins().map((plugin) => plugin.id).filter(Boolean);
	return pluginIds.length > 0 ? ["last", ...pluginIds].join("|") : "last|<channel-id>";
};
function printCronJson(value) {
	defaultRuntime.writeJson(value);
}
/**
* Enrich a CronJob (or list response) with a computed `status` field
* derived from enabled + state.runningAtMs + state.lastRunStatus.
* This mirrors the human-readable status shown by `cron list` / `cron show`.
*/
function enrichCronJsonWithStatus(value) {
	if (!value || typeof value !== "object") return value;
	const obj = value;
	if ("state" in obj && "enabled" in obj) return {
		...obj,
		status: computeStatus(obj)
	};
	if ("jobs" in obj && Array.isArray(obj.jobs)) {
		const enrichedJobs = obj.jobs.map((job) => {
			const status = computeStatus(job);
			return Object.assign({}, job, { status });
		});
		return {
			...obj,
			jobs: enrichedJobs
		};
	}
	return value;
}
function computeStatus(job) {
	if (!job.enabled) return "disabled";
	const state = job.state ?? {};
	if (state.runningAtMs) return "running";
	return state.lastRunStatus ?? state.lastStatus ?? "idle";
}
function handleCronCliError(err) {
	defaultRuntime.error(danger(String(err)));
	defaultRuntime.exit(1);
}
async function warnIfCronSchedulerDisabled(opts) {
	try {
		const res = await callGatewayFromCli("cron.status", opts, {});
		if (res?.enabled === true) return;
		const store = typeof res?.storePath === "string" ? res.storePath : "";
		defaultRuntime.error([
			"warning: cron scheduler is disabled in the Gateway; jobs are saved but will not run automatically.",
			"Re-enable with `cron.enabled: true` (or remove `cron.enabled: false`) and restart the Gateway.",
			store ? `store: ${store}` : ""
		].filter(Boolean).join("\n"));
	} catch {}
}
function parseDurationMs(input) {
	const raw = input.trim();
	if (!raw) return null;
	const match = raw.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/i);
	if (!match) return null;
	const n = Number.parseFloat(match[1] ?? "");
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = normalizeLowercaseStringOrEmpty(match[2] ?? "");
	return Math.floor(n * (unit === "ms" ? 1 : unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5));
}
function parseCronStaggerMs(params) {
	if (params.useExact) return 0;
	if (!params.staggerRaw) return;
	const parsed = parseDurationMs(params.staggerRaw);
	if (!parsed) throw new Error("Invalid --stagger; use e.g. 30s, 1m, 5m");
	return parsed;
}
function parseCronToolsAllow(input) {
	const tools = (Array.isArray(input) ? input.map((value) => String(value)).join(" ") : typeof input === "string" ? input : "").split(/[,\s]+/u).map((tool) => normalizeOptionalString(tool)).filter((tool) => Boolean(tool));
	return tools.length > 0 ? tools : void 0;
}
/**
* Parse a one-shot `--at` value into an ISO string (UTC).
*
* When `tz` is provided and the input is an offset-less datetime
* (e.g. `2026-03-23T23:00:00`), the datetime is interpreted in
* that IANA timezone instead of UTC.
*/
function parseAt(input, tz) {
	const raw = input.trim();
	if (!raw) return null;
	if (tz && isOffsetlessIsoDateTime(raw)) return parseOffsetlessIsoDateTimeInTimeZone(raw, tz);
	const absolute = parseAbsoluteTimeMs(raw);
	if (absolute !== null) return new Date(absolute).toISOString();
	const dur = parseDurationMs(raw);
	if (dur !== null) return new Date(Date.now() + dur).toISOString();
	return null;
}
const CRON_ID_PAD = 36;
const CRON_NAME_PAD = 24;
const CRON_SCHEDULE_PAD = 32;
const CRON_NEXT_PAD = 10;
const CRON_LAST_PAD = 10;
const CRON_STATUS_PAD = 9;
const CRON_TARGET_PAD = 9;
const CRON_DELIVERY_PAD = 64;
const CRON_AGENT_PAD = 10;
const CRON_MODEL_PAD = 20;
const stringifyCell = (value, fallback = "-") => {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return fallback;
};
const pad = (value, width) => stringifyCell(value).padEnd(width);
const truncate = (value, width) => {
	if (value.length <= width) return value;
	if (width <= 3) return value.slice(0, width);
	return `${value.slice(0, width - 3)}...`;
};
const formatIsoMinute = (iso) => {
	const parsed = parseAbsoluteTimeMs(iso);
	const d = new Date(parsed ?? NaN);
	if (Number.isNaN(d.getTime())) return "-";
	const isoStr = d.toISOString();
	return `${isoStr.slice(0, 10)} ${isoStr.slice(11, 16)}Z`;
};
const formatSpan = (ms) => {
	if (ms < 6e4) return "<1m";
	if (ms < 36e5) return `${Math.round(ms / 6e4)}m`;
	if (ms < 864e5) return `${Math.round(ms / 36e5)}h`;
	return `${Math.round(ms / 864e5)}d`;
};
const formatRelative = (ms, nowMs) => {
	if (!ms) return "-";
	const delta = ms - nowMs;
	const label = formatSpan(Math.abs(delta));
	return delta >= 0 ? `in ${label}` : `${label} ago`;
};
const formatSchedule = (schedule) => {
	if (schedule?.kind === "at") return `at ${formatIsoMinute(schedule.at)}`;
	if (schedule?.kind === "every") return `every ${formatDurationHuman(schedule.everyMs)}`;
	if (schedule?.kind !== "cron") return "-";
	const base = schedule.tz ? `cron ${schedule.expr} @ ${schedule.tz}` : `cron ${schedule.expr}`;
	const staggerMs = resolveCronStaggerMs(schedule);
	if (staggerMs <= 0) return `${base} (exact)`;
	return `${base} (stagger ${formatDurationHuman(staggerMs)})`;
};
const formatStatus = (job) => {
	if (!job.enabled) return "disabled";
	const state = job.state ?? {};
	if (state.runningAtMs) return "running";
	return state.lastStatus ?? "idle";
};
function coerceCronDeliveryPreviews(value) {
	const previews = value && typeof value === "object" ? value.deliveryPreviews : void 0;
	if (!previews || typeof previews !== "object") return /* @__PURE__ */ new Map();
	return new Map(Object.entries(previews).flatMap(([jobId, preview]) => {
		if (!preview || typeof preview !== "object") return [];
		const record = preview;
		if (typeof record.label !== "string" || typeof record.detail !== "string") return [];
		return [[jobId, {
			label: record.label,
			detail: record.detail
		}]];
	}));
}
function printCronList(jobs, runtime = defaultRuntime, opts) {
	if (jobs.length === 0) {
		runtime.log("No cron jobs.");
		return;
	}
	const rich = isRich();
	const header = [
		pad("ID", CRON_ID_PAD),
		pad("Name", CRON_NAME_PAD),
		pad("Schedule", CRON_SCHEDULE_PAD),
		pad("Next", CRON_NEXT_PAD),
		pad("Last", CRON_LAST_PAD),
		pad("Status", CRON_STATUS_PAD),
		pad("Target", CRON_TARGET_PAD),
		pad("Delivery", CRON_DELIVERY_PAD),
		pad("Agent ID", CRON_AGENT_PAD),
		pad("Model", CRON_MODEL_PAD)
	].join(" ");
	runtime.log(rich ? theme.heading(header) : header);
	const now = Date.now();
	for (const job of jobs) {
		const state = job.state ?? {};
		const idLabel = pad(job.id, CRON_ID_PAD);
		const nameLabel = pad(truncate(stringifyCell(job.name), CRON_NAME_PAD), CRON_NAME_PAD);
		const scheduleLabel = pad(truncate(formatSchedule(job.schedule), CRON_SCHEDULE_PAD), CRON_SCHEDULE_PAD);
		const nextLabel = pad(job.enabled ? formatRelative(state.nextRunAtMs, now) : "-", CRON_NEXT_PAD);
		const lastLabel = pad(formatRelative(state.lastRunAtMs, now), CRON_LAST_PAD);
		const statusRaw = formatStatus(job);
		const statusLabel = pad(statusRaw, CRON_STATUS_PAD);
		const targetLabel = pad(job.sessionTarget ?? "-", CRON_TARGET_PAD);
		const deliveryPreview = opts?.deliveryPreviews?.get(job.id);
		const deliveryLabel = pad(truncate(deliveryPreview ? `${deliveryPreview.label} (${deliveryPreview.detail})` : "-", CRON_DELIVERY_PAD), CRON_DELIVERY_PAD);
		const agentLabel = pad(truncate(job.agentId ?? "-", CRON_AGENT_PAD), CRON_AGENT_PAD);
		const modelLabel = pad(truncate((job.payload?.kind === "agentTurn" ? job.payload.model : void 0) ?? "-", CRON_MODEL_PAD), CRON_MODEL_PAD);
		const coloredStatus = (() => {
			if (statusRaw === "ok") return colorize(rich, theme.success, statusLabel);
			if (statusRaw === "error") return colorize(rich, theme.error, statusLabel);
			if (statusRaw === "running") return colorize(rich, theme.warn, statusLabel);
			if (statusRaw === "skipped") return colorize(rich, theme.muted, statusLabel);
			return colorize(rich, theme.muted, statusLabel);
		})();
		const coloredTarget = job.sessionTarget === "main" ? colorize(rich, theme.accent, targetLabel) : colorize(rich, theme.accentBright, targetLabel);
		const coloredAgent = job.agentId ? colorize(rich, theme.info, agentLabel) : colorize(rich, theme.muted, agentLabel);
		const line = [
			colorize(rich, theme.accent, idLabel),
			colorize(rich, theme.info, nameLabel),
			colorize(rich, theme.info, scheduleLabel),
			colorize(rich, theme.muted, nextLabel),
			colorize(rich, theme.muted, lastLabel),
			coloredStatus,
			coloredTarget,
			deliveryPreview ? colorize(rich, theme.info, deliveryLabel) : colorize(rich, theme.muted, deliveryLabel),
			coloredAgent,
			job.payload?.kind === "agentTurn" && job.payload.model ? colorize(rich, theme.info, modelLabel) : colorize(rich, theme.muted, modelLabel)
		].join(" ");
		runtime.log(line.trimEnd());
	}
}
function printCronShow(job, runtime = defaultRuntime, opts) {
	const preview = opts?.deliveryPreview ?? {
		label: "-",
		detail: "unavailable"
	};
	runtime.log(`id: ${job.id}`);
	runtime.log(`name: ${job.name}`);
	runtime.log(`enabled: ${job.enabled ? "yes" : "no"}`);
	runtime.log(`schedule: ${formatSchedule(job.schedule)}`);
	runtime.log(`session: ${job.sessionTarget ?? "-"}`);
	runtime.log(`agent: ${job.agentId ?? "-"}`);
	runtime.log(`model: ${job.payload.kind === "agentTurn" ? job.payload.model ?? "-" : "-"}`);
	runtime.log(`delivery: ${preview.label} (${preview.detail})`);
	runtime.log(`next: ${formatRelative(job.state.nextRunAtMs, Date.now())}`);
	runtime.log(`last: ${formatRelative(job.state.lastRunAtMs, Date.now())}`);
	runtime.log(`status: ${formatStatus(job)}`);
	runtime.log(`diagnostic: ${job.state.lastDiagnosticSummary ?? "-"}`);
}
//#endregion
//#region src/cli/cron-cli/schedule-options.ts
function resolveCronCreateSchedule(options) {
	const normalized = normalizeScheduleOptions(options);
	if (countChosenSchedules(normalized) !== 1) throw new Error("Choose exactly one schedule: --at, --every, or --cron");
	const schedule = resolveDirectSchedule(normalized);
	if (!schedule) throw new Error("Choose exactly one schedule: --at, --every, or --cron");
	return schedule;
}
function resolveCronEditScheduleRequest(options) {
	const normalized = normalizeScheduleOptions(options);
	if (countChosenSchedules(normalized) > 1) throw new Error("Choose at most one schedule change");
	const schedule = resolveDirectSchedule(normalized);
	if (schedule) return {
		kind: "direct",
		schedule
	};
	if (normalized.requestedStaggerMs !== void 0 || normalized.tz !== void 0) return {
		kind: "patch-existing-cron",
		tz: normalized.tz,
		staggerMs: normalized.requestedStaggerMs
	};
	return { kind: "none" };
}
function applyExistingCronSchedulePatch(existingSchedule, request) {
	if (existingSchedule.kind !== "cron") throw new Error("Current job is not a cron schedule; use --cron to convert first");
	return {
		kind: "cron",
		expr: existingSchedule.expr,
		tz: request.tz ?? existingSchedule.tz,
		staggerMs: request.staggerMs !== void 0 ? request.staggerMs : existingSchedule.staggerMs
	};
}
function normalizeScheduleOptions(options) {
	const staggerRaw = normalizeOptionalString(options.stagger) ?? "";
	const useExact = Boolean(options.exact);
	if (staggerRaw && useExact) throw new Error("Choose either --stagger or --exact, not both");
	return {
		at: normalizeOptionalString(options.at) ?? "",
		every: normalizeOptionalString(options.every) ?? "",
		cronExpr: normalizeOptionalString(options.cron) ?? "",
		tz: normalizeOptionalString(options.tz),
		requestedStaggerMs: parseCronStaggerMs({
			staggerRaw,
			useExact
		})
	};
}
function countChosenSchedules(options) {
	return [
		Boolean(options.at),
		Boolean(options.every),
		Boolean(options.cronExpr)
	].filter(Boolean).length;
}
function resolveDirectSchedule(options) {
	if (options.tz && options.every) throw new Error("--tz is only valid with --cron or offset-less --at");
	if (options.requestedStaggerMs !== void 0 && (options.at || options.every)) throw new Error("--stagger/--exact are only valid for cron schedules");
	if (options.at) {
		const atIso = parseAt(options.at, options.tz);
		if (!atIso) throw new Error("Invalid --at. Use an ISO timestamp or a duration like 20m.");
		return {
			kind: "at",
			at: atIso
		};
	}
	if (options.every) {
		const everyMs = parseDurationMs(options.every);
		if (!everyMs) throw new Error("Invalid --every. Use a duration like 10m, 1h, or 1d.");
		return {
			kind: "every",
			everyMs
		};
	}
	if (options.cronExpr) return {
		kind: "cron",
		expr: options.cronExpr,
		tz: options.tz,
		staggerMs: options.requestedStaggerMs
	};
}
//#endregion
//#region src/cli/cron-cli/thread-id-shared.ts
function parseCronThreadIdOption(value) {
	const raw = normalizeOptionalString(value);
	if (!raw) return;
	if (!/^\d+$/.test(raw)) throw new Error("--thread-id must be a positive integer Telegram topic thread id");
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("--thread-id must be a safe positive integer Telegram topic thread id");
	return parsed;
}
function normalizeCronSessionTargetOption(value) {
	const raw = normalizeOptionalString(value);
	if (!raw) return;
	const lower = normalizeLowercaseStringOrEmpty(raw);
	if (lower === "main" || lower === "isolated" || lower === "current") return lower;
	if (lower.startsWith("session:")) {
		const id = normalizeOptionalString(raw.slice(8));
		return id ? `session:${id}` : void 0;
	}
}
//#endregion
//#region src/cli/cron-cli/register.cron-add.ts
function registerCronStatusCommand(cron) {
	addGatewayClientOptions(cron.command("status").description("Show cron scheduler status").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			printCronJson(await callGatewayFromCli("cron.status", opts, {}));
		} catch (err) {
			handleCronCliError(err);
		}
	}));
}
function registerCronListCommand(cron) {
	addGatewayClientOptions(cron.command("list").description("List cron jobs").option("--all", "Include disabled jobs", false).option("--agent <id>", "Filter by agent id").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const listParams = { includeDisabled: Boolean(opts.all) };
			const agentId = normalizeOptionalString(opts.agent);
			if (agentId) listParams.agentId = sanitizeAgentId(agentId);
			const res = await callGatewayFromCli("cron.list", opts, listParams);
			if (opts.json) {
				printCronJson(enrichCronJsonWithStatus(res));
				return;
			}
			printCronList(res?.jobs ?? [], defaultRuntime, { deliveryPreviews: coerceCronDeliveryPreviews(res) });
		} catch (err) {
			handleCronCliError(err);
		}
	}));
}
function registerCronAddCommand(cron) {
	addGatewayClientOptions(cron.command("add").alias("create").description("Add a cron job").requiredOption("--name <name>", "Job name").option("--description <text>", "Optional description").option("--disabled", "Create job disabled", false).option("--delete-after-run", "Delete one-shot job after it succeeds", false).option("--keep-after-run", "Keep one-shot job after it succeeds", false).option("--agent <id>", "Agent id for this job").option("--session <target>", "Session target (main|isolated)").option("--session-key <key>", "Session key for job routing (e.g. agent:my-agent:my-session)").option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now").option("--at <when>", "Run once at time (ISO with offset, or +duration). Use --tz for offset-less datetimes").option("--every <duration>", "Run every duration (e.g. 10m, 1h)").option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)").option("--tz <iana>", "Timezone for cron expressions (IANA; cron default: Gateway host local timezone)", "").option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)").option("--exact", "Disable cron staggering (set stagger to 0)", false).option("--system-event <text>", "System event payload (main session)").option("--message <text>", "Agent message payload").option("--thinking <level>", "Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)").option("--model <model>", "Model override for agent jobs (provider/model or alias)").option("--timeout-seconds <n>", "Timeout seconds for agent jobs").option("--light-context", "Use lightweight bootstrap context for agent jobs", false).option("--tools <list>", "Tool allow-list (e.g. exec,read,write or exec read write)").option("--announce", "Fallback-deliver final text to a chat", false).option("--deliver", "Deprecated (use --announce). Fallback-delivers final text to a chat.").option("--no-deliver", "Disable runner fallback delivery").option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last").option("--to <dest>", "Delivery destination (E.164, Telegram chatId, or Discord channel/user)").option("--thread-id <id>", "Telegram forum topic thread id").option("--account <id>", "Channel account id for delivery (multi-account setups)").option("--best-effort-deliver", "Do not fail the job if delivery fails", false).option("--json", "Output JSON", false).action(async (opts, cmd) => {
		try {
			const schedule = resolveCronCreateSchedule({
				at: opts.at,
				cron: opts.cron,
				every: opts.every,
				exact: opts.exact,
				stagger: opts.stagger,
				tz: opts.tz
			});
			const wakeMode = normalizeOptionalString(opts.wake) ?? "now";
			if (wakeMode !== "now" && wakeMode !== "next-heartbeat") throw new Error("--wake must be now or next-heartbeat");
			const rawAgentId = normalizeOptionalString(opts.agent);
			const agentId = rawAgentId ? sanitizeAgentId(rawAgentId) : void 0;
			const hasAnnounce = Boolean(opts.announce) || opts.deliver === true;
			const hasNoDeliver = opts.deliver === false;
			if ([hasAnnounce, hasNoDeliver].filter(Boolean).length > 1) throw new Error("Choose at most one of --announce or --no-deliver");
			const payload = (() => {
				const systemEvent = normalizeOptionalString(opts.systemEvent) ?? "";
				const message = normalizeOptionalString(opts.message) ?? "";
				if ([Boolean(systemEvent), Boolean(message)].filter(Boolean).length !== 1) throw new Error("Choose exactly one payload: --system-event or --message");
				if (systemEvent) return {
					kind: "systemEvent",
					text: systemEvent
				};
				const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
				return {
					kind: "agentTurn",
					message,
					model: normalizeOptionalString(opts.model),
					thinking: normalizeOptionalString(opts.thinking),
					timeoutSeconds: timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : void 0,
					lightContext: opts.lightContext === true ? true : void 0,
					toolsAllow: parseCronToolsAllow(opts.tools)
				};
			})();
			const sessionSource = (typeof cmd?.getOptionValueSource === "function" ? (name) => cmd.getOptionValueSource(name) : () => void 0)("session");
			const sessionTargetRaw = normalizeOptionalString(opts.session) ?? "";
			const inferredSessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
			const sessionTarget = sessionSource === "cli" ? normalizeCronSessionTargetOption(sessionTargetRaw) || "" : inferredSessionTarget;
			const isCustomSessionTarget = normalizeLowercaseStringOrEmpty(sessionTarget).startsWith("session:") && Boolean(normalizeOptionalString(sessionTarget.slice(8)));
			const isIsolatedLikeSessionTarget = sessionTarget === "isolated" || sessionTarget === "current" || isCustomSessionTarget;
			if (sessionTarget !== "main" && !isIsolatedLikeSessionTarget) throw new Error("--session must be main, isolated, current, or session:<id>");
			if (opts.deleteAfterRun && opts.keepAfterRun) throw new Error("Choose --delete-after-run or --keep-after-run, not both");
			if (sessionTarget === "main" && payload.kind !== "systemEvent") throw new Error("Main jobs require --system-event (systemEvent).");
			if (isIsolatedLikeSessionTarget && payload.kind !== "agentTurn") throw new Error("Isolated/current/custom-session jobs require --message (agentTurn).");
			if ((opts.announce || typeof opts.deliver === "boolean") && (!isIsolatedLikeSessionTarget || payload.kind !== "agentTurn")) throw new Error("--announce/--no-deliver require a non-main agentTurn session target.");
			const accountId = normalizeOptionalString(opts.account);
			const threadId = parseCronThreadIdOption(opts.threadId);
			if ((accountId || typeof threadId === "number") && (!isIsolatedLikeSessionTarget || payload.kind !== "agentTurn")) throw new Error("--account and --thread-id require a non-main agentTurn job with delivery.");
			const deliveryMode = isIsolatedLikeSessionTarget && payload.kind === "agentTurn" ? hasAnnounce ? "announce" : hasNoDeliver ? "none" : "announce" : void 0;
			const name = normalizeOptionalString(opts.name) ?? "";
			if (!name) throw new Error("Cron job name is required. Pass --name <name>.");
			const description = normalizeOptionalString(opts.description);
			const sessionKey = normalizeOptionalString(opts.sessionKey);
			if (payload.kind === "agentTurn" && !agentId) defaultRuntime.error(theme.warn("No --agent specified; the job will run with the configured default agent. Specify --agent to choose a specific agent."));
			printCronJson(await callGatewayFromCli("cron.add", opts, {
				name,
				description,
				enabled: !opts.disabled,
				deleteAfterRun: opts.deleteAfterRun ? true : opts.keepAfterRun ? false : void 0,
				agentId,
				sessionKey,
				schedule,
				sessionTarget,
				wakeMode,
				payload,
				delivery: deliveryMode ? {
					mode: deliveryMode,
					channel: normalizeOptionalString(opts.channel),
					to: normalizeOptionalString(opts.to),
					threadId,
					accountId,
					bestEffort: opts.bestEffortDeliver ? true : void 0
				} : void 0
			}));
			await warnIfCronSchedulerDisabled(opts);
		} catch (err) {
			handleCronCliError(err);
		}
	}));
}
//#endregion
//#region src/cli/cron-cli/register.cron-edit.ts
const CRON_EDIT_LOOKUP_PAGE_SIZE = 200;
const CRON_EDIT_LOOKUP_MAX_PAGES = 50;
const assignIf = (target, key, value, shouldAssign) => {
	if (shouldAssign) target[key] = value;
};
async function loadCronJobForEditSchedulePatch(opts, id) {
	let offset = 0;
	for (let page = 0; page < CRON_EDIT_LOOKUP_MAX_PAGES; page += 1) {
		const listed = await callGatewayFromCli("cron.list", opts, {
			includeDisabled: true,
			limit: CRON_EDIT_LOOKUP_PAGE_SIZE,
			offset
		});
		const existing = (listed?.jobs ?? []).find((job) => job.id === id);
		if (existing) return existing;
		if (!listed?.hasMore || typeof listed.nextOffset !== "number") return;
		if (listed.nextOffset <= offset) throw new Error("cron.list pagination did not advance while looking up cron job");
		offset = listed.nextOffset;
	}
	throw new Error("cron.list pagination exceeded maximum pages while looking up cron job");
}
function registerCronEditCommand(cron) {
	addGatewayClientOptions(cron.command("edit").description("Edit a cron job (patch fields)").argument("<id>", "Job id").option("--name <name>", "Set name").option("--description <text>", "Set description").option("--enable", "Enable job", false).option("--disable", "Disable job", false).option("--delete-after-run", "Delete one-shot job after it succeeds", false).option("--keep-after-run", "Keep one-shot job after it succeeds", false).option("--session <target>", "Session target (main|isolated)").option("--agent <id>", "Set agent id").option("--clear-agent", "Unset agent and use default", false).option("--session-key <key>", "Set session key for job routing").option("--clear-session-key", "Unset session key", false).option("--wake <mode>", "Wake mode (now|next-heartbeat)").option("--at <when>", "Set one-shot time (ISO) or duration like 20m").option("--every <duration>", "Set interval duration like 10m").option("--cron <expr>", "Set cron expression").option("--tz <iana>", "Timezone for cron expressions (IANA; cron default: Gateway host local timezone)").option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)").option("--exact", "Disable cron staggering (set stagger to 0)").option("--system-event <text>", "Set systemEvent payload").option("--message <text>", "Set agentTurn payload message").option("--thinking <level>", "Thinking level for agent jobs (off|minimal|low|medium|high|xhigh)").option("--model <model>", "Model override for agent jobs").option("--timeout-seconds <n>", "Timeout seconds for agent jobs").option("--light-context", "Enable lightweight bootstrap context for agent jobs").option("--no-light-context", "Disable lightweight bootstrap context for agent jobs").option("--tools <list>", "Tool allow-list (e.g. exec,read,write or exec read write)").option("--clear-tools", "Remove tool allow-list (use all tools)", false).option("--announce", "Fallback-deliver final text to a chat").option("--deliver", "Deprecated (use --announce). Fallback-delivers final text to a chat.").option("--no-deliver", "Disable runner fallback delivery").option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`).option("--to <dest>", "Delivery destination (E.164, Telegram chatId, or Discord channel/user)").option("--thread-id <id>", "Telegram forum topic thread id").option("--account <id>", "Channel account id for delivery (multi-account setups)").option("--best-effort-deliver", "Do not fail job if delivery fails (also implies --announce when used alone)").option("--no-best-effort-deliver", "Fail job when delivery fails").option("--failure-alert", "Enable failure alerts for this job").option("--no-failure-alert", "Disable failure alerts for this job").option("--failure-alert-after <n>", "Alert after N consecutive job errors").option("--failure-alert-channel <channel>", `Failure alert channel (${getCronChannelOptions()})`).option("--failure-alert-to <dest>", "Failure alert destination").option("--failure-alert-cooldown <duration>", "Minimum time between alerts (e.g. 1h, 30m)").option("--failure-alert-include-skipped", "Count consecutive skipped runs toward alerts").option("--failure-alert-exclude-skipped", "Alert only on execution errors").option("--failure-alert-mode <mode>", "Failure alert delivery mode (announce or webhook)").option("--failure-alert-account-id <id>", "Account ID for failure alert channel (multi-account setups)").action(async (id, opts) => {
		try {
			const sessionTarget = typeof opts.session === "string" ? normalizeCronSessionTargetOption(opts.session) : void 0;
			if (typeof opts.session === "string" && !sessionTarget) throw new Error("--session must be main, isolated, current, or session:<id>");
			if (sessionTarget === "main" && opts.message) throw new Error("Main jobs cannot use --message; use --system-event or --session isolated.");
			if ((sessionTarget === "isolated" || sessionTarget === "current" || sessionTarget?.startsWith("session:")) && opts.systemEvent) throw new Error("Isolated jobs cannot use --system-event; use --message or --session main.");
			if (opts.announce && typeof opts.deliver === "boolean") throw new Error("Choose --announce or --no-deliver (not multiple).");
			const patch = {};
			if (typeof opts.name === "string") patch.name = opts.name;
			if (typeof opts.description === "string") patch.description = opts.description;
			if (opts.enable && opts.disable) throw new Error("Choose --enable or --disable, not both");
			if (opts.enable) patch.enabled = true;
			if (opts.disable) patch.enabled = false;
			if (opts.deleteAfterRun && opts.keepAfterRun) throw new Error("Choose --delete-after-run or --keep-after-run, not both");
			if (opts.deleteAfterRun) patch.deleteAfterRun = true;
			if (opts.keepAfterRun) patch.deleteAfterRun = false;
			if (typeof opts.session === "string") patch.sessionTarget = sessionTarget;
			if (typeof opts.wake === "string") patch.wakeMode = opts.wake;
			if (opts.agent && opts.clearAgent) throw new Error("Use --agent or --clear-agent, not both");
			if (typeof opts.agent === "string" && opts.agent.trim()) patch.agentId = sanitizeAgentId(opts.agent.trim());
			if (opts.clearAgent) patch.agentId = null;
			if (opts.sessionKey && opts.clearSessionKey) throw new Error("Use --session-key or --clear-session-key, not both");
			if (typeof opts.sessionKey === "string" && opts.sessionKey.trim()) patch.sessionKey = opts.sessionKey.trim();
			if (opts.clearSessionKey) patch.sessionKey = null;
			const scheduleRequest = resolveCronEditScheduleRequest({
				at: opts.at,
				cron: opts.cron,
				every: opts.every,
				exact: opts.exact,
				stagger: opts.stagger,
				tz: opts.tz
			});
			if (scheduleRequest.kind === "direct") patch.schedule = scheduleRequest.schedule;
			else if (scheduleRequest.kind === "patch-existing-cron") {
				const existing = await loadCronJobForEditSchedulePatch(opts, String(id));
				if (!existing) throw new Error(`unknown cron job id: ${id}`);
				patch.schedule = applyExistingCronSchedulePatch(existing.schedule, scheduleRequest);
			}
			const hasSystemEventPatch = typeof opts.systemEvent === "string";
			const model = normalizeOptionalString(opts.model);
			const thinking = normalizeOptionalString(opts.thinking);
			const toolsAllow = parseCronToolsAllow(opts.tools);
			const timeoutSeconds = opts.timeoutSeconds ? Number.parseInt(String(opts.timeoutSeconds), 10) : void 0;
			const hasTimeoutSeconds = Boolean(timeoutSeconds && Number.isFinite(timeoutSeconds));
			const hasDeliveryModeFlag = opts.announce || typeof opts.deliver === "boolean";
			const threadId = parseCronThreadIdOption(opts.threadId);
			const hasDeliveryThreadId = typeof threadId === "number";
			const hasDeliveryTarget = typeof opts.channel === "string" || typeof opts.to === "string" || hasDeliveryThreadId;
			const hasDeliveryAccount = typeof opts.account === "string";
			const hasBestEffort = typeof opts.bestEffortDeliver === "boolean";
			const hasAgentTurnPatch = typeof opts.message === "string" || Boolean(model) || Boolean(thinking) || hasTimeoutSeconds || typeof opts.lightContext === "boolean" || typeof opts.tools === "string" || Array.isArray(opts.tools) || opts.clearTools || hasDeliveryModeFlag || hasDeliveryTarget || hasDeliveryAccount || hasBestEffort;
			if (hasSystemEventPatch && hasAgentTurnPatch) throw new Error("Choose at most one payload change");
			if (hasSystemEventPatch) patch.payload = {
				kind: "systemEvent",
				text: String(opts.systemEvent)
			};
			else if (hasAgentTurnPatch) {
				const payload = { kind: "agentTurn" };
				assignIf(payload, "message", String(opts.message), typeof opts.message === "string");
				assignIf(payload, "model", model, Boolean(model));
				assignIf(payload, "thinking", thinking, Boolean(thinking));
				assignIf(payload, "timeoutSeconds", timeoutSeconds, hasTimeoutSeconds);
				assignIf(payload, "lightContext", opts.lightContext, typeof opts.lightContext === "boolean");
				if (opts.clearTools) payload.toolsAllow = null;
				else if (toolsAllow) payload.toolsAllow = toolsAllow;
				patch.payload = payload;
			}
			if (hasDeliveryModeFlag || hasDeliveryTarget || hasDeliveryAccount || hasBestEffort) {
				const delivery = {};
				if (hasDeliveryModeFlag) delivery.mode = opts.announce || opts.deliver === true ? "announce" : "none";
				else if (hasBestEffort) delivery.mode = "announce";
				if (typeof opts.channel === "string") {
					const channel = opts.channel.trim();
					delivery.channel = channel ? channel : void 0;
				}
				if (typeof opts.to === "string") {
					const to = opts.to.trim();
					delivery.to = to ? to : void 0;
				}
				if (hasDeliveryThreadId) delivery.threadId = threadId;
				if (typeof opts.account === "string") {
					const account = opts.account.trim();
					delivery.accountId = account ? account : void 0;
				}
				if (typeof opts.bestEffortDeliver === "boolean") delivery.bestEffort = opts.bestEffortDeliver;
				patch.delivery = delivery;
			}
			const hasFailureAlertAfter = typeof opts.failureAlertAfter === "string";
			const hasFailureAlertChannel = typeof opts.failureAlertChannel === "string";
			const hasFailureAlertTo = typeof opts.failureAlertTo === "string";
			const hasFailureAlertCooldown = typeof opts.failureAlertCooldown === "string";
			const hasFailureAlertIncludeSkipped = typeof opts.failureAlertIncludeSkipped === "boolean";
			const hasFailureAlertExcludeSkipped = typeof opts.failureAlertExcludeSkipped === "boolean";
			const hasFailureAlertMode = typeof opts.failureAlertMode === "string";
			const hasFailureAlertAccountId = typeof opts.failureAlertAccountId === "string";
			if (hasFailureAlertIncludeSkipped && hasFailureAlertExcludeSkipped) throw new Error("Use either --failure-alert-include-skipped or --failure-alert-exclude-skipped.");
			const hasFailureAlertFields = hasFailureAlertAfter || hasFailureAlertChannel || hasFailureAlertTo || hasFailureAlertCooldown || hasFailureAlertIncludeSkipped || hasFailureAlertExcludeSkipped || hasFailureAlertMode || hasFailureAlertAccountId;
			const failureAlertFlag = typeof opts.failureAlert === "boolean" ? opts.failureAlert : void 0;
			if (failureAlertFlag === false && hasFailureAlertFields) throw new Error("Use --no-failure-alert alone (without failure-alert-* options).");
			if (failureAlertFlag === false) patch.failureAlert = false;
			else if (failureAlertFlag === true || hasFailureAlertFields) {
				const failureAlert = {};
				if (hasFailureAlertAfter) {
					const after = Number.parseInt(String(opts.failureAlertAfter), 10);
					if (!Number.isFinite(after) || after <= 0) throw new Error("Invalid --failure-alert-after (must be a positive integer).");
					failureAlert.after = after;
				}
				if (hasFailureAlertChannel) failureAlert.channel = normalizeOptionalLowercaseString(opts.failureAlertChannel);
				if (hasFailureAlertTo) {
					const to = normalizeOptionalString(opts.failureAlertTo) ?? "";
					failureAlert.to = to ? to : void 0;
				}
				if (hasFailureAlertCooldown) {
					const cooldownMs = parseDurationMs(String(opts.failureAlertCooldown));
					if (!cooldownMs && cooldownMs !== 0) throw new Error("Invalid --failure-alert-cooldown.");
					failureAlert.cooldownMs = cooldownMs;
				}
				if (hasFailureAlertIncludeSkipped || hasFailureAlertExcludeSkipped) failureAlert.includeSkipped = hasFailureAlertIncludeSkipped;
				if (hasFailureAlertMode) {
					const mode = normalizeOptionalLowercaseString(opts.failureAlertMode);
					if (mode !== "announce" && mode !== "webhook") throw new Error("Invalid --failure-alert-mode (must be 'announce' or 'webhook').");
					failureAlert.mode = mode;
				}
				if (hasFailureAlertAccountId) {
					const accountId = normalizeOptionalString(opts.failureAlertAccountId) ?? "";
					failureAlert.accountId = accountId ? accountId : void 0;
				}
				patch.failureAlert = failureAlert;
			}
			const res = await callGatewayFromCli("cron.update", opts, {
				id,
				patch
			});
			defaultRuntime.writeJson(res);
			await warnIfCronSchedulerDisabled(opts);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
}
//#endregion
//#region src/cli/cron-cli/register.cron-simple.ts
const CRON_SHOW_PAGE_SIZE = 200;
const CRON_SHOW_LOOKUP_MAX_PAGES = 50;
const CRON_RUN_WAIT_TIMEOUT_DEFAULT = "10m";
const CRON_RUN_WAIT_POLL_INTERVAL_DEFAULT = "2s";
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseCronRunWaitDuration(raw, label) {
	const durationMs = parseDurationMs$1(typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint" ? String(raw) : "", { defaultUnit: "ms" });
	if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error(`invalid ${label}`);
	return durationMs;
}
function parseCronRunPollInterval(raw) {
	const durationMs = parseCronRunWaitDuration(raw, "--poll-interval");
	if (durationMs <= 0) throw new Error("invalid --poll-interval");
	return durationMs;
}
async function waitForCronRunCompletion(params) {
	const startedAt = Date.now();
	for (;;) {
		const entry = (await callGatewayFromCli("cron.runs", params.opts, {
			id: params.jobId,
			runId: params.runId,
			limit: 1
		})).entries?.[0];
		if (entry?.status === "ok" || entry?.status === "error" || entry?.status === "skipped") return entry;
		if (Date.now() - startedAt >= params.timeoutMs) throw new Error(`timed out waiting for cron run ${params.runId}`);
		await sleep(params.pollIntervalMs);
	}
}
function findCronJobInPage(jobs, idOrName) {
	const needle = normalizeLowercaseStringOrEmpty(idOrName);
	return jobs.find((job) => normalizeLowercaseStringOrEmpty(job.id) === needle || normalizeLowercaseStringOrEmpty(job.name) === needle);
}
async function loadCronJobForShow(opts, idOrName) {
	let offset = 0;
	for (let page = 0; page < CRON_SHOW_LOOKUP_MAX_PAGES; page += 1) {
		const res = await callGatewayFromCli("cron.list", opts, {
			includeDisabled: true,
			limit: CRON_SHOW_PAGE_SIZE,
			offset
		});
		const listed = res;
		const job = findCronJobInPage(listed.jobs ?? [], idOrName);
		if (job) return {
			job,
			deliveryPreview: coerceCronDeliveryPreviews(res).get(job.id)
		};
		if (!listed.hasMore || typeof listed.nextOffset !== "number") return {};
		if (listed.nextOffset <= offset) throw new Error("cron.list pagination did not advance while looking up cron job");
		offset = listed.nextOffset;
	}
	throw new Error("cron.list pagination exceeded maximum pages while looking up cron job");
}
function registerCronToggleCommand(params) {
	addGatewayClientOptions(params.cron.command(params.name).description(params.description).argument("<id>", "Job id").action(async (id, opts) => {
		try {
			printCronJson(await callGatewayFromCli("cron.update", opts, {
				id,
				patch: { enabled: params.enabled }
			}));
			await warnIfCronSchedulerDisabled(opts);
		} catch (err) {
			handleCronCliError(err);
		}
	}));
}
function registerCronSimpleCommands(cron) {
	addGatewayClientOptions(cron.command("rm").alias("remove").alias("delete").description("Remove a cron job").argument("<id>", "Job id").option("--json", "Output JSON", false).action(async (id, opts) => {
		try {
			printCronJson(await callGatewayFromCli("cron.remove", opts, { id }));
		} catch (err) {
			handleCronCliError(err);
		}
	}));
	registerCronToggleCommand({
		cron,
		name: "enable",
		description: "Enable a cron job",
		enabled: true
	});
	registerCronToggleCommand({
		cron,
		name: "disable",
		description: "Disable a cron job",
		enabled: false
	});
	addGatewayClientOptions(cron.command("get").description("Get a cron job as JSON").argument("<id>", "Job id").action(async (id, opts) => {
		try {
			printCronJson(await callGatewayFromCli("cron.get", opts, { id: String(id) }));
		} catch (err) {
			handleCronCliError(err);
		}
	}));
	addGatewayClientOptions(cron.command("show").description("Show a cron job").argument("<id>", "Job id or exact name").option("--json", "Output JSON", false).action(async (id, opts) => {
		try {
			const { job, deliveryPreview } = await loadCronJobForShow(opts, String(id));
			if (!job) throw new Error(`cron job not found: ${String(id)}`);
			if (opts.json) {
				printCronJson(enrichCronJsonWithStatus(job));
				return;
			}
			printCronShow(job, defaultRuntime, { deliveryPreview });
		} catch (err) {
			handleCronCliError(err);
		}
	}));
	addGatewayClientOptions(cron.command("runs").description("Show cron run history (JSONL-backed)").requiredOption("--id <id>", "Job id").option("--run-id <runId>", "Filter by cron run id").option("--limit <n>", "Max entries (default 50)", "50").action(async (opts) => {
		try {
			const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
			const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
			printCronJson(await callGatewayFromCli("cron.runs", opts, {
				id: String(opts.id),
				...typeof opts.runId === "string" && opts.runId.trim() ? { runId: opts.runId } : {},
				limit
			}));
		} catch (err) {
			handleCronCliError(err);
		}
	}));
	addGatewayClientOptions(cron.command("run").description("Run a cron job now (debug)").argument("<id>", "Job id").option("--due", "Run only when due (default behavior in older versions)", false).option("--wait", "Wait for the queued run to finish", false).option("--wait-timeout <duration>", "Maximum time to wait for --wait", CRON_RUN_WAIT_TIMEOUT_DEFAULT).option("--poll-interval <duration>", "Polling interval for --wait", CRON_RUN_WAIT_POLL_INTERVAL_DEFAULT).action(async (id, opts, command) => {
		try {
			let waitTimeoutMs = 0;
			let pollIntervalMs = 0;
			if (opts.wait) {
				waitTimeoutMs = parseCronRunWaitDuration(opts.waitTimeout, "--wait-timeout");
				pollIntervalMs = parseCronRunPollInterval(opts.pollInterval);
			}
			if (command.getOptionValueSource("timeout") === "default") opts.timeout = "600000";
			const res = await callGatewayFromCli("cron.run", opts, {
				id,
				mode: opts.due ? "due" : "force"
			});
			const result = res;
			if (opts.wait && result?.ok && result.enqueued) {
				if (!result.runId) throw new Error("cron run did not return a runId to wait for");
				const run = await waitForCronRunCompletion({
					opts,
					jobId: String(id),
					runId: result.runId,
					timeoutMs: waitTimeoutMs,
					pollIntervalMs
				});
				printCronJson({
					...res,
					completed: true,
					status: run.status,
					run
				});
				defaultRuntime.exit(run.status === "ok" ? 0 : 1);
				return;
			}
			printCronJson(res);
			defaultRuntime.exit(result?.ok && (result?.ran || result?.enqueued) ? 0 : 1);
		} catch (err) {
			handleCronCliError(err);
		}
	}));
}
//#endregion
//#region src/cli/cron-cli/register.ts
function registerCronCli(program) {
	const cron = program.command("cron").description("Manage cron jobs (via Gateway)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/cron", "docs.openclaw.ai/cli/cron")}\n${theme.muted("Upgrade tip:")} run \`openclaw doctor --fix\` to normalize legacy cron job storage.\n`);
	registerCronStatusCommand(cron);
	registerCronListCommand(cron);
	registerCronAddCommand(cron);
	registerCronSimpleCommands(cron);
	registerCronEditCommand(cron);
	applyParentDefaultHelpAction(cron);
}
//#endregion
export { registerCronCli };
