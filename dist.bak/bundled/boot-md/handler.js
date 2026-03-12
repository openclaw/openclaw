import { n as listAgentIds, s as resolveAgentWorkspaceDir } from "../../agent-scope-ET3-KDD1.js";
import "../../paths-MYHBPf85.js";
import { pt as isGatewayStartupEvent, r as defaultRuntime, t as createSubsystemLogger } from "../../subsystem-CYLd4dcj.js";
import { l as resolveAgentIdFromSessionKey } from "../../session-key-CPPWn8gW.js";
import "../../workspace-PvhqUv3h.js";
import "../../model-selection-DOYvU3hc.js";
import "../../github-copilot-token-DyM1y5Pr.js";
import "../../env-DioSf1y0.js";
import "../../boolean-Ce2-qkSB.js";
import "../../dock-B066-9Rj.js";
import { n as SILENT_REPLY_TOKEN } from "../../tokens-BbMquAae.js";
import { a as createDefaultDeps, i as agentCommand } from "../../pi-embedded-vtzKgCPR.js";
import "../../plugins-DUx2IkaN.js";
import "../../accounts-4SEfqy3O.js";
import "../../bindings-TAejNrPZ.js";
import "../../send-CuT_IAxo.js";
import "../../send-Daa6sK7I.js";
import "../../deliver-BSV7SUGt.js";
import "../../diagnostic-D9vs_fb5.js";
import "../../diagnostic-session-state-_tGY1a3B.js";
import "../../accounts-DhD7OMBH.js";
import "../../send-DZkT7Lin.js";
import "../../image-ops-D98Q4dLq.js";
import "../../pi-model-discovery-B1pl3ZAU.js";
import "../../message-channel-rHdyUBOJ.js";
import "../../pi-embedded-helpers-DLdc_PG7.js";
import "../../chrome-DNpJVmqn.js";
import "../../ssrf-GR1wTjsC.js";
import "../../frontmatter-CthhXKqf.js";
import "../../skills-D8Wcotgx.js";
import "../../path-alias-guards-Ck6h4R-2.js";
import "../../redact-BsXsyykh.js";
import "../../errors-kKzMhHcT.js";
import "../../fs-safe-D8h6zmZn.js";
import "../../store-BPoOdDyW.js";
import { U as resolveMainSessionKey, V as resolveAgentMainSessionKey, d as updateSessionStore, s as loadSessionStore } from "../../sessions-BLHmBFe6.js";
import "../../accounts-CpA_IJ0G.js";
import { l as resolveStorePath } from "../../paths-6XrpQmMB.js";
import "../../tool-images-C4bZaIjc.js";
import "../../thinking-CJoHneR6.js";
import "../../image-DnmlghbV.js";
import "../../reply-prefix-DK2AzWrE.js";
import "../../manager-B8LQNjGO.js";
import "../../gemini-auth-BoOrasN3.js";
import "../../fetch-guard-2JREkJbB.js";
import "../../query-expansion-DuzwZ9c2.js";
import "../../retry-BL5RYsiN.js";
import "../../target-errors-DBatBG-G.js";
import "../../chunk-BhlcoTjA.js";
import "../../markdown-tables-CNQyTFcB.js";
import "../../local-roots-BetgXXEI.js";
import "../../ir-Ba_n_pb3.js";
import "../../render-loap2gRq.js";
import "../../commands-registry-BddqMTS2.js";
import "../../skill-commands-B6v3y3OE.js";
import "../../runner-BE6_rpZS.js";
import "../../fetch-B1nZSYJF.js";
import "../../channel-activity-D4_nz4fl.js";
import "../../tables-Brdg2O2u.js";
import "../../send-BUlQysvB.js";
import "../../outbound-attachment-Ccxd6mWr.js";
import "../../send-Dn1Z_z9F.js";
import "../../resolve-route-CYiczLHJ.js";
import "../../proxy-Bee2aKQk.js";
import "../../replies-BCK-SYzD.js";
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
			deliver: false
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