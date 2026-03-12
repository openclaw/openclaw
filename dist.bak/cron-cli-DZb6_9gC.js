import { Dt as isRich, Et as colorize, Ot as theme, gt as danger, v as defaultRuntime } from "./entry.js";
import "./auth-profiles-D6H-HVV8.js";
import "./agent-scope-C2k6BQnt.js";
import { d as sanitizeAgentId } from "./session-key-qmb11-mH.js";
import "./openclaw-root-C9tYgTzw.js";
import "./exec-BhaMholX.js";
import "./github-copilot-token-DKRiM6oj.js";
import "./host-env-security-BM8ktVlo.js";
import "./env-vars-DPtuUD7z.js";
import "./manifest-registry-HLdbjiS7.js";
import "./message-channel-CJUwnCYd.js";
import { n as listChannelPlugins } from "./plugins-BOmV0yTv.js";
import "./accounts-jTTYYc3C.js";
import "./bindings-DcFNU_QL.js";
import "./logging-Cr3Gsq0-.js";
import "./client-C2kv9X_7.js";
import "./call-D6IYi30Z.js";
import "./pairing-token-DzfCmsrM.js";
import "./net-DBrsyv8q.js";
import "./ip-BDxIP8rd.js";
import "./tailnet-Ca1WnFBq.js";
import { n as formatDurationHuman } from "./format-duration-BynaIN4v.js";
import { i as parseAbsoluteTimeMs, n as resolveCronStaggerMs } from "./stagger-BJGKxryR.js";
import { t as formatDocsLink } from "./links-yQMT2QcX.js";
import "./progress-bvyZjsUc.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-BHrtynWc.js";
import { n as parsePositiveIntOrUndefined } from "./helpers-DzjyyYL4.js";

//#region src/cli/cron-cli/shared.ts
const getCronChannelOptions = () => ["last", ...listChannelPlugins().map((plugin) => plugin.id)].join("|");
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
	const unit = (match[2] ?? "").toLowerCase();
	const factor = unit === "ms" ? 1 : unit === "s" ? 1e3 : unit === "m" ? 6e4 : unit === "h" ? 36e5 : 864e5;
	return Math.floor(n * factor);
}
function parseAt(input) {
	const raw = input.trim();
	if (!raw) return null;
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
const CRON_AGENT_PAD = 10;
const CRON_MODEL_PAD = 20;
const pad = (value, width) => value.padEnd(width);
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
	if (schedule.kind === "at") return `at ${formatIsoMinute(schedule.at)}`;
	if (schedule.kind === "every") return `every ${formatDurationHuman(schedule.everyMs)}`;
	const base = schedule.tz ? `cron ${schedule.expr} @ ${schedule.tz}` : `cron ${schedule.expr}`;
	const staggerMs = resolveCronStaggerMs(schedule);
	if (staggerMs <= 0) return `${base} (exact)`;
	return `${base} (stagger ${formatDurationHuman(staggerMs)})`;
};
const formatStatus = (job) => {
	if (!job.enabled) return "disabled";
	if (job.state.runningAtMs) return "running";
	return job.state.lastStatus ?? "idle";
};
function printCronList(jobs, runtime = defaultRuntime) {
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
		pad("Agent ID", CRON_AGENT_PAD),
		pad("Model", CRON_MODEL_PAD)
	].join(" ");
	runtime.log(rich ? theme.heading(header) : header);
	const now = Date.now();
	for (const job of jobs) {
		const idLabel = pad(job.id, CRON_ID_PAD);
		const nameLabel = pad(truncate(job.name, CRON_NAME_PAD), CRON_NAME_PAD);
		const scheduleLabel = pad(truncate(formatSchedule(job.schedule), CRON_SCHEDULE_PAD), CRON_SCHEDULE_PAD);
		const nextLabel = pad(job.enabled ? formatRelative(job.state.nextRunAtMs, now) : "-", CRON_NEXT_PAD);
		const lastLabel = pad(formatRelative(job.state.lastRunAtMs, now), CRON_LAST_PAD);
		const statusRaw = formatStatus(job);
		const statusLabel = pad(statusRaw, CRON_STATUS_PAD);
		const targetLabel = pad(job.sessionTarget ?? "-", CRON_TARGET_PAD);
		const agentLabel = pad(truncate(job.agentId ?? "-", CRON_AGENT_PAD), CRON_AGENT_PAD);
		const modelLabel = pad(truncate((job.payload.kind === "agentTurn" ? job.payload.model : void 0) ?? "-", CRON_MODEL_PAD), CRON_MODEL_PAD);
		const coloredStatus = (() => {
			if (statusRaw === "ok") return colorize(rich, theme.success, statusLabel);
			if (statusRaw === "error") return colorize(rich, theme.error, statusLabel);
			if (statusRaw === "running") return colorize(rich, theme.warn, statusLabel);
			if (statusRaw === "skipped") return colorize(rich, theme.muted, statusLabel);
			return colorize(rich, theme.muted, statusLabel);
		})();
		const coloredTarget = job.sessionTarget === "isolated" ? colorize(rich, theme.accentBright, targetLabel) : colorize(rich, theme.accent, targetLabel);
		const coloredAgent = job.agentId ? colorize(rich, theme.info, agentLabel) : colorize(rich, theme.muted, agentLabel);
		const line = [
			colorize(rich, theme.accent, idLabel),
			colorize(rich, theme.info, nameLabel),
			colorize(rich, theme.info, scheduleLabel),
			colorize(rich, theme.muted, nextLabel),
			colorize(rich, theme.muted, lastLabel),
			coloredStatus,
			coloredTarget,
			coloredAgent,
			job.payload.kind === "agentTurn" && job.payload.model ? colorize(rich, theme.info, modelLabel) : colorize(rich, theme.muted, modelLabel)
		].join(" ");
		runtime.log(line.trimEnd());
	}
}

