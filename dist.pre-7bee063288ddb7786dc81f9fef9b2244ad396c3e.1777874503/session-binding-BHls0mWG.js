import { t as log } from "./logger-88Co-Zqv.js";
import "./agent-harness-runtime-DOgzksEr.js";
import fs from "node:fs/promises";
//#region extensions/codex/src/app-server/session-binding.ts
function resolveCodexAppServerBindingPath(sessionFile) {
	return `${sessionFile}.codex-app-server.json`;
}
async function readCodexAppServerBinding(sessionFile) {
	const path = resolveCodexAppServerBindingPath(sessionFile);
	let raw;
	try {
		raw = await fs.readFile(path, "utf8");
	} catch (error) {
		if (isNotFound(error)) return;
		log.warn("failed to read codex app-server binding", {
			path,
			error
		});
		return;
	}
	try {
		const parsed = JSON.parse(raw);
		if (parsed.schemaVersion !== 1 || typeof parsed.threadId !== "string") return;
		return {
			schemaVersion: 1,
			threadId: parsed.threadId,
			sessionFile,
			cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
			authProfileId: typeof parsed.authProfileId === "string" ? parsed.authProfileId : void 0,
			model: typeof parsed.model === "string" ? parsed.model : void 0,
			modelProvider: typeof parsed.modelProvider === "string" ? parsed.modelProvider : void 0,
			approvalPolicy: readApprovalPolicy(parsed.approvalPolicy),
			sandbox: readSandboxMode(parsed.sandbox),
			serviceTier: readServiceTier(parsed.serviceTier),
			dynamicToolsFingerprint: typeof parsed.dynamicToolsFingerprint === "string" ? parsed.dynamicToolsFingerprint : void 0,
			createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : (/* @__PURE__ */ new Date()).toISOString(),
			updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : (/* @__PURE__ */ new Date()).toISOString()
		};
	} catch (error) {
		log.warn("failed to parse codex app-server binding", {
			path,
			error
		});
		return;
	}
}
async function writeCodexAppServerBinding(sessionFile, binding) {
	const now = (/* @__PURE__ */ new Date()).toISOString();
	const payload = {
		schemaVersion: 1,
		sessionFile,
		threadId: binding.threadId,
		cwd: binding.cwd,
		authProfileId: binding.authProfileId,
		model: binding.model,
		modelProvider: binding.modelProvider,
		approvalPolicy: binding.approvalPolicy,
		sandbox: binding.sandbox,
		serviceTier: binding.serviceTier,
		dynamicToolsFingerprint: binding.dynamicToolsFingerprint,
		createdAt: binding.createdAt ?? now,
		updatedAt: now
	};
	await fs.writeFile(resolveCodexAppServerBindingPath(sessionFile), `${JSON.stringify(payload, null, 2)}\n`);
}
async function clearCodexAppServerBinding(sessionFile) {
	try {
		await fs.unlink(resolveCodexAppServerBindingPath(sessionFile));
	} catch (error) {
		if (!isNotFound(error)) log.warn("failed to clear codex app-server binding", {
			sessionFile,
			error
		});
	}
}
function isNotFound(error) {
	return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
function readApprovalPolicy(value) {
	return value === "never" || value === "on-request" || value === "on-failure" || value === "untrusted" ? value : void 0;
}
function readSandboxMode(value) {
	return value === "read-only" || value === "workspace-write" || value === "danger-full-access" ? value : void 0;
}
function readServiceTier(value) {
	return value === "fast" || value === "flex" ? value : void 0;
}
//#endregion
export { writeCodexAppServerBinding as i, readCodexAppServerBinding as n, resolveCodexAppServerBindingPath as r, clearCodexAppServerBinding as t };
