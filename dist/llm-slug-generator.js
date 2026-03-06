import { a as resolveAgentDir, c as resolveAgentWorkspaceDir, l as resolveDefaultAgentId, o as resolveAgentEffectiveModelPrimary } from "./run-with-concurrency-CtAWceEI.js";
import "./paths-C6TxBCvO.js";
import { t as createSubsystemLogger } from "./subsystem-BRgnv2j0.js";
import "./workspace-buUezKOj.js";
import "./logger-2lihXGmH.js";
import { Sr as DEFAULT_PROVIDER, l as parseModelRef, xr as DEFAULT_MODEL } from "./model-selection-D-zc9Jb3.js";
import "./github-copilot-token-D13V9YBz.js";
import "./legacy-names-UtW-25Fu.js";
import "./thinking-B9zygAE1.js";
import "./tokens-ulWOhTB_.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CiZN08Fp.js";
import "./plugins-DtC13lY-.js";
import "./accounts-Dnv03KpM.js";
import "./send-DjVh-klA.js";
import "./send-DkczGQX3.js";
import "./deliver-CQ9-zCpc.js";
import "./diagnostic-BPd4hFcV.js";
import "./accounts-B-E364-r.js";
import "./image-ops-Dz6A36dh.js";
import "./send-Dl8h3oYL.js";
import "./pi-model-discovery-DKruCPPd.js";
import "./pi-embedded-helpers-DGdW7_Fe.js";
import "./chrome-e90mQRbq.js";
import "./frontmatter-B1YIuX78.js";
import "./skills-CuGToNMJ.js";
import "./path-alias-guards-nJ8fVkuc.js";
import "./redact-DYOZyabt.js";
import "./errors-DBMuZkJB.js";
import "./fs-safe-BPM-Flk7.js";
import "./proxy-env-CSux5Cdw.js";
import "./store-CI07lZq8.js";
import "./accounts-BL5AKl_m.js";
import "./paths-CJ8i-g5g.js";
import "./tool-images-CSCGkO_H.js";
import "./image-Bb5_JgpF.js";
import "./audio-transcription-runner-BoGCvMW5.js";
import "./fetch-CEjS-VCv.js";
import "./fetch-guard-Chzxbsnj.js";
import "./api-key-rotation-B68-9R33.js";
import "./proxy-fetch-DYLFpQUa.js";
import "./ir-D64qhrtw.js";
import "./render-DW7AcFdD.js";
import "./target-errors-Lma0LQWV.js";
import "./commands-registry-C9NczzrR.js";
import "./skill-commands-D0lEmwsk.js";
import "./fetch-BfuG8uZ8.js";
import "./channel-activity-DLxao_EN.js";
import "./tables-DSjZGP2W.js";
import "./send-DFfSjWRX.js";
import "./outbound-attachment-DcUxo2V-.js";
import "./send-DlFNJIFG.js";
import "./proxy-CecQTx_Z.js";
import "./manager-CXp6sjxX.js";
import "./query-expansion-BK8EIY3r.js";
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