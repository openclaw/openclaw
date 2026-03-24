import "./github-copilot-token-D_-ww7kX.js";
import { Ct as resolveAgentWorkspaceDir, vt as resolveAgentDir, wt as resolveDefaultAgentId, yt as resolveAgentEffectiveModelPrimary } from "./query-expansion-CXt6YRxc.js";
import "./paths-hfkBoC7i.js";
import { t as createSubsystemLogger } from "./subsystem-2phE7Tdr.js";
import "./workspace-B3nm_eCU.js";
import "./logger-BYA-BLD7.js";
import { Oi as DEFAULT_PROVIDER, o as parseModelRef, tt as runEmbeddedPiAgent } from "./model-selection-Bzn7nqXd.js";
import "./boolean-Cuaw_-7j.js";
import "./fetch-vIL6gZu4.js";
import "./frontmatter-CEejIjxx.js";
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
		const provider = parsed?.provider ?? "anthropic";
		const model = parsed?.model ?? "claude-opus-4-6";
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
