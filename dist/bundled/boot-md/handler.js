import { c as resolveAgentWorkspaceDir, r as listAgentIds } from "../../run-with-concurrency-CVkEQ26G.js";
import "../../paths-Cvc9EM8Y.js";
import { i as defaultRuntime, t as createSubsystemLogger } from "../../subsystem-B9UBebHR.js";
import { B as resolveAgentIdFromSessionKey } from "../../workspace-CJSTaOJf.js";
import "../../logger-5RiupzZ_.js";
import "../../model-selection-hBypV7rn.js";
import "../../github-copilot-token-BDioPmd6.js";
import { a as isGatewayStartupEvent } from "../../legacy-names-CdhkiTCG.js";
import "../../thinking-BTmZIepL.js";
import { n as SILENT_REPLY_TOKEN } from "../../tokens-DeKjMaTx.js";
import { a as agentCommand, o as createDefaultDeps } from "../../pi-embedded-B567dzV4.js";
import "../../plugins-DjZ0CVDU.js";
import "../../accounts-DdJPFalP.js";
import "../../send-RyhwGcIc.js";
import "../../send-CDteNscd.js";
import "../../deliver-BeGyllUh.js";
import "../../diagnostic-Baty9xY_.js";
import "../../accounts-CZzda7Dm.js";
import "../../image-ops-DTr9Cxst.js";
import "../../send-D3e7eeGG.js";
import "../../pi-model-discovery-C_D0uDwt.js";
import { Dt as resolveMainSessionKey, J as updateSessionStore, Tt as resolveAgentMainSessionKey, W as loadSessionStore } from "../../pi-embedded-helpers-BqdZ2WJ4.js";
import "../../chrome-Dr7FDJN9.js";
import "../../frontmatter-DdUAZ1DV.js";
import "../../skills-C97Yv--s.js";
import "../../path-alias-guards-Tm_5BzS2.js";
import "../../redact-BkJnViY6.js";
import "../../errors-XoYNBNa9.js";
import "../../fs-safe-54mRDvhR.js";
import "../../proxy-env-8K0ubHqJ.js";
import "../../store-B4Adu_41.js";
import "../../accounts--DUgGZBF.js";
import { s as resolveStorePath } from "../../paths-C47m6bhv.js";
import "../../tool-images-DR3jtxfE.js";
import "../../image-ByJbTOAc.js";
import "../../audio-transcription-runner-DgL0NvDd.js";
import "../../fetch-BchUD2xl.js";
import "../../fetch-guard-DoTHIOVQ.js";
import "../../api-key-rotation-BdB4aSfv.js";
import "../../proxy-fetch-Bc_b6yL6.js";
import "../../ir-CVwrRj_q.js";
import "../../render-DW7AcFdD.js";
import "../../target-errors-DcPo64JL.js";
import "../../commands-registry-CIs77ZVZ.js";
import "../../skill-commands-D-_ZmD4H.js";
import "../../fetch-BfuG8uZ8.js";
import "../../channel-activity-CpiWAbS4.js";
import "../../tables-DdpYLMEi.js";
import "../../send-BC2a3seQ.js";
import "../../outbound-attachment-Cub4BROY.js";
import "../../send-E9xIAeAw.js";
import "../../proxy-CecQTx_Z.js";
import "../../manager-BnW9YPmf.js";
import "../../query-expansion-D15-YN6n.js";
import fs from "node:fs/promises";
import path from "node:path";
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
		return err instanceof Error ? err.message : String(err);
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
		const message = err instanceof Error ? err.message : String(err);
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
		agentFailure = err instanceof Error ? err.message : String(err);
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
	const agentIds = listAgentIds(cfg);
	for (const agentId of agentIds) {
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const result = await runBootOnce({
			cfg,
			deps,
			workspaceDir,
			agentId
		});
		if (result.status === "failed") {
			log.warn("boot-md failed for agent startup run", {
				agentId,
				workspaceDir,
				reason: result.reason
			});
			continue;
		}
		if (result.status === "skipped") log.debug("boot-md skipped for agent startup run", {
			agentId,
			workspaceDir,
			reason: result.reason
		});
	}
};

//#endregion
export { runBootChecklist as default };