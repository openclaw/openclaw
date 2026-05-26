import { i as getRuntimeConfig } from "../../io-5xE1dPMK.js";
import { n as mutateConfigFile } from "../../mutate-FhI2HIyp.js";
import { t as definePluginEntry } from "../../plugin-entry-CJpThfKg.js";
import "../../config-mutation-BJc61hPG.js";
import "../../runtime-config-snapshot-pRc6W_Li.js";
import { a as DIR_LIST_TOOL_DESCRIPTOR, c as FILE_FETCH_TOOL_DESCRIPTOR, d as FILE_WRITE_TOOL_DESCRIPTOR, f as appendFileTransferAudit, r as DIR_FETCH_TOOL_DESCRIPTOR } from "../../descriptors-BOooEAcx.js";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { minimatch } from "minimatch";
//#region extensions/file-transfer/src/shared/policy.ts
function asFilePolicyConfig(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	return value;
}
function readFilePolicyConfigFromPluginConfig(pluginConfig) {
	if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) return null;
	const nodes = pluginConfig.nodes;
	return asFilePolicyConfig(nodes);
}
function readPluginConfigFromRuntimeConfig() {
	const plugins = getRuntimeConfig().plugins;
	if (!plugins || typeof plugins !== "object") return null;
	const entries = plugins.entries;
	if (!entries || typeof entries !== "object") return null;
	const entry = entries["file-transfer"];
	if (!entry || typeof entry !== "object") return null;
	const pluginConfig = entry.config;
	return pluginConfig && typeof pluginConfig === "object" && !Array.isArray(pluginConfig) ? pluginConfig : null;
}
function readFilePolicyConfig(pluginConfig) {
	return readFilePolicyConfigFromPluginConfig(readPluginConfigFromRuntimeConfig()) ?? readFilePolicyConfigFromPluginConfig(pluginConfig);
}
function expandTilde(p) {
	if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(p === "~" ? 1 : 2));
	return p;
}
function normalizeGlobs(patterns) {
	if (!Array.isArray(patterns)) return [];
	return patterns.filter((p) => typeof p === "string" && p.trim().length > 0).map((p) => expandTilde(p.trim()));
}
function matchesAny(target, patterns) {
	const normalizedTarget = target.replace(/\\/gu, "/");
	for (const pattern of patterns) {
		const normalizedPattern = pattern.replace(/\\/gu, "/");
		if (minimatch(target, pattern, { dot: true }) || minimatch(normalizedTarget, normalizedPattern, { dot: true })) return true;
	}
	return false;
}
function resolveNodePolicy(config, nodeId, nodeDisplayName) {
	const candidates = [nodeId, nodeDisplayName].filter((k) => typeof k === "string" && k.length > 0);
	for (const key of candidates) if (config[key]) return {
		key,
		entry: config[key]
	};
	if (config["*"]) return {
		key: "*",
		entry: config["*"]
	};
	return null;
}
function normalizeAskMode(value) {
	if (value === "on-miss" || value === "always" || value === "off") return value;
	return "off";
}
/**
* Evaluate whether (nodeId, kind, path) is permitted.
*
* Resolution order:
*   1. No file-transfer config or no entry for this node → NO_POLICY (deny,
*      not askable — operator hasn't opted in at all).
*   2. denyPaths matches → POLICY_DENIED, not askable (hard deny).
*   3. ask=always → ask-always (prompt every time).
*   4. allowPaths matches → matched-allow (silent allow).
*   5. ask=on-miss → POLICY_DENIED with askable=true.
*   6. ask=off (or unset) → POLICY_DENIED, not askable.
*/
/**
* Reject any path whose RAW string contains a ".." segment. Checking the
* raw string (not the normalized form) is the point — `posix.normalize`
* collapses "/allowed/../etc/passwd" to "/etc/passwd", which would defeat
* the check. We want to flag the literal traversal sequence the agent
* passed in, before any glob match runs.
*
* Without this, "/allowed/../etc/passwd" matches the glob "/allowed/**"
* pre-realpath, so the node fetches the bytes before the post-flight
* canonical-path check denies — too late, the bytes already crossed the
* node→gateway boundary.
*
* Treats backslash and forward slash as equivalent separators so a Windows
* node can't be hit with "C:\\allowed\\..\\Windows\\system.ini".
*/
function containsParentRefSegment(p) {
	return p.replace(/\\/gu, "/").split("/").includes("..");
}
function evaluateFilePolicy(input) {
	if (containsParentRefSegment(input.path)) return {
		ok: false,
		code: "POLICY_DENIED",
		reason: "path contains '..' segments; reject before glob match",
		askable: false
	};
	const config = readFilePolicyConfig(input.pluginConfig);
	if (!config) return {
		ok: false,
		code: "NO_POLICY",
		reason: "no plugins.entries.file-transfer.config.nodes config; file-transfer is deny-by-default until configured",
		askable: false
	};
	const resolved = resolveNodePolicy(config, input.nodeId, input.nodeDisplayName);
	if (!resolved) return {
		ok: false,
		code: "NO_POLICY",
		reason: `no file-transfer policy entry for "${input.nodeDisplayName ?? input.nodeId}"; configure plugins.entries.file-transfer.config.nodes or "*"`,
		askable: false
	};
	const nodeConfig = resolved.entry;
	const askMode = normalizeAskMode(nodeConfig.ask);
	const maxBytes = typeof nodeConfig.maxBytes === "number" && Number.isFinite(nodeConfig.maxBytes) ? Math.max(1, Math.floor(nodeConfig.maxBytes)) : void 0;
	const followSymlinks = nodeConfig.followSymlinks === true;
	const denyPatterns = normalizeGlobs(nodeConfig.denyPaths);
	if (matchesAny(input.path, denyPatterns)) return {
		ok: false,
		code: "POLICY_DENIED",
		reason: "path matches a denyPaths pattern",
		askable: false,
		askMode,
		maxBytes,
		followSymlinks
	};
	if (askMode === "always") return {
		ok: true,
		reason: "ask-always",
		askMode,
		maxBytes,
		followSymlinks
	};
	const allowPatterns = input.kind === "read" ? normalizeGlobs(nodeConfig.allowReadPaths) : normalizeGlobs(nodeConfig.allowWritePaths);
	if (allowPatterns.length > 0 && matchesAny(input.path, allowPatterns)) return {
		ok: true,
		reason: "matched-allow",
		maxBytes,
		followSymlinks
	};
	if (askMode === "on-miss") return {
		ok: false,
		code: "POLICY_DENIED",
		reason: `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
		askable: true,
		askMode,
		maxBytes,
		followSymlinks
	};
	return {
		ok: false,
		code: "POLICY_DENIED",
		reason: allowPatterns.length === 0 ? `no allow${input.kind === "read" ? "Read" : "Write"}Paths configured` : `path does not match any allow${input.kind === "read" ? "Read" : "Write"}Paths pattern`,
		askable: false,
		askMode,
		maxBytes,
		followSymlinks
	};
}
/**
* Persist an "allow-always" approval by appending the path to the
* relevant allowReadPaths / allowWritePaths list for the node. Uses
* mutateConfigFile so the change survives gateway restarts.
*
* Inserts under whichever key matched the policy (per-node entry, or
* the "*" wildcard if that's what was hit). If no entry exists yet,
* creates one keyed by nodeDisplayName ?? nodeId.
*/
/**
* Reject special object keys that would mutate the prototype chain when
* used as a property name (e.g. `__proto__` setter on a plain object).
* The nodeDisplayName comes from paired-node metadata which we don't
* fully control; refuse to persist policy under a key that could corrupt
* the plugin policy container's prototype.
*/
function assertSafeConfigKey(key) {
	if (key === "__proto__" || key === "prototype" || key === "constructor") throw new Error(`refusing to persist file-transfer policy under unsafe key: ${key}`);
	return key;
}
async function persistAllowAlways(input) {
	const field = input.kind === "read" ? "allowReadPaths" : "allowWritePaths";
	await mutateConfigFile({
		afterWrite: {
			mode: "none",
			reason: "file-transfer allow-always policy update"
		},
		mutate: (draft) => {
			const root = draft;
			const plugins = root.plugins ??= {};
			const entries = plugins.entries ??= {};
			const pluginEntry = entries["file-transfer"] ??= {};
			const pluginConfig = pluginEntry.config ??= {};
			const fileTransfer = pluginConfig.nodes ??= {};
			let key = [input.nodeId, input.nodeDisplayName].filter((k) => typeof k === "string" && k.length > 0).find((c) => Object.prototype.hasOwnProperty.call(fileTransfer, c));
			if (!key) {
				key = assertSafeConfigKey(input.nodeDisplayName ?? input.nodeId);
				fileTransfer[key] = {};
			}
			const entry = fileTransfer[key];
			const list = Array.isArray(entry[field]) ? entry[field] : [];
			if (!list.includes(input.path)) list.push(input.path);
			entry[field] = list;
		}
	});
}
//#endregion
//#region extensions/file-transfer/src/shared/node-invoke-policy.ts
const FILE_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const FILE_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS = 3e4;
const DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const COMMANDS = [
	"file.fetch",
	"dir.list",
	"dir.fetch",
	"file.write"
];
function asRecord(value) {
	return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function readPath(params) {
	return typeof params.path === "string" ? params.path.trim() : "";
}
function readMaxBytes(input) {
	const requested = typeof input.value === "number" && Number.isFinite(input.value) ? Math.floor(input.value) : input.defaultValue;
	const clamped = Math.max(1, Math.min(requested, input.hardMax));
	return input.policyMax ? Math.min(clamped, input.policyMax) : clamped;
}
function commandKind(command) {
	return command === "file.write" ? "write" : "read";
}
function promptVerb(command) {
	switch (command) {
		case "dir.fetch": return "Fetch directory";
		case "dir.list": return "List directory";
		case "file.write": return "Write file";
		case "file.fetch": return "Read file";
	}
	return command;
}
async function requestApproval(input) {
	const nodeDisplayName = input.ctx.node?.displayName;
	const decision = evaluateFilePolicy({
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		kind: input.kind,
		path: input.path,
		pluginConfig: input.ctx.pluginConfig
	});
	if (decision.ok && decision.reason === "matched-allow") return {
		ok: true,
		followSymlinks: decision.followSymlinks,
		maxBytes: decision.maxBytes
	};
	if (!(decision.ok && decision.reason === "ask-always" || !decision.ok && decision.askable)) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: !decision.ok && decision.code === "NO_POLICY" ? "denied:no_policy" : "denied:policy",
			errorCode: decision.ok ? void 0 : decision.code,
			reason: decision.ok ? decision.reason : decision.reason,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			code: decision.ok ? "POLICY_DENIED" : decision.code,
			message: `${input.op} ${decision.ok ? "POLICY_DENIED" : decision.code}: ${decision.reason}`
		};
	}
	const approvals = input.ctx.approvals;
	if (!approvals) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: "denied:approval",
			reason: "plugin approvals unavailable",
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			code: "APPROVAL_UNAVAILABLE",
			message: `${input.op} APPROVAL_UNAVAILABLE: plugin approvals unavailable`
		};
	}
	const verb = promptVerb(input.op);
	const subject = nodeDisplayName ?? input.ctx.nodeId;
	const approval = await approvals.request({
		title: `${verb}: ${input.path}`,
		description: `Allow ${verb.toLowerCase()} on ${subject}\nPath: ${input.path}\nKind: ${input.kind}\n\n"allow-always" appends this exact path to allow${input.kind === "read" ? "Read" : "Write"}Paths.`,
		severity: input.kind === "write" ? "warning" : "info",
		toolName: input.op
	});
	if (approval.decision === "deny" || approval.decision === null || !approval.decision) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: "denied:approval",
			reason: approval.decision === "deny" ? "operator denied" : "no operator available",
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			code: approval.decision === "deny" ? "APPROVAL_DENIED" : "APPROVAL_UNAVAILABLE",
			message: approval.decision === "deny" ? `${input.op} APPROVAL_DENIED: operator denied the prompt` : `${input.op} APPROVAL_UNAVAILABLE: no operator client connected to approve the request`
		};
	}
	if (approval.decision === "allow-always") try {
		await persistAllowAlways({
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			kind: input.kind,
			path: input.path
		});
		const refreshed = evaluateFilePolicy({
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			kind: input.kind,
			path: input.path,
			pluginConfig: input.ctx.pluginConfig
		});
		if (refreshed.ok) {
			await appendFileTransferAudit({
				op: input.op,
				nodeId: input.ctx.nodeId,
				nodeDisplayName,
				requestedPath: input.path,
				decision: "allowed:always",
				durationMs: Date.now() - input.startedAt
			});
			return {
				ok: true,
				followSymlinks: refreshed.followSymlinks,
				maxBytes: refreshed.maxBytes
			};
		}
	} catch (error) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.path,
			decision: "allowed:always",
			reason: `persist failed: ${String(error)}`,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: true,
			followSymlinks: decision.ok ? decision.followSymlinks : false,
			maxBytes: decision.maxBytes
		};
	}
	await appendFileTransferAudit({
		op: input.op,
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		requestedPath: input.path,
		decision: approval.decision === "allow-always" ? "allowed:always" : "allowed:once",
		durationMs: Date.now() - input.startedAt
	});
	return {
		ok: true,
		followSymlinks: decision.ok ? decision.followSymlinks : false,
		maxBytes: decision.maxBytes
	};
}
function prepareParams(input) {
	const next = {
		...input.params,
		followSymlinks: input.followSymlinks
	};
	delete next.preflightOnly;
	if (input.command === "file.fetch") next.maxBytes = readMaxBytes({
		value: input.params.maxBytes,
		defaultValue: FILE_FETCH_DEFAULT_MAX_BYTES,
		hardMax: FILE_FETCH_HARD_MAX_BYTES,
		policyMax: input.maxBytes
	});
	else if (input.command === "dir.fetch") next.maxBytes = readMaxBytes({
		value: input.params.maxBytes,
		defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
		hardMax: DIR_FETCH_HARD_MAX_BYTES,
		policyMax: input.maxBytes
	});
	return next;
}
function readResultPayload(result) {
	return result.payload && typeof result.payload === "object" && !Array.isArray(result.payload) ? result.payload : null;
}
function joinRemotePolicyPath(root, relPath) {
	const rel = relPath.replace(/\\/gu, "/").replace(/^\.\//u, "");
	if (!rel || rel === ".") return root;
	const sep = root.includes("\\") && !root.includes("/") ? "\\" : "/";
	const prefix = root.replace(/[\\/]$/u, "") || sep;
	return `${prefix}${prefix.endsWith(sep) ? "" : sep}${rel.split("/").join(sep)}`;
}
function validateDirFetchPreflightEntry(entry) {
	if (entry.includes("\0")) return {
		ok: false,
		reason: "entry contains NUL byte"
	};
	const normalized = entry.replace(/\\/gu, "/").replace(/^\.\//u, "");
	if (!normalized || normalized === ".") return {
		ok: false,
		reason: "entry is empty"
	};
	if (normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized)) return {
		ok: false,
		reason: "entry is absolute"
	};
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) return {
		ok: false,
		reason: "entry contains '..' traversal"
	};
	return { ok: true };
}
function normalizeTarEntryPath(entry) {
	const normalized = entry.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/\/$/u, "");
	return normalized.length > 0 ? normalized : null;
}
async function listDirFetchArchiveEntries(payload) {
	const tarBase64 = typeof payload?.tarBase64 === "string" ? payload.tarBase64 : "";
	if (!tarBase64) return {
		ok: false,
		code: "ARCHIVE_ENTRIES_MISSING",
		reason: "dir.fetch archive did not return tarBase64"
	};
	const tarBuffer = Buffer.from(tarBase64, "base64");
	return await new Promise((resolve) => {
		const child = spawn(process.platform !== "win32" ? "/usr/bin/tar" : "tar", ["-tzf", "-"], { stdio: [
			"pipe",
			"pipe",
			"pipe"
		] });
		let stdout = "";
		let stderr = "";
		let aborted = false;
		const watchdog = setTimeout(() => {
			aborted = true;
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve({
				ok: false,
				code: "ARCHIVE_ENTRIES_UNREADABLE",
				reason: "tar -tzf timed out"
			});
		}, DIR_FETCH_ARCHIVE_LIST_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			if (stdout.length > DIR_FETCH_ARCHIVE_LIST_MAX_OUTPUT_BYTES) {
				aborted = true;
				clearTimeout(watchdog);
				try {
					child.kill("SIGKILL");
				} catch {}
				resolve({
					ok: false,
					code: "ARCHIVE_ENTRIES_UNREADABLE",
					reason: "tar -tzf output too large"
				});
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("close", (code) => {
			clearTimeout(watchdog);
			if (aborted) return;
			if (code !== 0) {
				resolve({
					ok: false,
					code: "ARCHIVE_ENTRIES_UNREADABLE",
					reason: `tar -tzf exited ${code}: ${stderr.slice(0, 200)}`
				});
				return;
			}
			resolve({
				ok: true,
				entries: stdout.split("\n").map(normalizeTarEntryPath).filter((entry) => entry !== null)
			});
		});
		child.on("error", (error) => {
			clearTimeout(watchdog);
			if (!aborted) resolve({
				ok: false,
				code: "ARCHIVE_ENTRIES_UNREADABLE",
				reason: `tar -tzf error: ${String(error)}`
			});
		});
		child.stdin.end(tarBuffer);
	});
}
async function validateDirFetchEntries(input) {
	const nodeDisplayName = input.ctx.node?.displayName;
	const missingCode = input.phase === "preflight" ? "PREFLIGHT_ENTRIES_MISSING" : "ARCHIVE_ENTRIES_MISSING";
	const invalidCode = input.phase === "preflight" ? "PREFLIGHT_ENTRY_INVALID" : "ARCHIVE_ENTRY_INVALID";
	if (!Array.isArray(input.entries)) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			canonicalPath: input.canonicalPath,
			decision: "error",
			errorCode: missingCode,
			reason: `dir.fetch ${input.phase} did not return entries`,
			durationMs: Date.now() - input.startedAt
		});
		return policyDeniedResult({
			op: input.op,
			code: missingCode,
			message: `dir.fetch ${input.phase} did not return entries; refusing archive transfer`,
			details: { path: input.canonicalPath }
		});
	}
	const entries = [];
	for (const entry of input.entries) {
		if (typeof entry !== "string" || entry.length === 0) {
			await appendFileTransferAudit({
				op: input.op,
				nodeId: input.ctx.nodeId,
				nodeDisplayName,
				requestedPath: input.requestedPath,
				canonicalPath: input.canonicalPath,
				decision: "denied:policy",
				errorCode: invalidCode,
				reason: "entry is not a non-empty string",
				durationMs: Date.now() - input.startedAt
			});
			return policyDeniedResult({
				op: input.op,
				code: invalidCode,
				message: `directory ${input.phase} entry is invalid: entry is not a non-empty string`,
				details: {
					path: input.canonicalPath,
					reason: "entry is not a non-empty string"
				}
			});
		}
		const entryValidation = validateDirFetchPreflightEntry(entry);
		if (!entryValidation.ok) {
			const candidate = joinRemotePolicyPath(input.canonicalPath, entry);
			await appendFileTransferAudit({
				op: input.op,
				nodeId: input.ctx.nodeId,
				nodeDisplayName,
				requestedPath: input.requestedPath,
				canonicalPath: candidate,
				decision: "denied:policy",
				errorCode: invalidCode,
				reason: entryValidation.reason,
				durationMs: Date.now() - input.startedAt
			});
			return policyDeniedResult({
				op: input.op,
				code: invalidCode,
				message: `directory ${input.phase} entry ${entry} is invalid: ${entryValidation.reason}`,
				details: {
					path: candidate,
					reason: entryValidation.reason
				}
			});
		}
		entries.push(entry);
	}
	const candidates = [input.canonicalPath, ...entries.map((entry) => joinRemotePolicyPath(input.canonicalPath, entry))];
	for (const candidate of candidates) {
		const policy = evaluateFilePolicy({
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			kind: "read",
			path: candidate,
			pluginConfig: input.ctx.pluginConfig
		});
		if (policy.ok) continue;
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			canonicalPath: candidate,
			decision: "denied:policy",
			errorCode: policy.code,
			reason: policy.reason,
			durationMs: Date.now() - input.startedAt
		});
		return policyDeniedResult({
			op: input.op,
			code: "PATH_POLICY_DENIED",
			message: `directory ${input.phase} entry ${candidate} is not allowed by policy: ${policy.reason}`,
			details: {
				path: candidate,
				reason: policy.reason
			}
		});
	}
	return null;
}
function policyDeniedResult(input) {
	return {
		ok: false,
		code: input.code,
		message: `${input.op} ${input.code}: ${input.message}`,
		...input.details ? { details: input.details } : {}
	};
}
async function invokePreflight(input) {
	const nodeDisplayName = input.ctx.node?.displayName;
	const preflight = await input.ctx.invokeNode({ params: {
		...input.params,
		preflightOnly: true
	} });
	if (!preflight.ok) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			decision: "error",
			errorCode: preflight.code,
			errorMessage: preflight.message,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			result: {
				ok: false,
				code: preflight.code,
				message: `${input.op} failed: ${preflight.message}`,
				details: preflight.details,
				unavailable: true
			}
		};
	}
	const payload = readResultPayload(preflight);
	if (payload?.ok === false) {
		await appendFileTransferAudit({
			op: input.op,
			nodeId: input.ctx.nodeId,
			nodeDisplayName,
			requestedPath: input.requestedPath,
			canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : void 0,
			decision: "error",
			errorCode: typeof payload.code === "string" ? payload.code : void 0,
			errorMessage: typeof payload.message === "string" ? payload.message : void 0,
			durationMs: Date.now() - input.startedAt
		});
		return {
			ok: false,
			result: preflight
		};
	}
	return {
		ok: true,
		payload,
		canonicalPath: payload && typeof payload.path === "string" && payload.path ? payload.path : input.requestedPath
	};
}
async function runPathPreflight(input) {
	const preflight = await invokePreflight(input);
	if (!preflight.ok) return preflight.result;
	const nodeDisplayName = input.ctx.node?.displayName;
	const { canonicalPath } = preflight;
	if (canonicalPath === input.requestedPath) return null;
	const policy = evaluateFilePolicy({
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		kind: input.kind,
		path: canonicalPath,
		pluginConfig: input.ctx.pluginConfig
	});
	if (policy.ok) return null;
	await appendFileTransferAudit({
		op: input.op,
		nodeId: input.ctx.nodeId,
		nodeDisplayName,
		requestedPath: input.requestedPath,
		canonicalPath,
		decision: "denied:symlink_escape",
		errorCode: policy.code,
		reason: policy.reason,
		durationMs: Date.now() - input.startedAt
	});
	return {
		ok: false,
		code: "SYMLINK_TARGET_DENIED",
		message: `${input.op} SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`
	};
}
async function runDirFetchPreflight(input) {
	const preflight = await invokePreflight(input);
	if (!preflight.ok) return preflight.result;
	return await validateDirFetchEntries({
		ctx: input.ctx,
		op: input.op,
		requestedPath: input.requestedPath,
		canonicalPath: preflight.canonicalPath,
		entries: preflight.payload?.entries,
		startedAt: input.startedAt,
		phase: "preflight"
	});
}
async function handleFileTransferInvoke(ctx) {
	if (!COMMANDS.includes(ctx.command)) return {
		ok: false,
		code: "UNSUPPORTED_COMMAND",
		message: "unsupported file-transfer command"
	};
	const command = ctx.command;
	const op = command;
	const params = asRecord(ctx.params);
	const requestedPath = readPath(params);
	const nodeDisplayName = ctx.node?.displayName;
	const startedAt = Date.now();
	if (!requestedPath) return {
		ok: false,
		code: "INVALID_PARAMS",
		message: `${op} path required`
	};
	const gate = await requestApproval({
		ctx,
		op,
		kind: commandKind(command),
		path: requestedPath,
		startedAt
	});
	if (!gate.ok) return {
		ok: false,
		code: gate.code,
		message: gate.message
	};
	const forwardedParams = prepareParams({
		command,
		params,
		followSymlinks: gate.followSymlinks,
		maxBytes: gate.maxBytes
	});
	if (command === "file.fetch") {
		const preflightDeny = await runPathPreflight({
			ctx,
			op,
			kind: "read",
			params: forwardedParams,
			requestedPath,
			startedAt
		});
		if (preflightDeny) return preflightDeny;
	} else if (command === "file.write") {
		const preflightDeny = await runPathPreflight({
			ctx,
			op,
			kind: "write",
			params: forwardedParams,
			requestedPath,
			startedAt
		});
		if (preflightDeny) return preflightDeny;
	} else if (command === "dir.fetch") {
		const preflightDeny = await runDirFetchPreflight({
			ctx,
			op,
			params: forwardedParams,
			requestedPath,
			startedAt
		});
		if (preflightDeny) return preflightDeny;
	}
	const result = await ctx.invokeNode({ params: forwardedParams });
	if (!result.ok) {
		await appendFileTransferAudit({
			op,
			nodeId: ctx.nodeId,
			nodeDisplayName,
			requestedPath,
			decision: "error",
			errorCode: result.code,
			errorMessage: result.message,
			durationMs: Date.now() - startedAt
		});
		return {
			ok: false,
			code: result.code,
			message: `${op} failed: ${result.message}`,
			details: result.details,
			unavailable: true
		};
	}
	const payload = readResultPayload(result);
	if (payload?.ok === false) {
		await appendFileTransferAudit({
			op,
			nodeId: ctx.nodeId,
			nodeDisplayName,
			requestedPath,
			canonicalPath: typeof payload.canonicalPath === "string" ? payload.canonicalPath : void 0,
			decision: "error",
			errorCode: typeof payload.code === "string" ? payload.code : void 0,
			errorMessage: typeof payload.message === "string" ? payload.message : void 0,
			durationMs: Date.now() - startedAt
		});
		return result;
	}
	const canonicalPath = payload && typeof payload.path === "string" && payload.path ? payload.path : requestedPath;
	if (canonicalPath !== requestedPath) {
		const postflight = evaluateFilePolicy({
			nodeId: ctx.nodeId,
			nodeDisplayName,
			kind: commandKind(command),
			path: canonicalPath,
			pluginConfig: ctx.pluginConfig
		});
		if (!postflight.ok) {
			await appendFileTransferAudit({
				op,
				nodeId: ctx.nodeId,
				nodeDisplayName,
				requestedPath,
				canonicalPath,
				decision: "denied:symlink_escape",
				errorCode: postflight.code,
				reason: postflight.reason,
				durationMs: Date.now() - startedAt
			});
			return {
				ok: false,
				code: "SYMLINK_TARGET_DENIED",
				message: `${op} SYMLINK_TARGET_DENIED: requested path resolved to ${canonicalPath} which is not allowed by policy`
			};
		}
	}
	if (command === "dir.fetch") {
		const archiveEntries = await listDirFetchArchiveEntries(payload);
		if (!archiveEntries.ok) {
			await appendFileTransferAudit({
				op,
				nodeId: ctx.nodeId,
				nodeDisplayName,
				requestedPath,
				canonicalPath,
				decision: "error",
				errorCode: archiveEntries.code,
				reason: archiveEntries.reason,
				durationMs: Date.now() - startedAt
			});
			return policyDeniedResult({
				op,
				code: archiveEntries.code,
				message: `${archiveEntries.reason}; refusing archive transfer`,
				details: {
					path: canonicalPath,
					reason: archiveEntries.reason
				}
			});
		}
		const archiveDeny = await validateDirFetchEntries({
			ctx,
			op,
			requestedPath,
			canonicalPath,
			entries: archiveEntries.entries,
			startedAt,
			phase: "archive"
		});
		if (archiveDeny) return archiveDeny;
	}
	await appendFileTransferAudit({
		op,
		nodeId: ctx.nodeId,
		nodeDisplayName,
		requestedPath,
		canonicalPath,
		decision: "allowed",
		sizeBytes: typeof payload?.size === "number" ? payload.size : void 0,
		sha256: typeof payload?.sha256 === "string" ? payload.sha256 : void 0,
		durationMs: Date.now() - startedAt
	});
	return result;
}
function createFileTransferNodeInvokePolicy() {
	return {
		commands: COMMANDS,
		handle: handleFileTransferInvoke
	};
}
//#endregion
//#region extensions/file-transfer/index.ts
function readNodeCommandParams(paramsJSON) {
	return paramsJSON ? JSON.parse(paramsJSON) : {};
}
function createLazyTool(descriptor, loadTool) {
	let toolPromise;
	const loadOnce = () => {
		toolPromise ??= loadTool();
		return toolPromise;
	};
	return {
		...descriptor,
		async execute(toolCallId, args, signal, onUpdate) {
			return await (await loadOnce()).execute(toolCallId, args, signal, onUpdate);
		}
	};
}
var file_transfer_default = definePluginEntry({
	id: "file-transfer",
	name: "File Transfer",
	description: "Fetch, list, and write files on paired nodes via dedicated node commands.",
	nodeHostCommands: [
		{
			command: "file.fetch",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleFileFetch } = await import("../../file-fetch-D37dYe4Z.js");
				const result = await handleFileFetch(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		},
		{
			command: "dir.list",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleDirList } = await import("../../dir-list-DmxGoyUu.js");
				const result = await handleDirList(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		},
		{
			command: "dir.fetch",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleDirFetch } = await import("../../dir-fetch-B_f_y5AY.js");
				const result = await handleDirFetch(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		},
		{
			command: "file.write",
			cap: "file",
			dangerous: true,
			handle: async (paramsJSON) => {
				const { handleFileWrite } = await import("../../file-write-CxHPTG_I.js");
				const result = await handleFileWrite(readNodeCommandParams(paramsJSON));
				return JSON.stringify(result);
			}
		}
	],
	register(api) {
		api.registerNodeInvokePolicy(createFileTransferNodeInvokePolicy());
		api.registerTool(createLazyTool(FILE_FETCH_TOOL_DESCRIPTOR, async () => {
			const { createFileFetchTool } = await import("../../file-fetch-tool-CkT41_vH.js");
			return createFileFetchTool();
		}));
		api.registerTool(createLazyTool(DIR_LIST_TOOL_DESCRIPTOR, async () => {
			const { createDirListTool } = await import("../../dir-list-tool-CG2gBUWd.js");
			return createDirListTool();
		}));
		api.registerTool(createLazyTool(DIR_FETCH_TOOL_DESCRIPTOR, async () => {
			const { createDirFetchTool } = await import("../../dir-fetch-tool-BtC0d7v0.js");
			return createDirFetchTool();
		}));
		api.registerTool(createLazyTool(FILE_WRITE_TOOL_DESCRIPTOR, async () => {
			const { createFileWriteTool } = await import("../../file-write-tool-HzYJK-NM.js");
			return createFileWriteTool();
		}));
	}
});
//#endregion
export { file_transfer_default as default };
