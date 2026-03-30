import { a as resolveAgentEffectiveModelPrimary, c as resolveDefaultAgentId, i as resolveAgentDir, s as resolveAgentWorkspaceDir } from "./agent-scope-ET3-KDD1.js";
import "./paths-MYHBPf85.js";
import { t as createSubsystemLogger } from "./subsystem-CYLd4dcj.js";
import "./workspace-PvhqUv3h.js";
import { bn as DEFAULT_PROVIDER, l as parseModelRef, yn as DEFAULT_MODEL } from "./model-selection-DOYvU3hc.js";
import "./github-copilot-token-DyM1y5Pr.js";
import "./env-DioSf1y0.js";
import "./boolean-Ce2-qkSB.js";
import "./dock-B066-9Rj.js";
import "./tokens-BbMquAae.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-vtzKgCPR.js";
import "./plugins-DUx2IkaN.js";
import "./accounts-4SEfqy3O.js";
import "./bindings-TAejNrPZ.js";
import "./send-CuT_IAxo.js";
import "./send-Daa6sK7I.js";
import "./deliver-BSV7SUGt.js";
import "./diagnostic-D9vs_fb5.js";
import "./diagnostic-session-state-_tGY1a3B.js";
import "./accounts-DhD7OMBH.js";
import "./send-DZkT7Lin.js";
import "./image-ops-D98Q4dLq.js";
import "./pi-model-discovery-B1pl3ZAU.js";
import "./message-channel-rHdyUBOJ.js";
import "./pi-embedded-helpers-DLdc_PG7.js";
import "./chrome-DNpJVmqn.js";
import "./ssrf-GR1wTjsC.js";
import "./frontmatter-CthhXKqf.js";
import "./skills-D8Wcotgx.js";
import "./path-alias-guards-Ck6h4R-2.js";
import "./redact-BsXsyykh.js";
import "./errors-kKzMhHcT.js";
import "./fs-safe-D8h6zmZn.js";
import "./store-BPoOdDyW.js";
import "./sessions-BLHmBFe6.js";
import "./accounts-CpA_IJ0G.js";
import "./paths-6XrpQmMB.js";
import "./tool-images-C4bZaIjc.js";
import "./thinking-CJoHneR6.js";
import "./image-DnmlghbV.js";
import "./reply-prefix-DK2AzWrE.js";
import "./manager-B8LQNjGO.js";
import "./gemini-auth-BoOrasN3.js";
import "./fetch-guard-2JREkJbB.js";
import "./query-expansion-DuzwZ9c2.js";
import "./retry-BL5RYsiN.js";
import "./target-errors-DBatBG-G.js";
import "./chunk-BhlcoTjA.js";
import "./markdown-tables-CNQyTFcB.js";
import "./local-roots-BetgXXEI.js";
import "./ir-Ba_n_pb3.js";
import "./render-loap2gRq.js";
import "./commands-registry-BddqMTS2.js";
import "./skill-commands-B6v3y3OE.js";
import "./runner-BE6_rpZS.js";
import "./fetch-B1nZSYJF.js";
import "./channel-activity-D4_nz4fl.js";
import "./tables-Brdg2O2u.js";
import "./send-BUlQysvB.js";
import "./outbound-attachment-Ccxd6mWr.js";
import "./send-Dn1Z_z9F.js";
import "./resolve-route-CYiczLHJ.js";
import "./proxy-Bee2aKQk.js";
import "./replies-BCK-SYzD.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

//#region src/hooks/llm-slug-generator.ts
/**
* LLM-based slug generator for session memory filenames
*/
const log = createSubsystemLogger("llm-slug-generator");
/**
* Generate a short 1-2 word filename slug from session content using LLM
*/
async function generateSlugViaLLM(params) {
	let tempSessionFile = null;
	try {
		const agentId = resolveDefaultAgentId(params.cfg);
		const workspaceDir = resolveAgentWorkspaceDir(params.cfg, agentId);
		const agentDir = resolveAgentDir(params.cfg, agentId);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-slug-"));
		tempSessionFile = path.join(tempDir, "session.jsonl");
		const prompt = `Based on this conversation, generate a short 1-2 word filename slug (lowercase, hyphen-separated, no file extension).

Conversation summary:
${params.sessionContent.slice(0, 2e3)}

Reply with ONLY the slug, nothing else. Examples: "vendor-pitch", "api-design", "bug-fix"`;
		const modelRef = resolveAgentEffectiveModelPrimary(params.cfg, agentId);
		const parsed = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;
		const provider = parsed?.provider ?? DEFAULT_PROVIDER;
		const model = parsed?.model ?? DEFAULT_MODEL;
		const result = await runEmbeddedPiAgent({
			sessionId: `slug-generator-${Date.now()}`,
			sessionKey: "temp:slug-generator",
			agentId,
			sessionFile: tempSessionFile,
			workspaceDir,
			agentDir,
			config: params.cfg,
			prompt,
			provider,
			model,
			timeoutMs: 15e3,
			runId: `slug-gen-${Date.now()}`
		});
		if (result.payloads && result.payloads.length > 0) {
			const text = result.payloads[0]?.text;
			if (text) return text.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || null;
		}
		return null;
	} catch (err) {
		const message = err instanceof Error ? err.stack ?? err.message : String(err);
		log.error(`Failed to generate slug: ${message}`);
		return null;
	} finally {
		if (tempSessionFile) try {
			await fs.rm(path.dirname(tempSessionFile), {
				recursive: true,
				force: true
			});
		} catch {}
	}
}

//#endregion
export { generateSlugViaLLM };