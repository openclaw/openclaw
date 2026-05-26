import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir, c as resolveDefaultAgentId, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-P-81eBKx.js";
import { r as resolveAgentTimeoutMs } from "./task-completion-contract-D5t-_eBh.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-CsSFzly6.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
//#region src/hooks/llm-slug-generator.ts
/**
* LLM-based slug generator for session memory filenames
*/
const log = createSubsystemLogger("llm-slug-generator");
const DEFAULT_SLUG_GENERATOR_TIMEOUT_MS = 15e3;
function resolveSlugGeneratorTimeoutMs(cfg) {
	const configuredTimeoutSeconds = cfg.agents?.defaults?.timeoutSeconds;
	if (typeof configuredTimeoutSeconds !== "number" || !Number.isFinite(configuredTimeoutSeconds)) return DEFAULT_SLUG_GENERATOR_TIMEOUT_MS;
	return resolveAgentTimeoutMs({ cfg });
}
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
		const { provider, model } = resolveDefaultModelForAgent({
			cfg: params.cfg,
			agentId
		});
		const timeoutMs = resolveSlugGeneratorTimeoutMs(params.cfg);
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
			timeoutMs,
			runId: `slug-gen-${Date.now()}`,
			cleanupBundleMcpOnRunEnd: true
		});
		if (result.payloads && result.payloads.length > 0) {
			const text = result.payloads[0]?.text;
			if (text) return normalizeLowercaseStringOrEmpty(text).replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || null;
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
export { generateSlugViaLLM as t };
