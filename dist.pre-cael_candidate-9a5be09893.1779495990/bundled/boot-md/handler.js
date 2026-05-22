import { i as formatErrorMessage } from "../../errors-D3K0qXmL.js";
import "../../agent-scope-Bl5pjInQ.js";
import { u as resolveAgentIdFromSessionKey } from "../../session-key-BAP1m9Ju.js";
import { n as listAgentIds, o as resolveAgentWorkspaceDir } from "../../agent-scope-config-Dm11aCiH.js";
import { n as defaultRuntime } from "../../runtime-yzlkhCoS.js";
import { t as createSubsystemLogger } from "../../subsystem-B30d2Pdj.js";
import { o as isGatewayStartupEvent } from "../../internal-hooks-DUT-LIo-.js";
import { i as resolveMainSessionKey, n as resolveAgentMainSessionKey } from "../../main-session-DkcVDKOd.js";
import { u as resolveStorePath } from "../../paths-DE6QEn2i.js";
import { t as loadSessionStore } from "../../store-load-BKiPIr-m.js";
import { s as updateSessionStore } from "../../store-CSNEKBzE.js";
import { n as SILENT_REPLY_TOKEN } from "../../tokens-CjU2eT93.js";
import { t as agentCommand } from "../../agent-command-AtghHVIm.js";
import { t as createDefaultDeps } from "../../deps-rbNI_GRb.js";
import "../../agent-BYNRli8E.js";
import { t as runStartupTasks } from "../../startup-tasks-BInOyzq5.js";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
//#region src/gateway/boot.ts
function generateBootSessionId() {
	return `boot-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "")}-${crypto.randomUUID().slice(0, 8)}`;
}
const log$1 = createSubsystemLogger("gateway/boot");
const BOOT_FILENAME = "BOOT.md";
function buildBootPrompt(content) {
	return [
		"You are running a boot check. Follow BOOT.md instructions exactly.",
		"",
		"BOOT.md:",
		content,
		"",
		"If BOOT.md asks you to send a message, use the message tool (action=send with channel + target).",
		"Use the `target` field (not `to`) for message tool destinations.",
		`After sending with the message tool, reply with ONLY: ${SILENT_REPLY_TOKEN}.`,
		`If nothing needs attention, reply with ONLY: ${SILENT_REPLY_TOKEN}.`
	].join("\n");
}
async function loadBootFile(workspaceDir) {
	const bootPath = path.join(workspaceDir, BOOT_FILENAME);
	try {
		const trimmed = (await fs.readFile(bootPath, "utf-8")).trim();
		if (!trimmed) return { status: "empty" };
		return {
			status: "ok",
			content: trimmed
		};
	} catch (err) {
		if (err.code === "ENOENT") return { status: "missing" };
		throw err;
	}
}
function snapshotMainSessionMapping(params) {
	const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
	const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
	try {
		const entry = loadSessionStore(storePath, { skipCache: true })[params.sessionKey];
		if (!entry) return {
			storePath,
			sessionKey: params.sessionKey,
			canRestore: true,
			hadEntry: false
		};
		return {
			storePath,
			sessionKey: params.sessionKey,
			canRestore: true,
			hadEntry: true,
			entry: structuredClone(entry)
		};
	} catch (err) {
		log$1.debug("boot: could not snapshot main session mapping", {
			sessionKey: params.sessionKey,
			error: String(err)
		});
		return {
			storePath,
			sessionKey: params.sessionKey,
			canRestore: false,
			hadEntry: false
		};
	}
}
async function restoreMainSessionMapping(snapshot) {
	if (!snapshot.canRestore) return;
	try {
		await updateSessionStore(snapshot.storePath, (store) => {
			if (snapshot.hadEntry && snapshot.entry) {
				store[snapshot.sessionKey] = snapshot.entry;
				return;
			}
			delete store[snapshot.sessionKey];
		}, { activeSessionKey: snapshot.sessionKey });
		return;
	} catch (err) {
		return formatErrorMessage(err);
	}
}
async function runBootOnce(params) {
	const bootRuntime = {
		log: () => {},
		error: (message) => log$1.error(String(message)),
		exit: defaultRuntime.exit
	};
	let result;
	try {
		result = await loadBootFile(params.workspaceDir);
	} catch (err) {
		const message = formatErrorMessage(err);
		log$1.error(`boot: failed to read ${BOOT_FILENAME}: ${message}`);
		return {
			status: "failed",
			reason: message
		};
	}
	if (result.status === "missing" || result.status === "empty") return {
		status: "skipped",
		reason: result.status
	};
	const sessionKey = params.agentId ? resolveAgentMainSessionKey({
		cfg: params.cfg,
		agentId: params.agentId
	}) : resolveMainSessionKey(params.cfg);
	const message = buildBootPrompt(result.content ?? "");
	const sessionId = generateBootSessionId();
	const mappingSnapshot = snapshotMainSessionMapping({
		cfg: params.cfg,
		sessionKey
	});
	let agentFailure;
	try {
		await agentCommand({
			message,
			sessionKey,
			sessionId,
			deliver: false,
			senderIsOwner: true
		}, bootRuntime, params.deps);
	} catch (err) {
		agentFailure = formatErrorMessage(err);
		log$1.error(`boot: agent run failed: ${agentFailure}`);
	}
	const mappingRestoreFailure = await restoreMainSessionMapping(mappingSnapshot);
	if (mappingRestoreFailure) log$1.error(`boot: failed to restore main session mapping: ${mappingRestoreFailure}`);
	if (!agentFailure && !mappingRestoreFailure) return { status: "ran" };
	return {
		status: "failed",
		reason: [agentFailure ? `agent run failed: ${agentFailure}` : void 0, mappingRestoreFailure ? `mapping restore failed: ${mappingRestoreFailure}` : void 0].filter((part) => Boolean(part)).join("; ")
	};
}
//#endregion
//#region src/hooks/bundled/boot-md/handler.ts
const log = createSubsystemLogger("hooks/boot-md");
const runBootChecklist = async (event) => {
	if (!isGatewayStartupEvent(event)) return;
	if (!event.context.cfg) return;
	const cfg = event.context.cfg;
	const deps = event.context.deps ?? createDefaultDeps();
	const seenWorkspaces = /* @__PURE__ */ new Set();
	await runStartupTasks({
		tasks: listAgentIds(cfg).map((agentId) => {
			return {
				agentId,
				workspaceDir: resolveAgentWorkspaceDir(cfg, agentId)
			};
		}).filter(({ workspaceDir }) => {
			if (seenWorkspaces.has(workspaceDir)) return false;
			seenWorkspaces.add(workspaceDir);
			return true;
		}).map(({ agentId, workspaceDir }) => ({
			source: "boot-md",
			agentId,
			workspaceDir,
			run: () => runBootOnce({
				cfg,
				deps,
				workspaceDir,
				agentId
			})
		})),
		log
	});
};
//#endregion
export { runBootChecklist as default };
