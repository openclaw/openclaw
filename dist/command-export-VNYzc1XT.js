import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { i as isPathInside } from "./path-BlG8lhgR.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import "./path-guards-CBe_wA_B.js";
import { a as resolveTrajectoryPointerFilePath, i as resolveTrajectoryFilePath, r as TRAJECTORY_RUNTIME_FILE_MAX_BYTES, s as safeTrajectorySessionFileName } from "./paths-CzW2SUx5.js";
import { n as redactSupportString } from "./diagnostic-support-redaction-GWib8H_y.js";
import { n as sanitizeDiagnosticPayload, t as safeJsonStringify } from "./safe-json-DlEQ5NdD.js";
import { a as writeSupportBundleDirectory, i as textSupportBundleFile, n as jsonlSupportBundleFile, r as supportBundleContents, t as jsonSupportBundleFile } from "./diagnostic-support-bundle-IFXyP28r.js";
import path from "node:path";
import fs from "node:fs/promises";
//#region src/trajectory/export.ts
const MAX_TRAJECTORY_RUNTIME_EVENTS = 2e5;
const MAX_TRAJECTORY_TOTAL_EVENTS = 25e4;
const MAX_TRAJECTORY_SESSION_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TRAJECTORY_WARNING_ROWS = 20;
function isFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value);
}
function isRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function isSessionFileEntry(value) {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	if (value.type !== "message") return true;
	const message = value.message;
	return isRecord(message) && typeof message.role === "string";
}
function parseSessionEntries(content) {
	const entries = [];
	const warnings = [];
	const rowByEntry = /* @__PURE__ */ new Map();
	const rows = content.split(/\r?\n/u);
	for (const [index, rawLine] of rows.entries()) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const parsed = JSON.parse(line);
			if (!isSessionFileEntry(parsed)) {
				warnings.push({
					source: "session",
					code: "invalid-session-row",
					row: index + 1,
					message: "Skipped a session JSONL row that is not a session entry object."
				});
				continue;
			}
			entries.push(parsed);
			rowByEntry.set(parsed, index + 1);
		} catch {
			warnings.push({
				source: "session",
				code: "invalid-session-json",
				row: index + 1,
				message: "Skipped a session JSONL row that is not valid JSON."
			});
		}
	}
	return {
		entries,
		warnings,
		rowByEntry
	};
}
function migrateLegacySessionEntries(entries) {
	const version = entries.find((entry) => entry.type === "session")?.version ?? 1;
	if (version < 2) {
		let previousId = null;
		let index = 0;
		for (const entry of entries) {
			if (entry.type === "session") {
				entry.version = 2;
				continue;
			}
			const mutable = entry;
			if (typeof mutable.id !== "string") mutable.id = `legacy-${index++}`;
			mutable.parentId = previousId;
			const entryId = mutable.id;
			previousId = typeof entryId === "string" ? entryId : null;
			if (entry.type === "compaction" && typeof mutable.firstKeptEntryIndex === "number") {
				const target = entries[mutable.firstKeptEntryIndex];
				if (target && target.type !== "session") mutable.firstKeptEntryId = target.id;
				delete mutable.firstKeptEntryIndex;
			}
		}
	}
	if (version < 3) for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}
		if (entry.type === "message") {
			const message = entry.message;
			if (message?.role === "hookMessage") message.role = "custom";
		}
	}
}
async function readSessionBranch(filePath) {
	const { entries: fileEntries, warnings, rowByEntry } = parseSessionEntries(await fs.readFile(filePath, "utf8"));
	migrateLegacySessionEntries(fileEntries);
	const header = fileEntries.find((entry) => entry.type === "session") ?? null;
	const entries = fileEntries.filter((entry) => entry.type !== "session" && typeof entry.id === "string" && (typeof entry.timestamp === "string" || typeof entry.timestamp === "number"));
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const leafId = entries.at(-1)?.id ?? null;
	const branchEntries = [];
	const seen = /* @__PURE__ */ new Set();
	let currentId = leafId;
	while (currentId) {
		if (seen.has(currentId)) {
			const cycleEntry = byId.get(currentId);
			warnings.push({
				source: "session",
				code: "cyclic-session-branch",
				row: cycleEntry ? rowByEntry.get(cycleEntry) ?? 0 : 0,
				message: "Stopped trajectory session branch export at a cyclic parent link."
			});
			break;
		}
		seen.add(currentId);
		const current = byId.get(currentId);
		if (!current) {
			warnings.push({
				source: "session",
				code: "incomplete-session-branch",
				row: 0,
				message: "Exported the reachable session branch suffix after a missing parent link."
			});
			break;
		}
		branchEntries.unshift(current);
		const parentId = typeof current.parentId === "string" ? current.parentId : null;
		if (parentId && !byId.has(parentId)) {
			warnings.push({
				source: "session",
				code: "incomplete-session-branch",
				row: rowByEntry.get(current) ?? 0,
				message: "Exported the reachable session branch suffix after a missing parent link."
			});
			break;
		}
		currentId = parentId;
	}
	return {
		header,
		leafId,
		branchEntries,
		warnings
	};
}
async function parseJsonlFile(filePath, params) {
	let stat;
	try {
		stat = await fs.stat(filePath);
	} catch (error) {
		if (error.code === "ENOENT") return {
			events: [],
			warnings: []
		};
		throw error;
	}
	if (!stat.isFile()) return {
		events: [],
		warnings: []
	};
	if (stat.size > params.maxBytes) throw new Error(`Trajectory runtime file is too large to export (${stat.size} bytes; limit ${params.maxBytes})`);
	const rows = (await fs.readFile(filePath, "utf8")).split(/\r?\n/u);
	const parsed = [];
	const warnings = [];
	for (const [index, rawLine] of rows.entries()) {
		const row = rawLine.trim();
		if (!row) continue;
		if (parsed.length >= params.maxEvents) throw new Error(`Trajectory runtime file has too many events to export (limit ${params.maxEvents})`);
		try {
			const value = JSON.parse(row);
			if (!params.validate || params.validate(value)) {
				const typedValue = value;
				if (!params.include || params.include(typedValue)) parsed.push(typedValue);
			} else warnings.push({
				source: "runtime",
				code: "invalid-runtime-event",
				row: index + 1,
				message: "Skipped a runtime trajectory JSONL row that does not match the session schema."
			});
		} catch {
			warnings.push({
				source: "runtime",
				code: "invalid-runtime-json",
				row: index + 1,
				message: "Skipped a runtime trajectory JSONL row that is not valid JSON."
			});
		}
	}
	return {
		events: parsed,
		warnings
	};
}
function isRuntimeTrajectoryEvent(value) {
	if (!isRecord(value)) return false;
	return value.traceSchema === "openclaw-trajectory" && value.schemaVersion === 1 && value.source === "runtime" && typeof value.type === "string" && typeof value.ts === "string" && !Number.isNaN(Date.parse(value.ts)) && isFiniteNumber(value.seq) && typeof value.sessionId === "string" && (!("data" in value) || value.data === void 0 || isRecord(value.data));
}
function summarizeJsonlWarnings(warnings) {
	const byKey = /* @__PURE__ */ new Map();
	for (const warning of warnings) {
		const key = `${warning.source}:${warning.code}`;
		const existing = byKey.get(key);
		if (existing) {
			existing.count += 1;
			if (existing.rows.length < MAX_TRAJECTORY_WARNING_ROWS) existing.rows.push(warning.row);
			continue;
		}
		byKey.set(key, {
			source: warning.source,
			code: warning.code,
			count: 1,
			rows: [warning.row],
			message: warning.message
		});
	}
	return [...byKey.values()];
}
async function isRegularNonSymlinkFile(filePath) {
	try {
		const linkStat = await fs.lstat(filePath);
		if (linkStat.isSymbolicLink() || !linkStat.isFile()) return false;
		const stat = await fs.stat(filePath);
		return stat.isFile() && stat.dev === linkStat.dev && stat.ino === linkStat.ino;
	} catch {
		return false;
	}
}
async function readRuntimePointerFile(sessionFile, sessionId) {
	const pointerPath = resolveTrajectoryPointerFilePath(sessionFile);
	if (!await isRegularNonSymlinkFile(pointerPath)) return;
	try {
		const parsed = JSON.parse(await fs.readFile(pointerPath, "utf8"));
		if (!isRecord(parsed)) return;
		if (parsed.sessionId !== sessionId || typeof parsed.runtimeFile !== "string") return;
		const runtimeFile = path.resolve(parsed.runtimeFile);
		const safeRuntimeFileName = `${safeTrajectorySessionFileName(sessionId)}.jsonl`;
		if (runtimeFile !== path.resolve(resolveTrajectoryFilePath({
			env: {},
			sessionFile,
			sessionId
		})) && path.basename(runtimeFile) !== safeRuntimeFileName) return;
		return runtimeFile;
	} catch {
		return;
	}
}
async function resolveTrajectoryRuntimeFile(params) {
	if (params.runtimeFile) return params.runtimeFile;
	const candidates = [
		await readRuntimePointerFile(params.sessionFile, params.sessionId),
		resolveTrajectoryFilePath({
			env: {},
			sessionFile: params.sessionFile,
			sessionId: params.sessionId
		}),
		resolveTrajectoryFilePath({
			sessionFile: params.sessionFile,
			sessionId: params.sessionId
		})
	].filter((candidate) => Boolean(candidate));
	for (const candidate of candidates) if (await isRegularNonSymlinkFile(candidate)) return candidate;
}
function normalizeTimestamp(value) {
	if (typeof value === "number" && Number.isFinite(value)) {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	if (typeof value === "string") {
		const parsed = new Date(value);
		if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
	}
	return (/* @__PURE__ */ new Date(0)).toISOString();
}
function resolveMessageEventType(message) {
	if (message.role === "user") return "user.message";
	if (message.role === "assistant") return "assistant.message";
	if (message.role === "toolResult") return "tool.result";
	return `message.${message.role}`;
}
function extractAssistantToolCalls(message) {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.flatMap((block, index) => {
		if (!block || typeof block !== "object") return [];
		const typedBlock = block;
		const blockType = typeof typedBlock.type === "string" ? typedBlock.type.trim().toLowerCase() : "";
		if (blockType !== "toolcall" && blockType !== "tooluse" && blockType !== "functioncall") return [];
		return [{
			id: typeof typedBlock.id === "string" ? typedBlock.id : void 0,
			name: typeof typedBlock.name === "string" ? typedBlock.name : void 0,
			arguments: typedBlock.arguments ?? typedBlock.input ?? typedBlock.parameters,
			index
		}];
	});
}
function buildTranscriptEvents(params) {
	const events = [];
	let seq = 0;
	for (const entry of params.entries) {
		const push = (type, data) => {
			events.push({
				traceSchema: "openclaw-trajectory",
				schemaVersion: 1,
				traceId: params.traceId,
				source: "transcript",
				type,
				ts: normalizeTimestamp(entry.timestamp),
				seq: 0,
				sourceSeq: seq += 1,
				sessionId: params.sessionId,
				sessionKey: params.sessionKey,
				workspaceDir: params.workspaceDir,
				entryId: entry.id,
				parentEntryId: entry.parentId,
				data
			});
		};
		switch (entry.type) {
			case "message":
				push(resolveMessageEventType(entry.message), { message: sanitizeDiagnosticPayload(entry.message) });
				for (const toolCall of extractAssistantToolCalls(entry.message)) push("tool.call", {
					toolCallId: toolCall.id,
					name: toolCall.name,
					arguments: sanitizeDiagnosticPayload(toolCall.arguments),
					assistantEntryId: entry.id,
					blockIndex: toolCall.index
				});
				break;
			case "compaction":
				push("session.compaction", {
					summary: entry.summary,
					firstKeptEntryId: entry.firstKeptEntryId,
					tokensBefore: entry.tokensBefore,
					details: sanitizeDiagnosticPayload(entry.details),
					fromHook: entry.fromHook ?? false
				});
				break;
			case "branch_summary":
				push("session.branch_summary", {
					fromId: entry.fromId,
					summary: entry.summary,
					details: sanitizeDiagnosticPayload(entry.details),
					fromHook: entry.fromHook ?? false
				});
				break;
			case "custom":
				push("session.custom", {
					customType: entry.customType,
					data: sanitizeDiagnosticPayload(entry.data)
				});
				break;
			case "custom_message":
				push("session.custom_message", {
					customType: entry.customType,
					content: sanitizeDiagnosticPayload(entry.content),
					details: sanitizeDiagnosticPayload(entry.details),
					display: entry.display
				});
				break;
			case "thinking_level_change":
				push("session.thinking_level_change", { thinkingLevel: entry.thinkingLevel });
				break;
			case "model_change":
				push("session.model_change", {
					provider: entry.provider,
					modelId: entry.modelId
				});
				break;
			case "label":
				push("session.label", {
					targetId: entry.targetId,
					label: entry.label
				});
				break;
			case "session_info":
				push("session.info", { name: entry.name });
				break;
		}
	}
	return events;
}
function sortTrajectoryEvents(events) {
	const sourceOrder = {
		runtime: 0,
		transcript: 1,
		export: 2
	};
	const sorted = events.toSorted((left, right) => {
		const byTs = left.ts.localeCompare(right.ts);
		if (byTs !== 0) return byTs;
		const bySource = sourceOrder[left.source] - sourceOrder[right.source];
		if (bySource !== 0) return bySource;
		return (left.sourceSeq ?? left.seq) - (right.sourceSeq ?? right.seq);
	});
	for (const [index, event] of sorted.entries()) event.seq = index + 1;
	return sorted;
}
function trajectoryJsonlFile(pathName, events) {
	return jsonlSupportBundleFile(pathName, events.map((event) => safeJsonStringify(event)).filter((line) => Boolean(line)));
}
function buildTrajectoryExportRedaction(params) {
	const env = process.env;
	return {
		env,
		stateDir: resolveStateDir(env),
		workspaceDir: path.resolve(params.workspaceDir)
	};
}
function redactWorkspacePathString(value, redaction) {
	const workspaceDir = redaction.workspaceDir;
	if (!workspaceDir) return value;
	const normalizedWorkspaceDir = workspaceDir.replaceAll("\\", "/");
	let next = value;
	for (const candidate of new Set([workspaceDir, normalizedWorkspaceDir])) {
		if (!candidate) continue;
		const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		next = next.replace(new RegExp(`${escaped}(?=$|[\\\\/])`, "gu"), "$WORKSPACE_DIR");
	}
	return next;
}
function maybeRedactPathString(value, redaction) {
	const workspaceRedacted = redactWorkspacePathString(value, redaction);
	if (workspaceRedacted !== value || path.isAbsolute(workspaceRedacted) || workspaceRedacted.includes(redaction.stateDir) || (redaction.env.HOME ? workspaceRedacted.includes(redaction.env.HOME) : false) || (redaction.env.USERPROFILE ? workspaceRedacted.includes(redaction.env.USERPROFILE) : false)) return redactSupportString(workspaceRedacted, redaction);
	return workspaceRedacted;
}
function redactLocalPathValues(value, redaction) {
	if (typeof value === "string") return maybeRedactPathString(value, redaction);
	if (Array.isArray(value)) return value.map((entry) => redactLocalPathValues(entry, redaction));
	if (!value || typeof value !== "object") return value;
	const record = value;
	const next = {};
	for (const [key, entry] of Object.entries(record)) next[key] = redactLocalPathValues(entry, redaction);
	return next;
}
function redactEventForExport(event, redaction) {
	return {
		...event,
		workspaceDir: event.workspaceDir ? maybeRedactPathString(event.workspaceDir, redaction) : void 0,
		data: event.data ? redactLocalPathValues(event.data, redaction) : void 0
	};
}
function resolveRuntimeContext(runtimeEvents) {
	const runtimeData = runtimeEvents.slice().toReversed().find((event) => event.type === "context.compiled")?.data;
	const toolsValue = Array.isArray(runtimeData?.tools) ? runtimeData.tools : void 0;
	return {
		systemPrompt: typeof runtimeData?.systemPrompt === "string" ? runtimeData.systemPrompt : void 0,
		tools: toolsValue
	};
}
function resolveLatestRuntimeEventData(runtimeEvents, type) {
	return runtimeEvents.slice().toReversed().find((candidate) => candidate.type === type)?.data;
}
function normalizePathForMatch(value) {
	return value.replaceAll("\\", "/").trim().toLowerCase();
}
function collectPotentialPathStrings(value) {
	const found = /* @__PURE__ */ new Set();
	const visit = (input) => {
		if (!input || typeof input !== "object") return;
		if (Array.isArray(input)) {
			for (const entry of input) visit(entry);
			return;
		}
		for (const [key, entry] of Object.entries(input)) if (typeof entry === "string" && (key.toLowerCase().includes("path") || entry.endsWith("SKILL.md") || entry.endsWith("skill.md"))) found.add(entry);
		else visit(entry);
	};
	visit(value);
	return [...found];
}
function markInvokedSkills(params) {
	if (!params.skills || typeof params.skills !== "object") return params.skills;
	const skillsRecord = params.skills;
	if (!Array.isArray(skillsRecord.entries) || skillsRecord.entries.length === 0) return params.skills;
	const invokedPaths = new Set(params.events.flatMap((event) => {
		if (event.type !== "tool.call") return [];
		return collectPotentialPathStrings(event.data?.arguments);
	}));
	const normalizedInvokedPaths = new Set([...invokedPaths].map((value) => normalizePathForMatch(value)));
	const entries = skillsRecord.entries.map((entry) => {
		const rawPath = typeof entry.filePath === "string" ? entry.filePath : void 0;
		const normalizedPath = rawPath ? normalizePathForMatch(rawPath) : void 0;
		const skillDirName = rawPath?.replaceAll("\\", "/").split("/").slice(-2, -1)[0]?.toLowerCase() ?? void 0;
		const invoked = normalizedPath ? [...normalizedInvokedPaths].some((candidate) => candidate === normalizedPath || candidate.endsWith(normalizedPath) || (skillDirName ? candidate.endsWith(`/${skillDirName}/skill.md`) : false)) : false;
		return invoked ? {
			...entry,
			invoked,
			invocationDetectedBy: "tool-call-file-path"
		} : {
			...entry,
			invoked: false
		};
	});
	return {
		...skillsRecord,
		entries
	};
}
function buildMetadataCapture(params) {
	const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
	if (!runtimeMetadata) return;
	const modelFallback = (() => {
		const latest = params.runtimeEvents.slice().toReversed().find((event) => event.provider || event.modelId || event.modelApi);
		if (!latest?.provider && !latest?.modelId && !latest?.modelApi) return;
		return {
			provider: latest.provider,
			name: latest.modelId,
			api: latest.modelApi
		};
	})();
	return {
		traceSchema: "openclaw-trajectory",
		schemaVersion: 1,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		traceId: params.manifest.traceId,
		sessionId: params.manifest.sessionId,
		sessionKey: params.manifest.sessionKey,
		harness: runtimeMetadata.harness,
		model: runtimeMetadata.model ?? modelFallback,
		config: runtimeMetadata.config,
		plugins: runtimeMetadata.plugins,
		skills: markInvokedSkills({
			skills: runtimeMetadata.skills,
			events: params.events
		}),
		prompting: runtimeMetadata.prompting,
		redaction: runtimeMetadata.redaction,
		metadata: runtimeMetadata.metadata
	};
}
function buildArtifactsCapture(params) {
	const runtimeArtifacts = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.artifacts");
	const runtimeCompletion = resolveLatestRuntimeEventData(params.runtimeEvents, "model.completed");
	const runtimeEnd = resolveLatestRuntimeEventData(params.runtimeEvents, "session.ended");
	if (!runtimeArtifacts && !runtimeCompletion && !runtimeEnd) return;
	return {
		traceSchema: "openclaw-trajectory",
		schemaVersion: 1,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		traceId: params.manifest.traceId,
		sessionId: params.manifest.sessionId,
		sessionKey: params.manifest.sessionKey,
		finalStatus: runtimeArtifacts?.finalStatus ?? runtimeEnd?.status,
		aborted: runtimeArtifacts?.aborted ?? runtimeEnd?.aborted,
		externalAbort: runtimeArtifacts?.externalAbort ?? runtimeEnd?.externalAbort,
		timedOut: runtimeArtifacts?.timedOut ?? runtimeEnd?.timedOut,
		idleTimedOut: runtimeArtifacts?.idleTimedOut ?? runtimeEnd?.idleTimedOut,
		timedOutDuringCompaction: runtimeArtifacts?.timedOutDuringCompaction ?? runtimeEnd?.timedOutDuringCompaction,
		timedOutDuringToolExecution: runtimeArtifacts?.timedOutDuringToolExecution ?? runtimeEnd?.timedOutDuringToolExecution,
		promptError: runtimeArtifacts?.promptError ?? runtimeEnd?.promptError ?? runtimeCompletion?.promptError,
		promptErrorSource: runtimeArtifacts?.promptErrorSource ?? runtimeCompletion?.promptErrorSource,
		terminalError: runtimeArtifacts?.terminalError ?? runtimeEnd?.terminalError ?? runtimeCompletion?.terminalError,
		usage: runtimeArtifacts?.usage ?? runtimeCompletion?.usage,
		promptCache: runtimeArtifacts?.promptCache ?? runtimeCompletion?.promptCache,
		compactionCount: runtimeArtifacts?.compactionCount ?? runtimeCompletion?.compactionCount,
		assistantTexts: runtimeArtifacts?.assistantTexts ?? runtimeCompletion?.assistantTexts,
		finalPromptText: runtimeArtifacts?.finalPromptText ?? runtimeCompletion?.finalPromptText,
		itemLifecycle: runtimeArtifacts?.itemLifecycle,
		toolMetas: runtimeArtifacts?.toolMetas,
		didSendViaMessagingTool: runtimeArtifacts?.didSendViaMessagingTool,
		successfulCronAdds: runtimeArtifacts?.successfulCronAdds,
		messagingToolSentTexts: runtimeArtifacts?.messagingToolSentTexts,
		messagingToolSentMediaUrls: runtimeArtifacts?.messagingToolSentMediaUrls,
		messagingToolSentTargets: runtimeArtifacts?.messagingToolSentTargets,
		lastToolError: runtimeArtifacts?.lastToolError
	};
}
function buildPromptsCapture(params) {
	const runtimeMetadata = resolveLatestRuntimeEventData(params.runtimeEvents, "trace.metadata");
	const latestCompiled = resolveLatestRuntimeEventData(params.runtimeEvents, "context.compiled");
	const submittedPrompts = params.runtimeEvents.filter((event) => event.type === "prompt.submitted").map((event) => event.data?.prompt).filter((prompt) => typeof prompt === "string");
	const systemPrompt = (typeof latestCompiled?.systemPrompt === "string" ? latestCompiled.systemPrompt : void 0) ?? params.runtimeContext.systemPrompt;
	const skillsPrompt = runtimeMetadata?.prompting && typeof runtimeMetadata.prompting === "object" && typeof runtimeMetadata.prompting.skillsPrompt === "string" ? runtimeMetadata.prompting.skillsPrompt : void 0;
	const userPromptPrefixText = runtimeMetadata?.prompting && typeof runtimeMetadata.prompting === "object" && typeof runtimeMetadata.prompting.userPromptPrefixText === "string" ? runtimeMetadata.prompting.userPromptPrefixText : void 0;
	const promptReport = runtimeMetadata?.prompting && typeof runtimeMetadata.prompting === "object" && typeof runtimeMetadata.prompting.systemPromptReport === "object" ? runtimeMetadata.prompting.systemPromptReport : void 0;
	if (!systemPrompt && submittedPrompts.length === 0 && !skillsPrompt && !userPromptPrefixText) return;
	return {
		traceSchema: "openclaw-trajectory",
		schemaVersion: 1,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		traceId: params.manifest.traceId,
		sessionId: params.manifest.sessionId,
		sessionKey: params.manifest.sessionKey,
		system: systemPrompt,
		submittedPrompts,
		latestSubmittedPrompt: submittedPrompts.at(-1),
		skillsPrompt,
		userPromptPrefixText,
		systemPromptReport: promptReport
	};
}
function resolveDefaultTrajectoryExportDir(params) {
	const timestamp = (params.now ?? /* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const sessionFileName = safeTrajectorySessionFileName(params.sessionId);
	return path.join(params.workspaceDir, ".openclaw", "trajectory-exports", `openclaw-trajectory-${sessionFileName.slice(0, 8)}-${timestamp}`);
}
async function exportTrajectoryBundle(params) {
	const redaction = buildTrajectoryExportRedaction({ workspaceDir: params.workspaceDir });
	const sessionStat = await fs.stat(params.sessionFile);
	if (sessionStat.size > MAX_TRAJECTORY_SESSION_FILE_BYTES) throw new Error(`Trajectory session file is too large to export (${sessionStat.size} bytes; limit ${MAX_TRAJECTORY_SESSION_FILE_BYTES})`);
	const { header, leafId, branchEntries, warnings: sessionWarnings } = await readSessionBranch(params.sessionFile);
	const runtimeFile = await resolveTrajectoryRuntimeFile({
		runtimeFile: params.runtimeFile,
		sessionFile: params.sessionFile,
		sessionId: params.sessionId
	});
	const runtimeParse = runtimeFile ? await parseJsonlFile(runtimeFile, {
		maxBytes: TRAJECTORY_RUNTIME_FILE_MAX_BYTES,
		maxEvents: MAX_TRAJECTORY_RUNTIME_EVENTS,
		include: (value) => value.sessionId === params.sessionId,
		validate: isRuntimeTrajectoryEvent
	}) : {
		events: [],
		warnings: []
	};
	const runtimeEvents = runtimeParse.events;
	const transcriptEvents = buildTranscriptEvents({
		entries: branchEntries,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		workspaceDir: params.workspaceDir,
		traceId: params.sessionId
	});
	const maxTotalEvents = params.maxTotalEvents ?? MAX_TRAJECTORY_TOTAL_EVENTS;
	const totalEventCount = runtimeEvents.length + transcriptEvents.length;
	if (totalEventCount > maxTotalEvents) throw new Error(`Trajectory export has too many events (${totalEventCount}; limit ${maxTotalEvents})`);
	const rawEvents = sortTrajectoryEvents([...runtimeEvents, ...transcriptEvents]);
	const events = rawEvents.map((event) => redactEventForExport(event, redaction));
	const manifest = {
		traceSchema: "openclaw-trajectory",
		schemaVersion: 1,
		generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
		traceId: params.sessionId,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		workspaceDir: maybeRedactPathString(params.workspaceDir, redaction),
		leafId,
		eventCount: events.length,
		runtimeEventCount: runtimeEvents.length,
		transcriptEventCount: transcriptEvents.length,
		sourceFiles: {
			session: maybeRedactPathString(params.sessionFile, redaction),
			runtime: runtimeFile && await isRegularNonSymlinkFile(runtimeFile) ? maybeRedactPathString(runtimeFile, redaction) : void 0
		}
	};
	const warnings = summarizeJsonlWarnings([...sessionWarnings, ...runtimeParse.warnings]);
	if (warnings.length > 0) manifest.warnings = warnings;
	const bundleRuntimeContext = resolveRuntimeContext(runtimeEvents);
	const files = [];
	const supplementalFiles = [];
	const metadataCapture = buildMetadataCapture({
		manifest,
		runtimeEvents,
		events: rawEvents
	});
	const artifactsCapture = buildArtifactsCapture({
		manifest,
		runtimeEvents
	});
	const promptsCapture = buildPromptsCapture({
		manifest,
		runtimeEvents,
		runtimeContext: bundleRuntimeContext
	});
	if (metadataCapture) {
		files.push(jsonSupportBundleFile("metadata.json", redactLocalPathValues(metadataCapture, redaction)));
		supplementalFiles.push("metadata.json");
	}
	if (artifactsCapture) {
		files.push(jsonSupportBundleFile("artifacts.json", redactLocalPathValues(artifactsCapture, redaction)));
		supplementalFiles.push("artifacts.json");
	}
	if (promptsCapture) {
		files.push(jsonSupportBundleFile("prompts.json", redactLocalPathValues(promptsCapture, redaction)));
		supplementalFiles.push("prompts.json");
	}
	if (supplementalFiles.length > 0) manifest.supplementalFiles = supplementalFiles;
	files.push(trajectoryJsonlFile("events.jsonl", events));
	files.push(jsonSupportBundleFile("session-branch.json", redactLocalPathValues(sanitizeDiagnosticPayload({
		header,
		leafId,
		entries: branchEntries
	}), redaction)));
	if (bundleRuntimeContext.systemPrompt) files.push(textSupportBundleFile("system-prompt.txt", redactLocalPathValues(bundleRuntimeContext.systemPrompt, redaction)));
	if (bundleRuntimeContext.tools) files.push(jsonSupportBundleFile("tools.json", redactLocalPathValues(bundleRuntimeContext.tools, redaction)));
	manifest.contents = [...supportBundleContents(files)];
	await writeSupportBundleDirectory({
		outputDir: params.outputDir,
		files: [jsonSupportBundleFile("manifest.json", manifest), ...files]
	});
	return {
		manifest,
		outputDir: params.outputDir,
		events,
		header,
		runtimeFile: runtimeFile && await isRegularNonSymlinkFile(runtimeFile) ? runtimeFile : void 0,
		supplementalFiles
	};
}
//#endregion
//#region src/trajectory/command-export.ts
async function validateExistingExportDirectory(params) {
	const linkStat = await fs.lstat(params.dir);
	if (linkStat.isSymbolicLink() || !linkStat.isDirectory()) throw new Error(`${params.label} must be a real directory inside the workspace`);
	const realDir = await fs.realpath(params.dir);
	if (!isPathInside(params.realWorkspace, realDir)) throw new Error("Trajectory exports directory must stay inside the workspace");
	return realDir;
}
async function mkdirIfMissingThenValidate(params) {
	try {
		await fs.mkdir(params.dir, { mode: 448 });
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	return await validateExistingExportDirectory(params);
}
async function resolveTrajectoryExportBaseDir(workspaceDir) {
	const workspacePath = path.resolve(workspaceDir);
	const realWorkspace = await fs.realpath(workspacePath);
	const stateDir = path.join(workspacePath, ".openclaw");
	await mkdirIfMissingThenValidate({
		dir: stateDir,
		label: "OpenClaw state directory",
		realWorkspace
	});
	const baseDir = path.join(stateDir, "trajectory-exports");
	const realBase = await mkdirIfMissingThenValidate({
		dir: baseDir,
		label: "Trajectory exports directory",
		realWorkspace
	});
	return {
		baseDir: path.resolve(baseDir),
		realBase
	};
}
async function resolveTrajectoryCommandOutputDir(params) {
	const { baseDir, realBase } = await resolveTrajectoryExportBaseDir(params.workspaceDir);
	const raw = params.outputPath?.trim();
	if (!raw) {
		const defaultDir = resolveDefaultTrajectoryExportDir({
			workspaceDir: params.workspaceDir,
			sessionId: params.sessionId
		});
		return path.join(baseDir, path.basename(defaultDir));
	}
	if (path.isAbsolute(raw) || raw.startsWith("~")) throw new Error("Output path must be relative to the workspace trajectory exports directory");
	const resolvedBase = path.resolve(baseDir);
	const outputDir = path.resolve(resolvedBase, raw);
	const relative = path.relative(resolvedBase, outputDir);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Output path must stay inside the workspace trajectory exports directory");
	let existingParent = outputDir;
	while (!await pathExists(existingParent)) {
		const next = path.dirname(existingParent);
		if (next === existingParent) break;
		existingParent = next;
	}
	if (!isPathInside(realBase, await fs.realpath(existingParent))) throw new Error("Output path must stay inside the real trajectory exports directory");
	return outputDir;
}
async function exportTrajectoryForCommand(params) {
	const bundle = await exportTrajectoryBundle({
		outputDir: params.outputDir ?? await resolveTrajectoryCommandOutputDir({
			outputPath: params.outputPath,
			workspaceDir: params.workspaceDir,
			sessionId: params.sessionId
		}),
		sessionFile: params.sessionFile,
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		workspaceDir: params.workspaceDir
	});
	const relativePath = path.relative(params.workspaceDir, bundle.outputDir);
	const displayPath = relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath) ? relativePath : path.basename(bundle.outputDir);
	const files = [
		"manifest.json",
		"events.jsonl",
		"session-branch.json"
	];
	if (bundle.events.some((event) => event.type === "context.compiled")) files.push("system-prompt.txt", "tools.json");
	files.push(...bundle.supplementalFiles);
	return {
		outputDir: bundle.outputDir,
		displayPath,
		sessionId: params.sessionId,
		eventCount: bundle.manifest.eventCount,
		runtimeEventCount: bundle.manifest.runtimeEventCount,
		transcriptEventCount: bundle.manifest.transcriptEventCount,
		files
	};
}
function formatTrajectoryCommandExportSummary(summary) {
	return [
		"✅ Trajectory exported!",
		"",
		`📦 Bundle: ${summary.displayPath}`,
		`🧵 Session: ${summary.sessionId}`,
		`📊 Events: ${summary.eventCount}`,
		`🧪 Runtime events: ${summary.runtimeEventCount}`,
		`📝 Transcript events: ${summary.transcriptEventCount}`,
		`📁 Files: ${summary.files.join(", ")}`
	].join("\n");
}
//#endregion
export { formatTrajectoryCommandExportSummary as n, exportTrajectoryForCommand as t };
