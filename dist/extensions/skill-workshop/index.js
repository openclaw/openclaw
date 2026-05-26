import { E as pathExists, m as resolvePathWithinRoot } from "../../fs-safe-CV86zY9G.js";
import { a as resolveAgentEffectiveModelPrimary } from "../../agent-scope-CtLXGcWm.js";
import { c as resolveDefaultAgentId } from "../../agent-scope-config-CMp71_27.js";
import { n as replaceFileAtomic } from "../../replace-file-C7_Inj8B.js";
import { t as privateFileStore } from "../../private-file-store-DMtyjgoc.js";
import { s as resolveDefaultModelForAgent } from "../../model-selection-P-81eBKx.js";
import { c as jsonResult } from "../../common-E9YpX7pB.js";
import { t as definePluginEntry } from "../../plugin-entry-Dgh5bRuw.js";
import { n as resolveLivePluginConfigObject } from "../../plugin-config-runtime-DWa7yCpn.js";
import "../../agent-runtime-Lc7H-PlR.js";
import { t as bumpSkillsSnapshotVersion } from "../../refresh-state-PCEDjmSb.js";
import "../../security-runtime-CcSekjBd.js";
import "../../api-CjZQh8jH.js";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Type } from "typebox";
//#region extensions/skill-workshop/src/config.ts
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readBoolean(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
function readInteger(value, fallback, min, max) {
	return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.trunc(value), min), max) : fallback;
}
function resolveConfig(raw) {
	const cfg = asRecord(raw);
	const approvalPolicy = cfg.approvalPolicy === "auto" ? "auto" : "pending";
	const reviewMode = cfg.reviewMode === "off" || cfg.reviewMode === "heuristic" || cfg.reviewMode === "llm" || cfg.reviewMode === "hybrid" ? cfg.reviewMode : "hybrid";
	return {
		enabled: readBoolean(cfg.enabled, true),
		autoCapture: readBoolean(cfg.autoCapture, true),
		approvalPolicy,
		reviewMode,
		reviewInterval: readInteger(cfg.reviewInterval, 15, 1, 200),
		reviewMinToolCalls: readInteger(cfg.reviewMinToolCalls, 8, 1, 500),
		reviewTimeoutMs: readInteger(cfg.reviewTimeoutMs, 45e3, 5e3, 18e4),
		maxPending: readInteger(cfg.maxPending, 50, 1, 200),
		maxSkillBytes: readInteger(cfg.maxSkillBytes, 4e4, 1024, 2e5)
	};
}
//#endregion
//#region extensions/skill-workshop/src/prompt.ts
function buildWorkshopGuidance(config) {
	return [
		"<skill_workshop>",
		"Use for durable procedural memory, not facts/preferences.",
		"Capture only repeatable workflows, user corrections, non-obvious successful procedures, recurring pitfalls.",
		"If a loaded skill is stale/wrong/thin, suggest append/replace; keep useful parts.",
		"After long tool loops or hard fixes, save the reusable procedure.",
		"Keep skill text short, imperative, tool-aware. No transcript dumps.",
		config.approvalPolicy === "auto" ? "Auto mode: apply safe workspace-skill updates; apply=false queues instead." : "Pending mode: queue suggestions; use apply action after explicit approval.",
		"</skill_workshop>"
	].join("\n");
}
//#endregion
//#region extensions/skill-workshop/src/scanner.ts
const RULES = [
	{
		ruleId: "prompt-injection-ignore-instructions",
		severity: "critical",
		pattern: /ignore (all|any|previous|above|prior) instructions/i,
		message: "prompt-injection wording attempts to override higher-priority instructions"
	},
	{
		ruleId: "prompt-injection-system",
		severity: "critical",
		pattern: /\b(system prompt|developer message|hidden instructions)\b/i,
		message: "skill text references hidden prompt layers"
	},
	{
		ruleId: "prompt-injection-tool",
		severity: "critical",
		pattern: /\b(run|execute|invoke|call)\b.{0,50}\btool\b.{0,50}\bwithout\b.{0,30}\b(permission|approval)/i,
		message: "skill text encourages bypassing tool approval"
	},
	{
		ruleId: "shell-pipe-to-shell",
		severity: "critical",
		pattern: /\b(curl|wget)\b[^|\n]{0,120}\|\s*(sh|bash|zsh)\b/i,
		message: "skill text includes pipe-to-shell install pattern"
	},
	{
		ruleId: "secret-exfiltration",
		severity: "critical",
		pattern: /\b(process\.env|env)\b.{0,80}\b(fetch|curl|wget|http|https)\b/i,
		message: "skill text may exfiltrate environment variables"
	},
	{
		ruleId: "destructive-delete",
		severity: "warn",
		pattern: /\brm\s+-rf\s+(\/|\$HOME|~|\.)/i,
		message: "skill text contains broad destructive delete command"
	},
	{
		ruleId: "unsafe-permissions",
		severity: "warn",
		pattern: /\bchmod\s+(-R\s+)?777\b/i,
		message: "skill text contains unsafe permission change"
	}
];
function scanSkillContent(content) {
	return RULES.filter((rule) => rule.pattern.test(content)).map((rule) => ({
		severity: rule.severity,
		ruleId: rule.ruleId,
		message: rule.message
	}));
}
function assertSkillContentSafe(content) {
	const findings = scanSkillContent(content);
	const critical = findings.find((finding) => finding.severity === "critical");
	if (critical) throw new Error(`unsafe skill content: ${critical.message}`);
	return findings;
}
//#endregion
//#region extensions/skill-workshop/src/skills.ts
const VALID_SKILL_NAME = /^[a-z0-9][a-z0-9_-]{1,79}$/;
const VALID_SECTION = /^[A-Za-z0-9][A-Za-z0-9 _./:-]{0,80}$/;
const SUPPORT_DIRS = new Set([
	"references",
	"templates",
	"scripts",
	"assets"
]);
function normalizeSkillName(value) {
	return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "").slice(0, 80);
}
function assertValidSkillName(name) {
	const normalized = normalizeSkillName(name);
	if (!VALID_SKILL_NAME.test(normalized)) throw new Error(`invalid skill name: ${name}`);
	return normalized;
}
function assertValidSection(section) {
	const trimmed = section.trim();
	if (!VALID_SECTION.test(trimmed)) throw new Error(`invalid section: ${section}`);
	return trimmed;
}
function skillDir(workspaceDir, skillName) {
	const safeName = assertValidSkillName(skillName);
	const dir = resolvePathWithinRoot({
		rootDir: path.resolve(workspaceDir, "skills"),
		requestedPath: safeName,
		scopeLabel: "workspace skills directory"
	});
	if (!dir.ok) throw new Error("skill path escapes workspace skills directory");
	return dir.path;
}
function skillPath(workspaceDir, skillName) {
	return path.join(skillDir(workspaceDir, skillName), "SKILL.md");
}
async function atomicWrite(filePath, content) {
	await replaceFileAtomic({
		filePath,
		content,
		tempPrefix: ".skill-workshop"
	});
}
function formatSkillMarkdown(params) {
	const description = params.description.replace(/\s+/g, " ").trim();
	if (!description) throw new Error("description required");
	const body = params.body.trim();
	return `---\nname: ${params.name}\ndescription: ${description}\n---\n\n${body}\n`;
}
function ensureBodyUnderLimit(content, maxSkillBytes) {
	if (Buffer.byteLength(content, "utf8") > maxSkillBytes) throw new Error(`skill exceeds ${maxSkillBytes} bytes`);
}
function appendSection(markdown, section, body) {
	const heading = `## ${assertValidSection(section)}`;
	const trimmedBody = body.trim();
	if (!trimmedBody) throw new Error("body required");
	if (markdown.includes(trimmedBody)) return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
	if (!markdown.includes(heading)) return `${markdown.trimEnd()}\n\n${heading}\n\n${trimmedBody}\n`;
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return markdown.replace(new RegExp(`(${escaped}\\n)`), `$1\n${trimmedBody}\n`);
}
async function prepareProposalWrite(params) {
	const name = assertValidSkillName(params.proposal.skillName);
	const target = skillPath(params.proposal.workspaceDir, name);
	const exists = await pathExists(target);
	let next;
	const change = params.proposal.change;
	if (change.kind === "create") next = exists ? appendSection(await fs.readFile(target, "utf8"), "Workflow", change.body) : formatSkillMarkdown({
		name,
		description: change.description,
		body: change.body
	});
	else if (change.kind === "append") next = appendSection(exists ? await fs.readFile(target, "utf8") : formatSkillMarkdown({
		name,
		description: change.description ?? params.proposal.title,
		body: "# Workflow\n"
	}), change.section, change.body);
	else {
		if (!exists) throw new Error(`skill does not exist: ${name}`);
		const current = await fs.readFile(target, "utf8");
		if (!current.includes(change.oldText)) throw new Error("oldText not found");
		next = current.replace(change.oldText, change.newText);
	}
	ensureBodyUnderLimit(next, params.maxSkillBytes);
	const findings = scanSkillContent(next);
	return {
		skillPath: target,
		content: next,
		created: !exists,
		findings
	};
}
async function applyProposalToWorkspace(params) {
	const prepared = await prepareProposalWrite(params);
	assertSkillContentSafe(prepared.content);
	await atomicWrite(prepared.skillPath, prepared.content);
	bumpSkillsSnapshotVersion({
		workspaceDir: params.proposal.workspaceDir,
		reason: "manual",
		changedPath: prepared.skillPath
	});
	return {
		skillPath: prepared.skillPath,
		created: prepared.created,
		findings: prepared.findings
	};
}
async function writeSupportFile(params) {
	const name = assertValidSkillName(params.skillName);
	const parts = params.relativePath.split(/[\\/]+/).filter(Boolean);
	if (parts.length < 2 || !SUPPORT_DIRS.has(parts[0])) throw new Error(`support file path must start with ${Array.from(SUPPORT_DIRS).join(", ")}`);
	if (parts.some((part) => part === "." || part === "..")) throw new Error("support file path escapes skill directory");
	if (Buffer.byteLength(params.content, "utf8") > params.maxBytes) throw new Error(`support file exceeds ${params.maxBytes} bytes`);
	assertSkillContentSafe(params.content);
	const target = resolvePathWithinRoot({
		rootDir: skillDir(params.workspaceDir, name),
		requestedPath: path.join(...parts),
		scopeLabel: "skill directory"
	});
	if (!target.ok) throw new Error("support file path escapes skill directory");
	await atomicWrite(target.path, `${params.content.trimEnd()}\n`);
	return target.path;
}
//#endregion
//#region extensions/skill-workshop/src/text.ts
const TEXT_BLOCK_TYPES = new Set([
	"text",
	"input_text",
	"output_text"
]);
function readTextValue(value) {
	if (typeof value === "string") return value;
	if (value && typeof value === "object" && typeof value.value === "string") return value.value;
	return "";
}
function extractTextBlock(block) {
	if (!block || typeof block !== "object") return "";
	const type = block.type;
	if (typeof type !== "string" || !TEXT_BLOCK_TYPES.has(type)) return "";
	return readTextValue(block.text);
}
function extractMessageText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map(extractTextBlock).filter(Boolean).join("\n");
	return extractTextBlock(content);
}
function extractTranscriptText(messages) {
	const result = [];
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		const content = message.content;
		if (typeof role !== "string") continue;
		const text = extractMessageText(content).trim();
		if (text) result.push({
			role,
			text
		});
	}
	return result;
}
function compactWhitespace(value) {
	return value.replace(/\s+/g, " ").trim();
}
//#endregion
//#region extensions/skill-workshop/src/reviewer.ts
const MAX_SKILL_CHARS = 2e3;
const MAX_SKILLS = 12;
function resolveReviewerFallbackModel(params) {
	if (resolveAgentEffectiveModelPrimary(params.api.config, params.agentId)) return resolveDefaultModelForAgent({
		cfg: params.api.config,
		agentId: params.agentId
	});
	return {
		provider: params.api.runtime.agent.defaults.provider,
		model: params.api.runtime.agent.defaults.model
	};
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readString$1(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function parseReviewerJson(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return;
	const jsonText = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1]?.trim() ?? trimmed;
	try {
		const parsed = JSON.parse(jsonText);
		return isRecord(parsed) ? parsed : void 0;
	} catch {
		return;
	}
}
function normalizeAction(value) {
	if (value === "create" || value === "append" || value === "replace" || value === "none") return value;
}
function proposalFromReviewerJson(params) {
	const action = normalizeAction(readString$1(params.parsed.action));
	if (!action || action === "none") return;
	const skillName = normalizeSkillName(readString$1(params.parsed.skillName) ?? "");
	if (!skillName) return;
	const now = Date.now();
	const title = readString$1(params.parsed.title) ?? `Skill update: ${skillName}`;
	const reason = readString$1(params.parsed.reason) ?? "Review found reusable workflow";
	let change;
	if (action === "replace") {
		const oldText = readString$1(params.parsed.oldText);
		const newText = readString$1(params.parsed.newText);
		if (!oldText || !newText) return;
		change = {
			kind: "replace",
			oldText,
			newText
		};
	} else {
		const body = readString$1(params.parsed.body);
		if (!body) return;
		if (action === "append") change = {
			kind: "append",
			section: readString$1(params.parsed.section) ?? "Workflow",
			body,
			description: readString$1(params.parsed.description) ?? title
		};
		else change = {
			kind: "create",
			description: readString$1(params.parsed.description) ?? title,
			body
		};
	}
	return {
		id: randomUUID(),
		createdAt: now,
		updatedAt: now,
		workspaceDir: params.workspaceDir,
		agentId: params.agentId,
		...params.sessionId ? { sessionId: params.sessionId } : {},
		skillName,
		title,
		reason,
		source: "reviewer",
		status: "pending",
		change
	};
}
function countToolCallsInValue(value) {
	if (!value || typeof value !== "object") return 0;
	if (Array.isArray(value)) return value.reduce((sum, item) => sum + countToolCallsInValue(item), 0);
	const record = value;
	let count = 0;
	if (Array.isArray(record.tool_calls)) count += record.tool_calls.length;
	if (record.type === "tool_call" || record.type === "function_call") count += 1;
	const content = record.content;
	if (Array.isArray(content)) count += content.filter((block) => isRecord(block) && block.type === "tool_call").length;
	return count;
}
function countToolCalls(messages) {
	return messages.reduce((sum, message) => sum + countToolCallsInValue(message), 0);
}
function buildTranscript(messages) {
	return extractTranscriptText(messages).map((entry) => `${entry.role}: ${compactWhitespace(entry.text)}`).join("\n").slice(-12e3).trim() || "(no text transcript)";
}
async function readExistingSkills(workspaceDir) {
	const skillsDir = path.join(workspaceDir, "skills");
	let entries = [];
	try {
		const names = (await fs.readdir(skillsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).toSorted().slice(0, MAX_SKILLS);
		entries = await Promise.all(names.map(async (name) => {
			const file = path.join(skillsDir, name, "SKILL.md");
			try {
				return {
					name,
					markdown: (await fs.readFile(file, "utf8")).slice(0, MAX_SKILL_CHARS)
				};
			} catch {
				return {
					name,
					markdown: ""
				};
			}
		}));
	} catch {
		return "(none)";
	}
	return entries.filter((entry) => entry.markdown.trim()).map((entry) => `--- ${entry.name} ---\n${entry.markdown.trim()}`).join("\n\n") || "(none)";
}
async function buildReviewPrompt(params) {
	return [
		"Review transcript for durable skill updates.",
		"Return JSON only. No markdown unless inside JSON strings.",
		"Use none unless there is a reusable workflow, correction, hard-won fix, or stale skill repair.",
		"Prefer append/replace for existing skills. Create only when no fitting skill exists.",
		"Skill text: terse bullets, imperative, no raw transcript, no secrets, no hidden prompt refs.",
		"Schema: {\"action\":\"none\"} or {\"action\":\"create|append|replace\",\"skillName\":\"kebab-name\",\"title\":\"...\",\"reason\":\"...\",\"description\":\"...\",\"section\":\"Workflow\",\"body\":\"...\",\"oldText\":\"...\",\"newText\":\"...\"}",
		"",
		"Existing skills:",
		await readExistingSkills(params.workspaceDir),
		"",
		"Transcript:",
		buildTranscript(params.messages)
	].join("\n");
}
async function reviewTranscriptForProposal(params) {
	const prompt = await buildReviewPrompt({
		workspaceDir: params.ctx.workspaceDir,
		messages: params.messages
	});
	const sessionId = `skill-workshop-review-${randomUUID()}`;
	const stateDir = params.api.runtime.state.resolveStateDir();
	const fallbackModel = resolveReviewerFallbackModel({
		api: params.api,
		agentId: params.ctx.agentId
	});
	const parsed = parseReviewerJson(((await params.api.runtime.agent.runEmbeddedPiAgent({
		sessionId,
		sessionKey: params.ctx.sessionKey,
		agentId: params.ctx.agentId,
		messageProvider: params.ctx.messageProvider,
		messageChannel: params.ctx.channelId,
		sessionFile: path.join(stateDir, "skill-workshop", `${sessionId}.json`),
		workspaceDir: params.ctx.workspaceDir,
		agentDir: params.api.runtime.agent.resolveAgentDir(params.api.config, params.ctx.agentId),
		config: params.api.config,
		prompt,
		provider: params.ctx.modelProviderId ?? fallbackModel.provider,
		model: params.ctx.modelId ?? fallbackModel.model,
		timeoutMs: params.config.reviewTimeoutMs,
		runId: sessionId,
		trigger: "manual",
		toolsAllow: [],
		disableTools: true,
		disableMessageTool: true,
		bootstrapContextMode: "lightweight",
		verboseLevel: "off",
		reasoningLevel: "off",
		silentExpected: true
	})).payloads ?? []).map((payload) => payload.text?.trim() ?? "").filter(Boolean).join("\n").trim());
	if (!parsed) return;
	return proposalFromReviewerJson({
		parsed,
		workspaceDir: params.ctx.workspaceDir,
		agentId: params.ctx.agentId,
		sessionId: params.ctx.sessionId
	});
}
//#endregion
//#region extensions/skill-workshop/src/signals.ts
const CORRECTION_PATTERNS = [
	/\bnext time\b/i,
	/\bfrom now on\b/i,
	/\bremember to\b/i,
	/\bmake sure to\b/i,
	/\balways\b.{0,80}\b(use|check|verify|record|save|prefer)\b/i,
	/\bprefer\b.{0,120}\b(when|for|instead|use)\b/i,
	/\bwhen asked\b/i
];
function inferTopic(text) {
	const lower = text.toLowerCase();
	if (/\banimated\b|\bgifs?\b/.test(lower)) return {
		skillName: "animated-gif-workflow",
		title: "Animated GIF Workflow",
		label: "animated GIF requests"
	};
	if (/\bscreenshot|screen capture|imageoptim|asset\b/.test(lower)) return {
		skillName: "screenshot-asset-workflow",
		title: "Screenshot Asset Workflow",
		label: "screenshot asset updates"
	};
	if (/\bqa\b|\bscenario\b|\btest plan\b/.test(lower)) return {
		skillName: "qa-scenario-workflow",
		title: "QA Scenario Workflow",
		label: "QA tasks"
	};
	if (/\bpr\b|\bpull request\b|\bgithub\b/.test(lower)) return {
		skillName: "github-pr-workflow",
		title: "GitHub PR Workflow",
		label: "GitHub PR work"
	};
	return {
		skillName: "learned-workflows",
		title: "Learned Workflows",
		label: "repeatable tasks"
	};
}
function extractInstruction(text) {
	const trimmed = compactWhitespace(text);
	if (trimmed.length < 24 || trimmed.length > 1200) return;
	if (!CORRECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) return;
	return trimmed.replace(/^ok[,. ]+/i, "");
}
function createProposalFromMessages(params) {
	const instruction = extractTranscriptText(params.messages).filter((entry) => entry.role === "user").map((entry) => entry.text).map(extractInstruction).findLast(Boolean);
	if (!instruction) return;
	const topic = inferTopic(instruction);
	const now = Date.now();
	return {
		id: randomUUID(),
		createdAt: now,
		updatedAt: now,
		workspaceDir: params.workspaceDir,
		...params.agentId ? { agentId: params.agentId } : {},
		...params.sessionId ? { sessionId: params.sessionId } : {},
		skillName: topic.skillName,
		title: topic.title,
		reason: `User correction for ${topic.label}`,
		source: "agent_end",
		status: "pending",
		change: {
			kind: "create",
			description: `Reusable workflow notes for ${topic.label}.`,
			body: [
				`# ${topic.title}`,
				"",
				"## Workflow",
				"",
				`- ${instruction}`,
				"- Verify the result before final reply.",
				"- Record durable pitfalls as short bullets; avoid copying transcript noise."
			].join("\n")
		}
	};
}
//#endregion
//#region extensions/skill-workshop/src/store.ts
const locks = /* @__PURE__ */ new Map();
function workspaceKey(workspaceDir) {
	return createHash("sha256").update(path.resolve(workspaceDir)).digest("hex").slice(0, 16);
}
async function withLock(key, task) {
	const previous = locks.get(key) ?? Promise.resolve();
	let release;
	const next = new Promise((resolve) => {
		release = resolve;
	});
	locks.set(key, previous.then(() => next));
	await previous;
	try {
		return await task();
	} finally {
		release?.();
		if (locks.get(key) === next) locks.delete(key);
	}
}
async function readJson(rootDir, relativePath) {
	const parsed = await privateFileStore(rootDir).readJsonIfExists(relativePath);
	if (!parsed) return {
		version: 1,
		proposals: []
	};
	return {
		version: 1,
		proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
		review: parsed.review && typeof parsed.review === "object" ? normalizeReviewState(parsed.review) : void 0
	};
}
function normalizeReviewState(value = {}) {
	return {
		turnsSinceReview: typeof value.turnsSinceReview === "number" && Number.isFinite(value.turnsSinceReview) ? Math.max(0, Math.trunc(value.turnsSinceReview)) : 0,
		toolCallsSinceReview: typeof value.toolCallsSinceReview === "number" && Number.isFinite(value.toolCallsSinceReview) ? Math.max(0, Math.trunc(value.toolCallsSinceReview)) : 0,
		...typeof value.lastReviewAt === "number" && Number.isFinite(value.lastReviewAt) ? { lastReviewAt: value.lastReviewAt } : {}
	};
}
async function atomicWriteJson(rootDir, relativePath, data) {
	await privateFileStore(rootDir).writeJson(relativePath, data, { trailingNewline: true });
}
var SkillWorkshopStore = class {
	constructor(params) {
		this.stateDir = path.resolve(params.stateDir);
		this.relativePath = path.join("skill-workshop", `${workspaceKey(params.workspaceDir)}.json`);
		this.filePath = path.join(this.stateDir, this.relativePath);
	}
	async list(status) {
		const file = await readJson(this.stateDir, this.relativePath);
		return (status ? file.proposals.filter((proposal) => proposal.status === status) : file.proposals).toSorted((left, right) => right.createdAt - left.createdAt);
	}
	async get(id) {
		return (await this.list()).find((proposal) => proposal.id === id);
	}
	async add(proposal, maxPending) {
		return await withLock(this.filePath, async () => {
			const file = await readJson(this.stateDir, this.relativePath);
			const duplicate = file.proposals.find((item) => (item.status === "pending" || item.status === "quarantined") && item.skillName === proposal.skillName && JSON.stringify(item.change) === JSON.stringify(proposal.change));
			if (duplicate) return duplicate;
			const nextProposals = [proposal, ...file.proposals].filter((item, index, all) => {
				if (item.status !== "pending" && item.status !== "quarantined") return true;
				return all.slice(0, index + 1).filter((candidate) => candidate.status === "pending" || candidate.status === "quarantined").length <= maxPending;
			});
			await atomicWriteJson(this.stateDir, this.relativePath, {
				...file,
				version: 1,
				proposals: nextProposals
			});
			return proposal;
		});
	}
	async updateStatus(id, status) {
		return await withLock(this.filePath, async () => {
			const file = await readJson(this.stateDir, this.relativePath);
			const index = file.proposals.findIndex((proposal) => proposal.id === id);
			if (index < 0) throw new Error(`proposal not found: ${id}`);
			const updated = {
				...file.proposals[index],
				status,
				updatedAt: Date.now()
			};
			file.proposals[index] = updated;
			await atomicWriteJson(this.stateDir, this.relativePath, file);
			return updated;
		});
	}
	async recordReviewTurn(toolCalls) {
		return await withLock(this.filePath, async () => {
			const file = await readJson(this.stateDir, this.relativePath);
			const current = normalizeReviewState(file.review);
			const next = {
				...current,
				turnsSinceReview: current.turnsSinceReview + 1,
				toolCallsSinceReview: current.toolCallsSinceReview + Math.max(0, Math.trunc(toolCalls))
			};
			await atomicWriteJson(this.stateDir, this.relativePath, {
				...file,
				review: next
			});
			return next;
		});
	}
	async markReviewed() {
		return await withLock(this.filePath, async () => {
			const file = await readJson(this.stateDir, this.relativePath);
			const next = {
				turnsSinceReview: 0,
				toolCallsSinceReview: 0,
				lastReviewAt: Date.now()
			};
			await atomicWriteJson(this.stateDir, this.relativePath, {
				...file,
				review: next
			});
			return next;
		});
	}
};
//#endregion
//#region extensions/skill-workshop/src/workshop.ts
function resolveWorkspaceDir(params) {
	return params.ctx?.workspaceDir || params.api.runtime.agent.resolveAgentWorkspaceDir(params.api.config, params.ctx?.agentId ?? resolveDefaultAgentId(params.api.config));
}
function createStoreForContext(params) {
	const workspaceDir = resolveWorkspaceDir(params);
	return new SkillWorkshopStore({
		stateDir: params.api.runtime.state.resolveStateDir(),
		workspaceDir
	});
}
async function applyOrStoreProposal(params) {
	const prepared = await prepareProposalWrite({
		proposal: params.proposal,
		maxSkillBytes: params.config.maxSkillBytes
	});
	const critical = prepared.findings.find((finding) => finding.severity === "critical");
	if (critical) return {
		status: "quarantined",
		proposal: await params.store.add({
			...params.proposal,
			status: "quarantined",
			updatedAt: Date.now(),
			scanFindings: prepared.findings,
			quarantineReason: critical.message
		}, params.config.maxPending)
	};
	if (params.config.approvalPolicy === "auto" && !params.skipAutoApply) {
		const applied = await applyProposalToWorkspace({
			proposal: params.proposal,
			maxSkillBytes: params.config.maxSkillBytes
		});
		const stored = await params.store.add({
			...params.proposal,
			status: "applied",
			updatedAt: Date.now(),
			scanFindings: applied.findings
		}, params.config.maxPending);
		return {
			status: "applied",
			skillPath: applied.skillPath,
			proposal: stored
		};
	}
	return {
		status: "pending",
		proposal: await params.store.add({
			...params.proposal,
			scanFindings: prepared.findings
		}, params.config.maxPending)
	};
}
//#endregion
//#region extensions/skill-workshop/src/tool.ts
function readString(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function buildProposal(params) {
	const skillName = normalizeSkillName(readString(params.raw.skillName) ?? "");
	if (!skillName) throw new Error("skillName required");
	const now = Date.now();
	const title = readString(params.raw.title) ?? `Skill update: ${skillName}`;
	const reason = readString(params.raw.reason) ?? "Tool-created skill update";
	const body = readString(params.raw.body);
	const description = readString(params.raw.description) ?? title;
	let change;
	if (params.raw.oldText !== void 0 || params.raw.newText !== void 0) {
		const oldText = readString(params.raw.oldText);
		const newText = readString(params.raw.newText);
		if (!oldText || !newText) throw new Error("oldText and newText required for replace");
		change = {
			kind: "replace",
			oldText,
			newText
		};
	} else if (readString(params.raw.section)) {
		if (!body) throw new Error("body required");
		change = {
			kind: "append",
			section: readString(params.raw.section) ?? "Workflow",
			body,
			description
		};
	} else {
		if (!body) throw new Error("body required");
		change = {
			kind: "create",
			description,
			body
		};
	}
	return {
		id: randomUUID(),
		createdAt: now,
		updatedAt: now,
		workspaceDir: params.workspaceDir,
		skillName,
		title,
		reason,
		source: params.source,
		status: "pending",
		change
	};
}
function createSkillWorkshopTool(params) {
	return {
		name: "skill_workshop",
		label: "Skill Workshop",
		description: "Create, queue, inspect, approve, or safely apply workspace skill updates for repeatable workflows.",
		parameters: Type.Object({
			action: Type.String({ enum: [
				"status",
				"list_pending",
				"list_quarantine",
				"inspect",
				"suggest",
				"apply",
				"reject",
				"write_support_file"
			] }),
			id: Type.Optional(Type.String()),
			status: Type.Optional(Type.String({ enum: [
				"pending",
				"applied",
				"rejected",
				"quarantined"
			] })),
			skillName: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			description: Type.Optional(Type.String()),
			body: Type.Optional(Type.String()),
			section: Type.Optional(Type.String()),
			oldText: Type.Optional(Type.String()),
			newText: Type.Optional(Type.String()),
			relativePath: Type.Optional(Type.String()),
			apply: Type.Optional(Type.Boolean())
		}),
		async execute(_toolCallId, rawParams) {
			const raw = rawParams;
			const action = raw.action ?? "status";
			const workspaceDir = resolveWorkspaceDir(params);
			const store = createStoreForContext(params);
			if (action === "status") {
				const all = await store.list();
				return jsonResult({
					workspaceDir,
					pending: all.filter((item) => item.status === "pending").length,
					quarantined: all.filter((item) => item.status === "quarantined").length,
					applied: all.filter((item) => item.status === "applied").length,
					rejected: all.filter((item) => item.status === "rejected").length
				});
			}
			if (action === "list_pending") return jsonResult(await store.list(raw.status ?? "pending"));
			if (action === "list_quarantine") return jsonResult(await store.list("quarantined"));
			if (action === "inspect") {
				if (!raw.id) throw new Error("id required");
				return jsonResult(await store.get(raw.id));
			}
			if (action === "suggest") return jsonResult(await applyOrStoreProposal({
				proposal: buildProposal({
					workspaceDir,
					raw,
					source: "tool"
				}),
				store,
				config: params.config,
				workspaceDir,
				skipAutoApply: raw.apply === false
			}));
			if (action === "apply") {
				if (!raw.id) throw new Error("id required");
				const proposal = await store.get(raw.id);
				if (!proposal) throw new Error(`proposal not found: ${raw.id}`);
				if (proposal.status === "quarantined") throw new Error("quarantined proposal cannot be applied");
				const applied = await applyProposalToWorkspace({
					proposal,
					maxSkillBytes: params.config.maxSkillBytes
				});
				const updated = await store.updateStatus(raw.id, "applied");
				return jsonResult({
					status: "applied",
					skillPath: applied.skillPath,
					proposal: updated
				});
			}
			if (action === "reject") {
				if (!raw.id) throw new Error("id required");
				return jsonResult(await store.updateStatus(raw.id, "rejected"));
			}
			if (action === "write_support_file") {
				const skillName = readString(raw.skillName);
				const relativePath = readString(raw.relativePath);
				const body = raw.body;
				if (!skillName || !relativePath || typeof body !== "string") throw new Error("skillName, relativePath, and body required");
				return jsonResult({
					status: "written",
					filePath: await writeSupportFile({
						workspaceDir,
						skillName,
						relativePath,
						content: body,
						maxBytes: params.config.maxSkillBytes
					})
				});
			}
			throw new Error(`unknown action: ${action}`);
		}
	};
}
//#endregion
//#region extensions/skill-workshop/index.ts
var skill_workshop_default = definePluginEntry({
	id: "skill-workshop",
	name: "Skill Workshop",
	description: "Captures repeatable workflows as workspace skills, with pending review and safe writes.",
	register(api) {
		const resolveCurrentConfig = () => {
			return resolveConfig(resolveLivePluginConfigObject(api.runtime.config?.current ? () => api.runtime.config.current() : void 0, "skill-workshop", api.pluginConfig));
		};
		api.registerTool((ctx) => {
			const config = resolveCurrentConfig();
			if (!config.enabled) return null;
			return createSkillWorkshopTool({
				api,
				config,
				ctx
			});
		}, { name: "skill_workshop" });
		api.registerTrustedToolPolicy({
			id: "skill-workshop-apply-approval",
			description: "Require operator approval before applying queued workspace skill proposals.",
			evaluate(event) {
				const config = resolveCurrentConfig();
				if (!config.enabled || config.approvalPolicy === "auto" || event.toolName !== "skill_workshop" || event.params.action !== "apply") return;
				return { requireApproval: {
					title: "Apply workspace skill proposal",
					description: "Apply a queued workspace skill proposal.",
					severity: "warning",
					allowedDecisions: ["allow-once", "deny"]
				} };
			}
		});
		api.on("before_prompt_build", async () => {
			const config = resolveCurrentConfig();
			if (!config.enabled) return;
			return { prependSystemContext: buildWorkshopGuidance(config) };
		});
		api.on("agent_end", async (event, ctx) => {
			const config = resolveCurrentConfig();
			if (!config.enabled || !config.autoCapture || config.reviewMode === "off") return;
			if (!event.success) return;
			if (ctx.sessionId?.startsWith("skill-workshop-review-")) return;
			const agentId = ctx.agentId ?? resolveDefaultAgentId(api.config);
			const workspaceDir = ctx.workspaceDir || api.runtime.agent.resolveAgentWorkspaceDir(api.config, agentId);
			const store = createStoreForContext({
				api,
				ctx: {
					...ctx,
					workspaceDir
				},
				config
			});
			const heuristicProposal = createProposalFromMessages({
				messages: event.messages,
				workspaceDir,
				agentId,
				sessionId: ctx.sessionId
			});
			if ((config.reviewMode === "heuristic" || config.reviewMode === "hybrid") && heuristicProposal) try {
				const result = await applyOrStoreProposal({
					proposal: heuristicProposal,
					store,
					config,
					workspaceDir
				});
				if (result.status === "applied") api.logger.info(`skill-workshop: applied ${heuristicProposal.skillName}`);
				else if (result.status === "quarantined") api.logger.warn(`skill-workshop: quarantined ${heuristicProposal.skillName}`);
				else api.logger.info(`skill-workshop: queued ${heuristicProposal.skillName}`);
			} catch (error) {
				api.logger.warn(`skill-workshop: heuristic capture skipped: ${String(error)}`);
			}
			if (!(config.reviewMode === "llm" || config.reviewMode === "hybrid")) return;
			const reviewState = await store.recordReviewTurn(countToolCalls(event.messages));
			if (!(reviewState.turnsSinceReview >= config.reviewInterval || reviewState.toolCallsSinceReview >= config.reviewMinToolCalls || config.reviewMode === "llm" && heuristicProposal !== void 0)) return;
			await store.markReviewed();
			try {
				const proposal = await reviewTranscriptForProposal({
					api,
					config,
					messages: event.messages,
					ctx: {
						agentId,
						sessionId: ctx.sessionId,
						sessionKey: ctx.sessionKey,
						workspaceDir,
						modelProviderId: ctx.modelProviderId,
						modelId: ctx.modelId,
						messageProvider: ctx.messageProvider,
						channelId: ctx.channelId
					}
				});
				if (!proposal) {
					api.logger.debug?.("skill-workshop: reviewer found no update");
					return;
				}
				const result = await applyOrStoreProposal({
					proposal,
					store,
					config,
					workspaceDir
				});
				if (result.status === "applied") api.logger.info(`skill-workshop: applied ${proposal.skillName}`);
				else if (result.status === "quarantined") api.logger.warn(`skill-workshop: quarantined ${proposal.skillName}`);
				else api.logger.info(`skill-workshop: queued ${proposal.skillName}`);
			} catch (error) {
				api.logger.warn(`skill-workshop: reviewer skipped: ${String(error)}`);
			}
		});
	}
});
//#endregion
export { SkillWorkshopStore, applyProposalToWorkspace, createProposalFromMessages, skill_workshop_default as default, reviewTranscriptForProposal, scanSkillContent };