//#endregion
//#region src/cli/cron-cli/register.cron-add.ts
function registerCronStatusCommand(cron) {
	addGatewayClientOptions(cron.command("status").description("Show cron scheduler status").option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const res = await callGatewayFromCli("cron.status", opts, {});
			defaultRuntime.log(JSON.stringify(res, null, 2));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
}
function registerCronListCommand(cron) {
	addGatewayClientOptions(cron.command("list").description("List cron jobs").option("--all", "Include disabled jobs", false).option("--json", "Output JSON", false).action(async (opts) => {
		try {
			const res = await callGatewayFromCli("cron.list", opts, { includeDisabled: Boolean(opts.all) });
			if (opts.json) {
				defaultRuntime.log(JSON.stringify(res, null, 2));
				return;
			}
			printCronList(res?.jobs ?? [], defaultRuntime);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
}
function registerCronAddCommand(cron) {
	addGatewayClientOptions(cron.command("add").alias("create").description("Add a cron job").requiredOption("--name <name>", "Job name").option("--description <text>", "Optional description").option("--disabled", "Create job disabled", false).option("--delete-after-run", "Delete one-shot job after it succeeds", false).option("--keep-after-run", "Keep one-shot job after it succeeds", false).option("--agent <id>", "Agent id for this job").option("--session <target>", "Session target (main|isolated)").option("--session-key <key>", "Session key for job routing (e.g. agent:my-agent:my-session)").option("--wake <mode>", "Wake mode (now|next-heartbeat)", "now").option("--at <when>", "Run once at time (ISO) or +duration (e.g. 20m)").option("--every <duration>", "Run every duration (e.g. 10m, 1h)").option("--cron <expr>", "Cron expression (5-field or 6-field with seconds)").option("--tz <iana>", "Timezone for cron expressions (IANA)", "").option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)").option("--exact", "Disable cron staggering (set stagger to 0)", false).option("--system-event <text>", "System event payload (main session)").option("--message <text>", "Agent message payload").option("--thinking <level>", "Thinking level for agent jobs (off|minimal|low|medium|high)").option("--model <model>", "Model override for agent jobs (provider/model or alias)").option("--timeout-seconds <n>", "Timeout seconds for agent jobs").option("--announce", "Announce summary to a chat (subagent-style)", false).option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.").option("--no-deliver", "Disable announce delivery and skip main-session summary").option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last").option("--to <dest>", "Delivery destination (E.164, Telegram chatId, or Discord channel/user)").option("--account <id>", "Channel account id for delivery (multi-account setups)").option("--best-effort-deliver", "Do not fail the job if delivery fails", false).option("--json", "Output JSON", false).action(async (opts, cmd) => {
		try {
			const staggerRaw = typeof opts.stagger === "string" ? opts.stagger.trim() : "";
			const useExact = Boolean(opts.exact);
			if (staggerRaw && useExact) throw new Error("Choose either --stagger or --exact, not both");
			const schedule = (() => {
				const at = typeof opts.at === "string" ? opts.at : "";
				const every = typeof opts.every === "string" ? opts.every : "";
				const cronExpr = typeof opts.cron === "string" ? opts.cron : "";
				if ([
					Boolean(at),
					Boolean(every),
					Boolean(cronExpr)
				].filter(Boolean).length !== 1) throw new Error("Choose exactly one schedule: --at, --every, or --cron");
				if ((useExact || staggerRaw) && !cronExpr) throw new Error("--stagger/--exact are only valid with --cron");
				if (at) {
					const atIso = parseAt(at);
					if (!atIso) throw new Error("Invalid --at; use ISO time or duration like 20m");
					return {
						kind: "at",
						at: atIso
					};
				}
				if (every) {
					const everyMs = parseDurationMs(every);
					if (!everyMs) throw new Error("Invalid --every; use e.g. 10m, 1h, 1d");
					return {
						kind: "every",
						everyMs
					};
				}
				const staggerMs = (() => {
					if (useExact) return 0;
					if (!staggerRaw) return;
					const parsed = parseDurationMs(staggerRaw);
					if (!parsed) throw new Error("Invalid --stagger; use e.g. 30s, 1m, 5m");
					return parsed;
				})();
				return {
					kind: "cron",
					expr: cronExpr,
					tz: typeof opts.tz === "string" && opts.tz.trim() ? opts.tz.trim() : void 0,
					staggerMs
				};
			})();
			const wakeMode = (typeof opts.wake === "string" ? opts.wake : "now").trim() || "now";
			if (wakeMode !== "now" && wakeMode !== "next-heartbeat") throw new Error("--wake must be now or next-heartbeat");
			const agentId = typeof opts.agent === "string" && opts.agent.trim() ? sanitizeAgentId(opts.agent.trim()) : void 0;
			const hasAnnounce = Boolean(opts.announce) || opts.deliver === true;
			const hasNoDeliver = opts.deliver === false;
			if ([hasAnnounce, hasNoDeliver].filter(Boolean).length > 1) throw new Error("Choose at most one of --announce or --no-deliver");
			const payload = (() => {
				const systemEvent = typeof opts.systemEvent === "string" ? opts.systemEvent.trim() : "";
				const message = typeof opts.message === "string" ? opts.message.trim() : "";
				if ([Boolean(systemEvent), Boolean(message)].filter(Boolean).length !== 1) throw new Error("Choose exactly one payload: --system-event or --message");
				if (systemEvent) return {
					kind: "systemEvent",
					text: systemEvent
				};
				const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
				return {
					kind: "agentTurn",
					message,
					model: typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : void 0,
					thinking: typeof opts.thinking === "string" && opts.thinking.trim() ? opts.thinking.trim() : void 0,
					timeoutSeconds: timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : void 0
				};
			})();
			const sessionSource = (typeof cmd?.getOptionValueSource === "function" ? (name) => cmd.getOptionValueSource(name) : () => void 0)("session");
			const sessionTargetRaw = typeof opts.session === "string" ? opts.session.trim() : "";
			const inferredSessionTarget = payload.kind === "agentTurn" ? "isolated" : "main";
			const sessionTarget = sessionSource === "cli" ? sessionTargetRaw || "" : inferredSessionTarget;
			if (sessionTarget !== "main" && sessionTarget !== "isolated") throw new Error("--session must be main or isolated");
			if (opts.deleteAfterRun && opts.keepAfterRun) throw new Error("Choose --delete-after-run or --keep-after-run, not both");
			if (sessionTarget === "main" && payload.kind !== "systemEvent") throw new Error("Main jobs require --system-event (systemEvent).");
			if (sessionTarget === "isolated" && payload.kind !== "agentTurn") throw new Error("Isolated jobs require --message (agentTurn).");
			if ((opts.announce || typeof opts.deliver === "boolean") && (sessionTarget !== "isolated" || payload.kind !== "agentTurn")) throw new Error("--announce/--no-deliver require --session isolated.");
			const accountId = typeof opts.account === "string" && opts.account.trim() ? opts.account.trim() : void 0;
			if (accountId && (sessionTarget !== "isolated" || payload.kind !== "agentTurn")) throw new Error("--account requires an isolated agentTurn job with delivery.");
			const deliveryMode = sessionTarget === "isolated" && payload.kind === "agentTurn" ? hasAnnounce ? "announce" : hasNoDeliver ? "none" : "announce" : void 0;
			const name = (typeof opts.name === "string" ? opts.name : "").trim();
			if (!name) throw new Error("--name is required");
			const description = typeof opts.description === "string" && opts.description.trim() ? opts.description.trim() : void 0;
			const sessionKey = typeof opts.sessionKey === "string" && opts.sessionKey.trim() ? opts.sessionKey.trim() : void 0;
			const res = await callGatewayFromCli("cron.add", opts, {
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
					channel: typeof opts.channel === "string" && opts.channel.trim() ? opts.channel.trim() : void 0,
					to: typeof opts.to === "string" && opts.to.trim() ? opts.to.trim() : void 0,
					accountId,
					bestEffort: opts.bestEffortDeliver ? true : void 0
				} : void 0
			});
			defaultRuntime.log(JSON.stringify(res, null, 2));
			await warnIfCronSchedulerDisabled(opts);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
}

//#endregion
//#region src/cli/cron-cli/register.cron-edit.ts
const assignIf = (target, key, value, shouldAssign) => {
	if (shouldAssign) target[key] = value;
};
function registerCronEditCommand(cron) {
	addGatewayClientOptions(cron.command("edit").description("Edit a cron job (patch fields)").argument("<id>", "Job id").option("--name <name>", "Set name").option("--description <text>", "Set description").option("--enable", "Enable job", false).option("--disable", "Disable job", false).option("--delete-after-run", "Delete one-shot job after it succeeds", false).option("--keep-after-run", "Keep one-shot job after it succeeds", false).option("--session <target>", "Session target (main|isolated)").option("--agent <id>", "Set agent id").option("--clear-agent", "Unset agent and use default", false).option("--session-key <key>", "Set session key for job routing").option("--clear-session-key", "Unset session key", false).option("--wake <mode>", "Wake mode (now|next-heartbeat)").option("--at <when>", "Set one-shot time (ISO) or duration like 20m").option("--every <duration>", "Set interval duration like 10m").option("--cron <expr>", "Set cron expression").option("--tz <iana>", "Timezone for cron expressions (IANA)").option("--stagger <duration>", "Cron stagger window (e.g. 30s, 5m)").option("--exact", "Disable cron staggering (set stagger to 0)").option("--system-event <text>", "Set systemEvent payload").option("--message <text>", "Set agentTurn payload message").option("--thinking <level>", "Thinking level for agent jobs").option("--model <model>", "Model override for agent jobs").option("--timeout-seconds <n>", "Timeout seconds for agent jobs").option("--announce", "Announce summary to a chat (subagent-style)").option("--deliver", "Deprecated (use --announce). Announces a summary to a chat.").option("--no-deliver", "Disable announce delivery").option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`).option("--to <dest>", "Delivery destination (E.164, Telegram chatId, or Discord channel/user)").option("--account <id>", "Channel account id for delivery (multi-account setups)").option("--best-effort-deliver", "Do not fail job if delivery fails").option("--no-best-effort-deliver", "Fail job when delivery fails").action(async (id, opts) => {
		try {
			if (opts.session === "main" && opts.message) throw new Error("Main jobs cannot use --message; use --system-event or --session isolated.");
			if (opts.session === "isolated" && opts.systemEvent) throw new Error("Isolated jobs cannot use --system-event; use --message or --session main.");
			if (opts.announce && typeof opts.deliver === "boolean") throw new Error("Choose --announce or --no-deliver (not multiple).");
			const staggerRaw = typeof opts.stagger === "string" ? opts.stagger.trim() : "";
			const useExact = Boolean(opts.exact);
			if (staggerRaw && useExact) throw new Error("Choose either --stagger or --exact, not both");
			const requestedStaggerMs = (() => {
				if (useExact) return 0;
				if (!staggerRaw) return;
				const parsed = parseDurationMs(staggerRaw);
				if (!parsed) throw new Error("Invalid --stagger; use e.g. 30s, 1m, 5m");
				return parsed;
			})();
			const patch = {};
			if (typeof opts.name === "string") patch.name = opts.name;
			if (typeof opts.description === "string") patch.description = opts.description;
			if (opts.enable && opts.disable) throw new Error("Choose --enable or --disable, not both");
			if (opts.enable) patch.enabled = true;
			if (opts.disable) patch.enabled = false;
			if (opts.deleteAfterRun && opts.keepAfterRun) throw new Error("Choose --delete-after-run or --keep-after-run, not both");
			if (opts.deleteAfterRun) patch.deleteAfterRun = true;
			if (opts.keepAfterRun) patch.deleteAfterRun = false;
			if (typeof opts.session === "string") patch.sessionTarget = opts.session;
			if (typeof opts.wake === "string") patch.wakeMode = opts.wake;
			if (opts.agent && opts.clearAgent) throw new Error("Use --agent or --clear-agent, not both");
			if (typeof opts.agent === "string" && opts.agent.trim()) patch.agentId = sanitizeAgentId(opts.agent.trim());
			if (opts.clearAgent) patch.agentId = null;
			if (opts.sessionKey && opts.clearSessionKey) throw new Error("Use --session-key or --clear-session-key, not both");
			if (typeof opts.sessionKey === "string" && opts.sessionKey.trim()) patch.sessionKey = opts.sessionKey.trim();
			if (opts.clearSessionKey) patch.sessionKey = null;
			if ([
				opts.at,
				opts.every,
				opts.cron
			].filter(Boolean).length > 1) throw new Error("Choose at most one schedule change");
			if ((requestedStaggerMs !== void 0 || typeof opts.tz === "string") && (opts.at || opts.every)) throw new Error("--stagger/--exact/--tz are only valid for cron schedules");
			if (opts.at) {
				const atIso = parseAt(String(opts.at));
				if (!atIso) throw new Error("Invalid --at");
				patch.schedule = {
					kind: "at",
					at: atIso
				};
			} else if (opts.every) {
				const everyMs = parseDurationMs(String(opts.every));
				if (!everyMs) throw new Error("Invalid --every");
				patch.schedule = {
					kind: "every",
					everyMs
				};
			} else if (opts.cron) patch.schedule = {
				kind: "cron",
				expr: String(opts.cron),
				tz: typeof opts.tz === "string" && opts.tz.trim() ? opts.tz.trim() : void 0,
				staggerMs: requestedStaggerMs
			};
			else if (requestedStaggerMs !== void 0 || typeof opts.tz === "string") {
				const existing = ((await callGatewayFromCli("cron.list", opts, { includeDisabled: true }))?.jobs ?? []).find((job) => job.id === id);
				if (!existing) throw new Error(`unknown cron job id: ${id}`);
				if (existing.schedule.kind !== "cron") throw new Error("Current job is not a cron schedule; use --cron to convert first");
				const tz = typeof opts.tz === "string" ? opts.tz.trim() || void 0 : existing.schedule.tz;
				patch.schedule = {
					kind: "cron",
					expr: existing.schedule.expr,
					tz,
					staggerMs: requestedStaggerMs !== void 0 ? requestedStaggerMs : existing.schedule.staggerMs
				};
			}
			const hasSystemEventPatch = typeof opts.systemEvent === "string";
			const model = typeof opts.model === "string" && opts.model.trim() ? opts.model.trim() : void 0;
			const thinking = typeof opts.thinking === "string" && opts.thinking.trim() ? opts.thinking.trim() : void 0;
			const timeoutSeconds = opts.timeoutSeconds ? Number.parseInt(String(opts.timeoutSeconds), 10) : void 0;
			const hasTimeoutSeconds = Boolean(timeoutSeconds && Number.isFinite(timeoutSeconds));
			const hasDeliveryModeFlag = opts.announce || typeof opts.deliver === "boolean";
			const hasDeliveryTarget = typeof opts.channel === "string" || typeof opts.to === "string";
			const hasDeliveryAccount = typeof opts.account === "string";
			const hasBestEffort = typeof opts.bestEffortDeliver === "boolean";
			const hasAgentTurnPatch = typeof opts.message === "string" || Boolean(model) || Boolean(thinking) || hasTimeoutSeconds || hasDeliveryModeFlag || hasDeliveryTarget || hasDeliveryAccount || hasBestEffort;
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
				if (typeof opts.account === "string") {
					const account = opts.account.trim();
					delivery.accountId = account ? account : void 0;
				}
				if (typeof opts.bestEffortDeliver === "boolean") delivery.bestEffort = opts.bestEffortDeliver;
				patch.delivery = delivery;
			}
			const res = await callGatewayFromCli("cron.update", opts, {
				id,
				patch
			});
			defaultRuntime.log(JSON.stringify(res, null, 2));
			await warnIfCronSchedulerDisabled(opts);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
}

//#endregion
//#region src/cli/cron-cli/register.cron-simple.ts
function registerCronToggleCommand(params) {
	addGatewayClientOptions(params.cron.command(params.name).description(params.description).argument("<id>", "Job id").action(async (id, opts) => {
		try {
			const res = await callGatewayFromCli("cron.update", opts, {
				id,
				patch: { enabled: params.enabled }
			});
			defaultRuntime.log(JSON.stringify(res, null, 2));
			await warnIfCronSchedulerDisabled(opts);
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
}
function registerCronSimpleCommands(cron) {
	addGatewayClientOptions(cron.command("rm").alias("remove").alias("delete").description("Remove a cron job").argument("<id>", "Job id").option("--json", "Output JSON", false).action(async (id, opts) => {
		try {
			const res = await callGatewayFromCli("cron.remove", opts, { id });
			defaultRuntime.log(JSON.stringify(res, null, 2));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
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
	addGatewayClientOptions(cron.command("runs").description("Show cron run history (JSONL-backed)").requiredOption("--id <id>", "Job id").option("--limit <n>", "Max entries (default 50)", "50").action(async (opts) => {
		try {
			const limitRaw = Number.parseInt(String(opts.limit ?? "50"), 10);
			const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;
			const res = await callGatewayFromCli("cron.runs", opts, {
				id: String(opts.id),
				limit
			});
			defaultRuntime.log(JSON.stringify(res, null, 2));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
	addGatewayClientOptions(cron.command("run").description("Run a cron job now (debug)").argument("<id>", "Job id").option("--due", "Run only when due (default behavior in older versions)", false).action(async (id, opts) => {
		try {
			const res = await callGatewayFromCli("cron.run", opts, {
				id,
				mode: opts.due ? "due" : "force"
			});
			defaultRuntime.log(JSON.stringify(res, null, 2));
		} catch (err) {
			defaultRuntime.error(danger(String(err)));
			defaultRuntime.exit(1);
		}
	}));
}

//#endregion
//#region src/cli/cron-cli/register.ts
function registerCronCli(program) {
	const cron = program.command("cron").description("Manage cron jobs (via Gateway)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/cron", "docs.openclaw.ai/cli/cron")}\n`);
	registerCronStatusCommand(cron);
	registerCronListCommand(cron);
	registerCronAddCommand(cron);
	registerCronSimpleCommands(cron);
	registerCronEditCommand(cron);
}

//#endregion
export { registerCronCli };