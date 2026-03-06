import { a as resolveAgentDir, c as resolveAgentWorkspaceDir, l as resolveDefaultAgentId, o as resolveAgentEffectiveModelPrimary } from "./run-with-concurrency-CVkEQ26G.js";
import "./paths-Cvc9EM8Y.js";
import { t as createSubsystemLogger } from "./subsystem-B9UBebHR.js";
import "./workspace-CJSTaOJf.js";
import "./logger-5RiupzZ_.js";
import { Sr as DEFAULT_PROVIDER, l as parseModelRef, xr as DEFAULT_MODEL } from "./model-selection-hBypV7rn.js";
import "./github-copilot-token-BDioPmd6.js";
import "./legacy-names-CdhkiTCG.js";
import "./thinking-BTmZIepL.js";
import "./tokens-DeKjMaTx.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-B567dzV4.js";
import "./plugins-DjZ0CVDU.js";
import "./accounts-DdJPFalP.js";
import "./send-RyhwGcIc.js";
import "./send-CDteNscd.js";
import "./deliver-BeGyllUh.js";
import "./diagnostic-Baty9xY_.js";
import "./accounts-CZzda7Dm.js";
import "./image-ops-DTr9Cxst.js";
import "./send-D3e7eeGG.js";
import "./pi-model-discovery-C_D0uDwt.js";
import "./pi-embedded-helpers-BqdZ2WJ4.js";
import "./chrome-Dr7FDJN9.js";
import "./frontmatter-DdUAZ1DV.js";
import "./skills-C97Yv--s.js";
import "./path-alias-guards-Tm_5BzS2.js";
import "./redact-BkJnViY6.js";
import "./errors-XoYNBNa9.js";
import "./fs-safe-54mRDvhR.js";
import "./proxy-env-8K0ubHqJ.js";
import "./store-B4Adu_41.js";
import "./accounts--DUgGZBF.js";
import "./paths-C47m6bhv.js";
import "./tool-images-DR3jtxfE.js";
import "./image-ByJbTOAc.js";
import "./audio-transcription-runner-DgL0NvDd.js";
import "./fetch-BchUD2xl.js";
import "./fetch-guard-DoTHIOVQ.js";
import "./api-key-rotation-BdB4aSfv.js";
import "./proxy-fetch-Bc_b6yL6.js";
import "./ir-CVwrRj_q.js";
import "./render-DW7AcFdD.js";
import "./target-errors-DcPo64JL.js";
import "./commands-registry-CIs77ZVZ.js";
import "./skill-commands-D-_ZmD4H.js";
import "./fetch-BfuG8uZ8.js";
import "./channel-activity-CpiWAbS4.js";
import "./tables-DdpYLMEi.js";
import "./send-BC2a3seQ.js";
import "./outbound-attachment-Cub4BROY.js";
import "./send-E9xIAeAw.js";
import "./proxy-CecQTx_Z.js";
import "./manager-BnW9YPmf.js";
import "./query-expansion-D15-YN6n.js";
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