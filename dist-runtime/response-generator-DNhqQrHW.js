import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
//#region extensions/voice-call/src/core-bridge.ts
let coreRootCache = null;
let coreDepsPromise = null;
function findPackageRoot(startDir, name) {
	let dir = startDir;
	for (;;) {
		const pkgPath = path.join(dir, "package.json");
		try {
			if (fs.existsSync(pkgPath)) {
				const raw = fs.readFileSync(pkgPath, "utf8");
				if (JSON.parse(raw).name === name) return dir;
			}
		} catch {}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}
function resolveOpenClawRoot() {
	if (coreRootCache) return coreRootCache;
	const override = process.env.OPENCLAW_ROOT?.trim();
	if (override) {
		coreRootCache = override;
		return override;
	}
	const candidates = /* @__PURE__ */ new Set();
	if (process.argv[1]) candidates.add(path.dirname(process.argv[1]));
	candidates.add(process.cwd());
	try {
		const urlPath = fileURLToPath(import.meta.url);
		candidates.add(path.dirname(urlPath));
	} catch {}
	for (const start of candidates) for (const name of ["openclaw"]) {
		const found = findPackageRoot(start, name);
		if (found) {
			coreRootCache = found;
			return found;
		}
	}
	throw new Error("Unable to resolve core root. Set OPENCLAW_ROOT to the package root.");
}
async function importCoreExtensionAPI() {
	const distPath = path.join(resolveOpenClawRoot(), "dist", "extensionAPI.js");
	if (!fs.existsSync(distPath)) throw new Error(`Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`);
	return await import(pathToFileURL(distPath).href);
}
async function loadCoreAgentDeps() {
	if (coreDepsPromise) return coreDepsPromise;
	coreDepsPromise = (async () => {
		return await importCoreExtensionAPI();
	})();
	return coreDepsPromise;
}
//#endregion
//#region extensions/voice-call/src/response-generator.ts
/**
* Voice call response generator - uses the embedded Pi agent for tool support.
* Routes voice responses through the same agent infrastructure as messaging.
*/
/**
* Generate a voice response using the embedded Pi agent with full tool support.
* Uses the same agent infrastructure as messaging for consistent behavior.
*/
async function generateVoiceResponse(params) {
	const { voiceConfig, callId, from, transcript, userMessage, coreConfig } = params;
	if (!coreConfig) return {
		text: null,
		error: "Core config unavailable for voice response"
	};
	let deps;
	try {
		deps = await loadCoreAgentDeps();
	} catch (err) {
		return {
			text: null,
			error: err instanceof Error ? err.message : "Unable to load core agent dependencies"
		};
	}
	const cfg = coreConfig;
	const sessionKey = `voice:${from.replace(/\D/g, "")}`;
	const agentId = "main";
	const storePath = deps.resolveStorePath(cfg.session?.store, { agentId });
	const agentDir = deps.resolveAgentDir(cfg, agentId);
	const workspaceDir = deps.resolveAgentWorkspaceDir(cfg, agentId);
	await deps.ensureAgentWorkspace({ dir: workspaceDir });
	const sessionStore = deps.loadSessionStore(storePath);
	const now = Date.now();
	let sessionEntry = sessionStore[sessionKey];
	if (!sessionEntry) {
		sessionEntry = {
			sessionId: crypto.randomUUID(),
			updatedAt: now
		};
		sessionStore[sessionKey] = sessionEntry;
		await deps.saveSessionStore(storePath, sessionStore);
	}
	const sessionId = sessionEntry.sessionId;
	const sessionFile = deps.resolveSessionFilePath(sessionId, sessionEntry, { agentId });
	const modelRef = voiceConfig.responseModel || `${deps.DEFAULT_PROVIDER}/${deps.DEFAULT_MODEL}`;
	const slashIndex = modelRef.indexOf("/");
	const provider = slashIndex === -1 ? deps.DEFAULT_PROVIDER : modelRef.slice(0, slashIndex);
	const model = slashIndex === -1 ? modelRef : modelRef.slice(slashIndex + 1);
	const thinkLevel = deps.resolveThinkingDefault({
		cfg,
		provider,
		model
	});
	const agentName = deps.resolveAgentIdentity(cfg, agentId)?.name?.trim() || "assistant";
	const basePrompt = voiceConfig.responseSystemPrompt ?? `You are ${agentName}, a helpful voice assistant on a phone call. Keep responses brief and conversational (1-2 sentences max). Be natural and friendly. The caller's phone number is ${from}. You have access to tools - use them when helpful.`;
	let extraSystemPrompt = basePrompt;
	if (transcript.length > 0) extraSystemPrompt = `${basePrompt}\n\nConversation so far:\n${transcript.map((entry) => `${entry.speaker === "bot" ? "You" : "Caller"}: ${entry.text}`).join("\n")}`;
	const timeoutMs = voiceConfig.responseTimeoutMs ?? deps.resolveAgentTimeoutMs({ cfg });
	const runId = `voice:${callId}:${Date.now()}`;
	try {
		const result = await deps.runEmbeddedPiAgent({
			sessionId,
			sessionKey,
			messageProvider: "voice",
			sessionFile,
			workspaceDir,
			config: cfg,
			prompt: userMessage,
			provider,
			model,
			thinkLevel,
			verboseLevel: "off",
			timeoutMs,
			runId,
			lane: "voice",
			extraSystemPrompt,
			agentDir
		});
		const text = (result.payloads ?? []).filter((p) => p.text && !p.isError).map((p) => p.text?.trim()).filter(Boolean).join(" ") || null;
		if (!text && result.meta?.aborted) return {
			text: null,
			error: "Response generation was aborted"
		};
		return { text };
	} catch (err) {
		console.error(`[voice-call] Response generation failed:`, err);
		return {
			text: null,
			error: String(err)
		};
	}
}
//#endregion
export { generateVoiceResponse };
