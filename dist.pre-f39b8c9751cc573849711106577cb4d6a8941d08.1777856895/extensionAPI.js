import { b as resolveAgentDir, x as resolveAgentWorkspaceDir } from "./agent-scope-CzfWAE9r.js";
import { n as DEFAULT_MODEL, r as DEFAULT_PROVIDER } from "./defaults-DNihGLJv.js";
import { i as resolveSessionFilePath, u as resolveStorePath } from "./paths-CJq5T6t4.js";
import { t as loadSessionStore } from "./store-load-CPVa0fsE.js";
import { i as saveSessionStore, o as updateSessionStore, s as updateSessionStoreEntry } from "./store-C0WV070A.js";
import "./sessions-hf7PWp-q.js";
import { p as resolveThinkingDefault } from "./model-selection-DqTgZ6sy.js";
import { l as ensureAgentWorkspace } from "./workspace-CE_ex45Q.js";
import { n as resolveAgentIdentity } from "./identity-lKkG3jFv.js";
import { t as resolveAgentTimeoutMs } from "./timeout-DKjAmbgL.js";
import { t as runEmbeddedPiAgent } from "./pi-embedded-mz3aqRri.js";
//#region src/extensionAPI.ts
if (process.env.VITEST !== "true" && process.env.OPENCLAW_SUPPRESS_EXTENSION_API_WARNING !== "1") process.emitWarning("openclaw/extension-api is deprecated. Migrate to api.runtime.agent.* or focused openclaw/plugin-sdk/<subpath> imports. See https://docs.openclaw.ai/plugins/sdk-migration", {
	code: "OPENCLAW_EXTENSION_API_DEPRECATED",
	detail: "This compatibility bridge is temporary. Bundled plugins should use the injected plugin runtime instead of importing host-side agent helpers directly. Migration guide: https://docs.openclaw.ai/plugins/sdk-migration"
});
//#endregion
export { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureAgentWorkspace, loadSessionStore, resolveAgentDir, resolveAgentIdentity, resolveAgentTimeoutMs, resolveAgentWorkspaceDir, resolveSessionFilePath, resolveStorePath, resolveThinkingDefault, runEmbeddedPiAgent, saveSessionStore, updateSessionStore, updateSessionStoreEntry };
