import { y as resolveStateDir } from "../paths-Cw7f9XhU.js";
import { l as normalizeAgentId } from "../session-key-Bte0mmcq.js";
import { m as writeJson, o as tryReadJson } from "../json-files-C2hqjU--.js";
import { a as parseCrestodianOperation, i as isPersistentCrestodianOperation, n as executeCrestodianOperation, r as formatCrestodianPersistentPlan } from "../operations-Bw7QWTg3.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
//#region src/crestodian/rescue-policy.ts
function resolvePendingTtlMinutes(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 15;
}
function resolveAgentEntry(cfg, agentId) {
	if (!agentId) return;
	const id = normalizeAgentId(agentId);
	return cfg.agents?.list?.find((entry) => entry !== null && typeof entry === "object" && normalizeAgentId(entry.id) === id);
}
function resolveScopedExecConfig(cfg, agentId) {
	return resolveAgentEntry(cfg, agentId)?.tools?.exec;
}
function resolveScopedSandboxMode(cfg, agentId) {
	return resolveAgentEntry(cfg, agentId)?.sandbox?.mode ?? cfg.agents?.defaults?.sandbox?.mode ?? "off";
}
function isYoloHostPosture(cfg, agentId) {
	const scopedExec = resolveScopedExecConfig(cfg, agentId);
	const globalExec = cfg.tools?.exec;
	const security = scopedExec?.security ?? globalExec?.security ?? "full";
	const ask = scopedExec?.ask ?? globalExec?.ask ?? "off";
	return security === "full" && ask === "off";
}
function resolveCrestodianRescuePolicy(input) {
	const rescue = input.cfg.crestodian?.rescue;
	const configuredEnabled = rescue?.enabled ?? "auto";
	const ownerDmOnly = rescue?.ownerDmOnly ?? true;
	const pendingTtlMinutes = resolvePendingTtlMinutes(rescue?.pendingTtlMinutes);
	const sandboxActive = resolveScopedSandboxMode(input.cfg, input.agentId) !== "off";
	const yolo = !sandboxActive && isYoloHostPosture(input.cfg, input.agentId);
	const enabled = configuredEnabled === "auto" ? yolo : configuredEnabled;
	if (!enabled) return {
		allowed: false,
		enabled,
		ownerDmOnly,
		pendingTtlMinutes,
		yolo,
		sandboxActive,
		reason: "disabled",
		message: "Crestodian rescue is disabled. Set crestodian.rescue.enabled=true or use YOLO host posture with sandboxing off."
	};
	if (sandboxActive) return {
		allowed: false,
		enabled,
		ownerDmOnly,
		pendingTtlMinutes,
		yolo,
		sandboxActive,
		reason: "sandbox-active",
		message: "Crestodian rescue is blocked because OpenClaw sandboxing is active. Fix the install locally or disable sandboxing before using remote rescue."
	};
	if (configuredEnabled === "auto" && !yolo) return {
		allowed: false,
		enabled,
		ownerDmOnly,
		pendingTtlMinutes,
		yolo,
		sandboxActive,
		reason: "not-yolo",
		message: "Crestodian rescue auto-mode only opens in YOLO host posture: tools.exec.security=full, tools.exec.ask=off, and sandboxing off."
	};
	if (!input.senderIsOwner) return {
		allowed: false,
		enabled,
		ownerDmOnly,
		pendingTtlMinutes,
		yolo,
		sandboxActive,
		reason: "not-owner",
		message: "Crestodian rescue only accepts commands from an OpenClaw owner."
	};
	if (ownerDmOnly && !input.isDirectMessage) return {
		allowed: false,
		enabled,
		ownerDmOnly,
		pendingTtlMinutes,
		yolo,
		sandboxActive,
		reason: "not-direct-message",
		message: "Crestodian rescue is restricted to owner DMs by default."
	};
	return {
		allowed: true,
		enabled: true,
		ownerDmOnly,
		pendingTtlMinutes,
		yolo: true,
		sandboxActive: false
	};
}
//#endregion
//#region src/crestodian/rescue-message.ts
const CRESTODIAN_COMMAND = "/crestodian";
const APPROVAL_RE = /^(yes|y|apply|approve|approved|do it)$/i;
function createCaptureRuntime() {
	const lines = [];
	const push = (...args) => {
		lines.push(args.map((arg) => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" "));
	};
	return {
		runtime: {
			log: push,
			error: push,
			exit: (code) => {
				throw new Error(`Crestodian operation exited with code ${code}`);
			}
		},
		read: () => lines.join("\n").trim()
	};
}
function extractCrestodianRescueMessage(commandBody) {
	const normalized = commandBody.trim();
	const lower = normalized.toLowerCase();
	if (lower !== CRESTODIAN_COMMAND && !lower.startsWith(`${CRESTODIAN_COMMAND} `)) return null;
	return normalized.slice(11).trim();
}
function resolvePendingDir(env = process.env) {
	return path.join(resolveStateDir(env), "crestodian", "rescue-pending");
}
function resolvePendingPath(input) {
	const key = JSON.stringify({
		channel: input.command.channelId ?? input.command.channel,
		from: input.command.from,
		senderId: input.command.senderId
	});
	const digest = createHash("sha256").update(key).digest("hex").slice(0, 32);
	return path.join(resolvePendingDir(input.env), `${digest}.json`);
}
async function readPending(pendingPath, now = /* @__PURE__ */ new Date()) {
	try {
		const parsed = await tryReadJson(pendingPath);
		if (!parsed) return null;
		if (Date.parse(parsed.expiresAt) <= now.getTime()) {
			await fs.rm(pendingPath, { force: true });
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}
async function writePending(pendingPath, pending) {
	await writeJson(pendingPath, pending, {
		dirMode: 448,
		mode: 384,
		trailingNewline: true
	});
}
function buildAuditDetails(input) {
	return {
		rescue: true,
		channel: input.command.channelId ?? input.command.channel,
		accountId: input.command.to,
		senderId: input.command.senderId,
		from: input.command.from
	};
}
function formatPersistentPlan(operation) {
	return formatCrestodianPersistentPlan(operation).replace("Say yes to apply.", "Reply /crestodian yes to apply.");
}
function formatUnsupportedRemoteOperation(operation) {
	if (operation.kind === "open-tui") return ["Crestodian rescue cannot open the local TUI from a message channel.", "Use local `openclaw` for agent handoff, or ask for status, doctor, config, gateway, agents, or models."].join(" ");
	if (operation.kind === "plugin-install") return ["Crestodian rescue cannot install plugins from a message channel by default because plugin install downloads executable code.", "Use local `openclaw crestodian` or `openclaw plugins install` instead."].join(" ");
	return null;
}
async function runCrestodianRescueMessage(input) {
	const rescueMessage = extractCrestodianRescueMessage(input.commandBody);
	if (rescueMessage === null) return null;
	const policy = resolveCrestodianRescuePolicy({
		cfg: input.cfg,
		agentId: input.agentId,
		senderIsOwner: input.command.senderIsOwner,
		isDirectMessage: !input.isGroup
	});
	if (!policy.allowed) return policy.message;
	const pendingPath = resolvePendingPath(input);
	if (APPROVAL_RE.test(rescueMessage)) {
		const pending = await readPending(pendingPath);
		if (!pending) return "No pending Crestodian rescue change is waiting for approval.";
		const unsupported = formatUnsupportedRemoteOperation(pending.operation);
		if (unsupported) {
			await fs.rm(pendingPath, { force: true });
			return unsupported;
		}
		const capture = createCaptureRuntime();
		await executeCrestodianOperation(pending.operation, capture.runtime, {
			approved: true,
			auditDetails: pending.auditDetails,
			deps: input.deps
		});
		await fs.rm(pendingPath, { force: true });
		return capture.read() || "Crestodian rescue change applied.";
	}
	const operation = parseCrestodianOperation(rescueMessage);
	const unsupported = formatUnsupportedRemoteOperation(operation);
	if (unsupported) return unsupported;
	if (isPersistentCrestodianOperation(operation)) {
		const now = /* @__PURE__ */ new Date();
		const expiresAt = new Date(now.getTime() + policy.pendingTtlMinutes * 6e4);
		await writePending(pendingPath, {
			id: randomUUID(),
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
			operation,
			auditDetails: buildAuditDetails(input)
		});
		return formatPersistentPlan(operation);
	}
	const capture = createCaptureRuntime();
	await executeCrestodianOperation(operation, capture.runtime, {
		approved: true,
		auditDetails: buildAuditDetails(input),
		deps: input.deps
	});
	return capture.read() || "Crestodian listened, clicked a claw, and found nothing to change.";
}
//#endregion
export { extractCrestodianRescueMessage, runCrestodianRescueMessage };
