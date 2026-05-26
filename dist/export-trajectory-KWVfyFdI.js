import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { E as pathExists } from "./fs-safe-CV86zY9G.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { r as writeRuntimeJson } from "./runtime-yzlkhCoS.js";
import { a as resolveSessionFilePathOptions, i as resolveSessionFilePath, r as resolveDefaultSessionStorePath } from "./paths-Bg3PO6Gj.js";
import { t as loadSessionStore } from "./store-load-z4thf6ld.js";
import "./store-BmtchQvp.js";
import { n as formatTrajectoryCommandExportSummary, t as exportTrajectoryForCommand } from "./command-export-VNYzc1XT.js";
import path from "node:path";
//#region src/commands/export-trajectory.ts
const ENCODED_EXPORT_REQUEST_RE = /^[A-Za-z0-9_-]{1,65536}$/u;
function readOptionalString(value) {
	return typeof value === "string" && value.trim().length > 0 ? value : void 0;
}
function decodeExportTrajectoryRequest(encoded) {
	const trimmed = encoded.trim();
	if (!ENCODED_EXPORT_REQUEST_RE.test(trimmed)) throw new Error("Encoded trajectory export request is invalid");
	let decoded;
	try {
		decoded = JSON.parse(Buffer.from(trimmed, "base64url").toString("utf8"));
	} catch {
		throw new Error("Encoded trajectory export request is invalid JSON");
	}
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("Encoded trajectory export request must be a JSON object");
	const request = decoded;
	const opts = {};
	const sessionKey = readOptionalString(request.sessionKey);
	if (sessionKey !== void 0) opts.sessionKey = sessionKey;
	const output = readOptionalString(request.output);
	if (output !== void 0) opts.output = output;
	const store = readOptionalString(request.store);
	if (store !== void 0) opts.store = store;
	const agent = readOptionalString(request.agent);
	if (agent !== void 0) opts.agent = agent;
	const workspace = readOptionalString(request.workspace);
	if (workspace !== void 0) opts.workspace = workspace;
	return opts;
}
function resolveExportTrajectoryOptions(opts) {
	const encoded = opts.requestJsonBase64?.trim();
	if (!encoded) return opts;
	return {
		...opts,
		...decodeExportTrajectoryRequest(encoded)
	};
}
async function exportTrajectoryCommand(opts, runtime) {
	let resolvedOpts;
	try {
		resolvedOpts = resolveExportTrajectoryOptions(opts);
	} catch (error) {
		runtime.error(`Failed to decode trajectory export request: ${formatErrorMessage(error)}`);
		runtime.exit(1);
		return;
	}
	const sessionKey = resolvedOpts.sessionKey?.trim();
	if (!sessionKey) {
		runtime.error(`--session-key is required. Run ${formatCliCommand("openclaw sessions")} to choose a session.`);
		runtime.exit(1);
		return;
	}
	const targetAgentId = resolvedOpts.agent ?? resolveAgentIdFromSessionKey(sessionKey);
	const storePath = resolvedOpts.store ? path.resolve(resolvedOpts.store) : resolveDefaultSessionStorePath(targetAgentId);
	const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
	if (!entry?.sessionId) {
		runtime.error(`Session not found: ${sessionKey}. Run ${formatCliCommand("openclaw sessions")} to see available sessions.`);
		runtime.exit(1);
		return;
	}
	let sessionFile;
	try {
		sessionFile = resolveSessionFilePath(entry.sessionId, entry, resolveSessionFilePathOptions({
			agentId: targetAgentId,
			storePath
		}));
	} catch (error) {
		runtime.error(`Failed to resolve session file: ${formatErrorMessage(error)}`);
		runtime.exit(1);
		return;
	}
	if (!await pathExists(sessionFile)) {
		runtime.error(`Session file not found for ${sessionKey}. Run ${formatCliCommand("openclaw doctor")} to inspect session storage.`);
		runtime.exit(1);
		return;
	}
	let summary;
	try {
		summary = await exportTrajectoryForCommand({
			outputPath: resolvedOpts.output,
			sessionFile,
			sessionId: entry.sessionId,
			sessionKey,
			workspaceDir: path.resolve(resolvedOpts.workspace ?? process.cwd())
		});
	} catch (error) {
		runtime.error(`Failed to export trajectory: ${formatErrorMessage(error)}`);
		runtime.exit(1);
		return;
	}
	if (resolvedOpts.json) {
		writeRuntimeJson(runtime, summary);
		return;
	}
	runtime.log(formatTrajectoryCommandExportSummary(summary));
}
//#endregion
export { exportTrajectoryCommand };
